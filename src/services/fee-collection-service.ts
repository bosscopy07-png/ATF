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
 *  - Asset-aware (FIX A): the fee is sent in the asset the swap actually
 *    recorded (TON fees via sendTon, ATF via sendJetton, generic tokens
 *    via their own master). Previously every fee was sent as ATF, so
 *    TON→ATF platform fees (denominated in TON) could never be collected.
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
          // FIX A: record the fee in the asset it is actually charged in.
          asset: swap.feeAsset || swap.asset,
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
   * Send `amount` of `asset` from the user's wallet to the admin fee
   * wallet. FIX A: dispatches on the recorded fee asset instead of always
   * sending ATF. Mirrors SwapService.transferFee's original dispatch.
   */
  private async sendFeeAsset(
    telegramId: number,
    asset: string,
    amount: bigint,
    jettonMaster?: string
  ): Promise<string> {
    if (asset === 'TON') {
      return this.walletService.sendTon(
        telegramId,
        config.adminFeeWalletAddress,
        amount
      );
    }
    if (asset === 'ATF') {
      return this.walletService.sendJetton(
        telegramId,
        config.adminFeeWalletAddress,
        config.atfJettonAddress!,
        amount
      );
    }
    // Generic token fee: send the token itself from the swap's input master.
    const master = jettonMaster || config.atfJettonAddress!;
    return this.walletService.sendJetton(
      telegramId,
      config.adminFeeWalletAddress,
      master,
      amount
    );
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
      const txHash = await this.sendFeeAsset(
        user.telegramId,
        feeTx.asset || swap.feeAsset || swap.asset,
        BigInt(feeTx.amount),
        (swap.metadata as any)?.tokenMaster
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

      // FIX A (secondary): token→TON swaps carry an additional disclosed
      // output-side TON fee (tokenToTonOutputPercent) that lives only in
      // metadata.feePlan. Collect it exactly once, guarded by a metadata flag.
      await this.collectTonOutputFee(swap, user.telegramId);

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
   * Collect the disclosed token→TON extra output fee (1% default) once.
   * No-op for other directions, missing plans, or already-collected fees.
   */
  private async collectTonOutputFee(swap: any, telegramId: number): Promise<void> {
    const meta = (swap.metadata || {}) as any;
    if (meta.swapDirection !== 'atf_to_ton' && meta.feePlan?.kind !== 'token_to_ton') {
      return;
    }
    if (meta.tonOutputFeeCollected) return;

    const tonFee = BigInt(meta.feePlan?.tonOutputFeeBase || '0');
    if (tonFee <= 0n) return;

    // Atomic claim — concurrent sweeps/reconciler can never double-send.
    const claimed = await Transaction.findOneAndUpdate(
      { _id: swap._id, 'metadata.tonOutputFeeCollected': { $ne: true } },
      { $set: { 'metadata.tonOutputFeeCollected': true } }
    );
    if (!claimed) return;

    try {
      const txHash = await this.walletService.sendTon(
        telegramId,
        config.adminFeeWalletAddress,
        tonFee
      );
      await Transaction.create({
        userId: swap.userId,
        type: 'fee',
        asset: 'TON',
        amount: tonFee.toString(),
        feePercentage: config.feePolicy.tokenToTonOutputPercent,
        feeWallet: config.adminFeeWalletAddress,
        status: 'completed',
        toAddress: config.adminFeeWalletAddress,
        txHash,
        metadata: {
          swapTxId: swap._id.toString(),
          feeKind: 'swap_ton_output_fee',
        },
      });
    } catch (err: any) {
      // Roll the claim back so a later sweep can retry (idempotent).
      await Transaction.updateOne(
        { _id: swap._id },
        { $set: { 'metadata.tonOutputFeeCollected': false } }
      );
      throw err;
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
        
