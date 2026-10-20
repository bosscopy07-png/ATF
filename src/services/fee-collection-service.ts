/**
 * FeeCollectionService — the SINGLE place platform swap fees are collected.
 *
 * Why this exists: fee collection used to live inside the reconciler's
 * finalize path (post-commit closure). Any failure in that chain meant no
 * fee record, no fee — silently. This service owns the whole lifecycle and
 * also runs an independent sweeper, so fees are collected even if the
 * reconciler's fast path never fires.
 *
 * Guarantees:
 *  - Idempotent: upsert-on-swapTxId record creation + status claims mean
 *    the reconciler fast path AND this sweeper can never double-send.
 *  - Broadcast-safe: timeout-class failures are flagged broadcastUncertain
 *    and NEVER auto-requeued (avoids charging the user twice).
 *  - Direction-aware: only collects when the swap actually completed.
 */
import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { WalletService } from './wallet-service';
import { config } from '../config';

export class FeeCollectionService {
  private walletService = new WalletService();

  /**
   * Idempotently ensure a fee record exists for a completed swap.
   * Returns the fee record ID.
   */
  private async ensureFeeRecord(swap: any): Promise<string> {
    const swapId = swap._id.toString();
    const meta = (swap.metadata || {}) as any;

    if (meta.feeTxId) return meta.feeTxId as string;

    const feeRecord = await Transaction.findOneAndUpdate(
      { type: 'fee', 'metadata.swapTxId': swapId },
      {
        $setOnInsert: {
          userId: swap.userId,
          type: 'fee',
          asset: swap.asset,
          amount: swap.fee || '0',
          feePercentage: swap.feePercentage,
          feeWallet: config.adminFeeWalletAddress,
          status: 'pending',
          toAddress: config.adminFeeWalletAddress,
          txHash: `fee-pending-${swapId}`,
          metadata: { swapTxId: swapId, feeKind: 'swap_platform_fee' },
        },
      },
      { upsert: true, new: true }
    );

    if (!meta.feeTxId) {
      await Transaction.updateOne(
        { _id: swap._id },
        {
          $set: {
            feeStatus: 'pending',
            'metadata.feeTxId': feeRecord._id.toString(),
          },
        }
      );
    }

    return feeRecord._id.toString();
  }

  /**
   * Collect the platform fee for ONE completed swap.
   * Claim-protected; safe to call from multiple places concurrently.
   */
  async collectSwapFee(
    swapId: string
  ): Promise<'collected' | 'pending' | 'skipped' | 'uncertain'> {
    const swap = await Transaction.findById(swapId);
    if (!swap || swap.type !== 'swap') return 'skipped';
    if (swap.status !== 'completed') return 'skipped';
    if (swap.feeStatus === 'completed') return 'skipped';
    if (BigInt(swap.fee || '0') <= 0n) return 'skipped';

    const feeTxId = await this.ensureFeeRecord(swap);

    const feeTx = await Transaction.findOneAndUpdate(
      { _id: feeTxId, status: 'pending' },
      { $set: { status: 'processing' } },
      { new: true }
    );
    if (!feeTx) return 'pending'; // claimed elsewhere or already settled

    const user = await User.findById(swap.userId);
    if (!user) return 'skipped';

    try {
      const txHash = await this.walletService.sendJetton(
        user.telegramId,
        config.adminFeeWalletAddress,
        config.atfJettonAddress!,
        BigInt(feeTx.amount)
      );

      await Transaction.updateOne(
        { _id: feeTx._id },
        { $set: { status: 'completed', txHash } }
      );
      await Transaction.updateOne(
        { _id: swap._id },
        { $set: { feeStatus: 'completed', feeTxHash: txHash } }
      );

      console.log(
        `[FeeCollector] Platform fee sent for swap ${swapId}: ${feeTx.amount} ${feeTx.asset} (${txHash})`
      );
      return 'collected';
    } catch (error: any) {
      const msg = error?.message || String(error);
      const broadcastUncertain =
        /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|aborted|socket/i.test(msg);

      await Transaction.updateOne(
        { _id: feeTx._id },
        {
          $set: {
            status: 'failed',
            'metadata.error': msg,
            ...(broadcastUncertain ? { 'metadata.broadcastUncertain': true } : {}),
          },
          $inc: { 'metadata.feeRetryCount': 1 },
        }
      );

      console.error(`[FeeCollector] Fee transfer failed for swap ${swapId}:`, msg);
      return broadcastUncertain ? 'uncertain' : 'pending';
    }
  }

  /**
   * Sweeper: every tick, collect fees for all completed swaps whose fee
   * never settled. This is the safety net that runs independently of the
   * reconciler's finalize path.
   */
  async sweepDueFees(): Promise<{ scanned: number; collected: number }> {
    const swaps = await Transaction.find({
      type: 'swap',
      status: 'completed',
      feeStatus: { $in: ['pending', 'processing', 'failed'] },
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    })
      .sort({ createdAt: 1 })
      .limit(50)
      .lean();

    let collected = 0;

    for (const swap of swaps) {
      const meta = (swap.metadata || {}) as any;

      // Respect the broadcast-uncertain flag — never auto-requeue those.
      if (meta.feeTxId) {
        const feeTx = await Transaction.findById(meta.feeTxId).lean();
        if (feeTx?.metadata?.broadcastUncertain) continue;
        if (feeTx && (feeTx.status === 'completed' || feeTx.txHash)) continue;
        if (feeTx && feeTx.status === 'processing') continue; // claimed, in flight
      }

      const result = await this.collectSwapFee(swap._id.toString());
      if (result === 'collected') collected++;
    }

    return { scanned: swaps.length, collected };
  }
}

/* ─── Sweeper job (registered in app.ts, BOTH server and worker mode) ─── */

export class FeeCollectorJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly service = new FeeCollectionService();

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 30_000);
    console.log('[FeeCollector] started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { scanned, collected } = await this.service.sweepDueFees();
      if (scanned > 0) {
        console.log(`[FeeCollector] scanned=${scanned} collected=${collected}`);
      }
    } catch (err) {
      console.error('[FeeCollector] tick error:', err);
    } finally {
      this.running = false;
    }
  }
}
