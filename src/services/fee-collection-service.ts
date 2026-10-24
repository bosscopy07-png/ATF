/**
 * FeeCollectionService — the SINGLE place platform swap fees are collected.
 *
 * Guarantees:
 *  - Idempotent: upsert-on-swapTxId record creation + atomic status claims
 *    mean the reconciler fast path AND this sweeper can never double-send.
 *  - Claim-retryable: records in 'failed' are re-claimable on the next
 *    sweep (they used to deadlock silently because the claim filter only
 *    matched 'pending'). Uncertain records (broadcastUncertain /
 *    deliveryUncertain) are NEVER auto-requeued — double-charge guard.
 *  - Asset-aware (FIX A): TON fees via sendTon, ATF via sendJetton,
 *    generic tokens via their own master.
 *  - Delivery-verified (FIX C): a jetton fee is only 'completed' after
 *    on-chain proof the fee ARRIVED. Bounced transfers still consume the
 *    wallet seqno, which made waitForTransaction report success while the
 *    fee returned to the user. Three outcomes: delivered → completed;
 *    clearly bounced → failed + retryable; ambiguous → deliveryUncertain,
 *    NEVER auto-requeued (prevents double-charging).
 *  - Output-side TON fee (FIX D): token→TON swaps carry an additional
 *    disclosed 1% output fee — read from metadata.feePlan when present,
 *    derived from expectedOutputBaseUnits for legacy swaps.
 *  - FIX E: uses the fee-profile RPC endpoint/API key so rate limits on
 *    swap/monitor paths can't stall fee transfers.
 */
import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { WalletService } from './wallet-service';
import { config } from '../config';
import { FeeEngine } from '../config/fees';

const DELIVERY_POLL_ATTEMPTS = 20;
const DELIVERY_POLL_INTERVAL_MS = 4000;

export class FeeCollectionService {
  private walletService = new WalletService(undefined, 'fee');

  /* ─────────────────────────────────────────
     FEE RECORD
     ───────────────────────────────────────── */

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

  /* ─────────────────────────────────────────
     ASSET DISPATCH (FIX A)
     ───────────────────────────────────────── */

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
    const master = jettonMaster || config.atfJettonAddress!;
    return this.walletService.sendJetton(
      telegramId,
      config.adminFeeWalletAddress,
      master,
      amount
    );
  }

  /* ─────────────────────────────────────────
     DELIVERY VERIFICATION (FIX C)
     ───────────────────────────────────────── */

  /**
   * Poll both balances after a jetton fee broadcast:
   *
   *  DELIVERED  — admin ATF rose by ≥ ~fee AND user ATF fell by ≥ ~fee
   *  BOUNCED    — neither balance moved meaningfully (fee demonstrably
   *               returned → safe to retry)
   *  UNCERTAIN  — anything else (concurrent activity) → NEVER auto-retry
   */
  private async verifyJettonFeeDelivery(
    userWalletAddress: string,
    adminWalletAddress: string,
    feeBase: bigint,
    userAtfBefore: bigint,
    adminAtfBefore: bigint
  ): Promise<'delivered' | 'bounced' | 'uncertain'> {
    const threshold = feeBase / 2n;

    for (let i = 0; i < DELIVERY_POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, DELIVERY_POLL_INTERVAL_MS));

      try {
        const [{ atf: userAtf }, { atf: adminAtf }] = await Promise.all([
          this.walletService.getBalance(userWalletAddress),
          this.walletService.getBalance(adminWalletAddress),
        ]);

        const userDelta = userAtfBefore - userAtf;
        const adminDelta = adminAtf - adminAtfBefore;

        if (userDelta >= threshold && adminDelta >= threshold) {
          return 'delivered';
        }

        if (
          userDelta <= threshold / 2n &&
          adminDelta <= threshold / 2n &&
          i >= 2 // at least ~8s before declaring a bounce
        ) {
          return 'bounced';
        }
      } catch {
        // RPC hiccup — keep polling; unknown never reads as bounced.
      }
    }

    return 'uncertain';
  }

  /* ─────────────────────────────────────────
     MAIN COLLECTION
     ───────────────────────────────────────── */

  async collectSwapFee(
    swapId: string
  ): Promise<'collected' | 'pending' | 'skipped' | 'uncertain'> {
    const swap = await Transaction.findById(swapId);
    if (!swap || swap.type !== 'swap') return 'skipped';
    if (swap.status !== 'completed') return 'skipped';
    if (swap.feeStatus === 'completed') return 'skipped';

    const user = await User.findById(swap.userId);
    if (!user) return 'skipped';

    // No primary fee — still attempt the disclosed token→TON output fee.
    if (BigInt(swap.fee || '0') <= 0n) {
      await this.collectTonOutputFee(swap, user.telegramId).catch(() => {});
      return 'skipped';
    }

    const feeTxId = await this.ensureFeeRecord(swap);

    /**
     * Atomic claim. CRITICAL FIX: the claim matches BOTH 'pending' and
     * 'failed' — a record that failed its send must be retryable on the
     * next sweep, otherwise the sweeper deadlocks silently at
     * "scanned=N collected=0" forever. Uncertain records (never safe to
     * auto-retry) are excluded by the $ne guards, preserving the
     * double-charge protection.
     */
    const feeTx = await Transaction.findOneAndUpdate(
      {
        _id: feeTxId,
        status: { $in: ['pending', 'failed'] },
        'metadata.deliveryUncertain': { $ne: true },
        'metadata.broadcastUncertain': { $ne: true },
      },
      { $set: { status: 'processing' } },
      { new: true }
    );
    if (!feeTx) return 'pending'; // claimed elsewhere, settled, or uncertain

    const feeAsset = feeTx.asset || swap.feeAsset || swap.asset;
    const feeAmount = BigInt(feeTx.amount);
    const meta = (swap.metadata || {}) as any;
    const userWalletAddress: string =
      meta.walletAddress ||
      (await this.walletService.getAddress(user.telegramId))!;

    // Pre-send snapshots for delivery verification (jetton fees only).
    let userAtfBefore = 0n;
    let adminAtfBefore = 0n;
    let needsDeliveryCheck = feeAsset !== 'TON';
    if (needsDeliveryCheck) {
      try {
        const [u, a] = await Promise.all([
          this.walletService.getBalance(userWalletAddress),
          this.walletService.getBalance(config.adminFeeWalletAddress),
        ]);
        userAtfBefore = u.atf;
        adminAtfBefore = a.atf;
      } catch {
        // Snapshot failure: proceed unverified rather than block collection.
        needsDeliveryCheck = false;
      }
    }

    try {
      const txHash = await this.sendFeeAsset(
        user.telegramId,
        feeAsset,
        feeAmount,
        meta.tokenMaster
      );

      /* ── FIX C: prove delivery before declaring success ── */
      if (needsDeliveryCheck) {
        const outcome = await this.verifyJettonFeeDelivery(
          userWalletAddress,
          config.adminFeeWalletAddress,
          feeAmount,
          userAtfBefore,
          adminAtfBefore
        );

        if (outcome === 'bounced') {
          // Jettons demonstrably returned — safe to let the sweeper retry.
          await Transaction.updateOne(
            { _id: feeTx._id },
            {
              $set: {
                status: 'failed',
                txHash,
                'metadata.bounced': true,
                'metadata.error':
                  'fee transfer bounced back (destination not deliverable)',
              },
              $inc: { 'metadata.feeRetryCount': 1 },
            }
          );
          await Transaction.updateOne(
            { _id: swap._id },
            { $set: { feeStatus: 'pending' }, $unset: { feeTxHash: '' } }
          );
          return 'pending';
        }

        if (outcome === 'uncertain') {
          // NEVER auto-requeue — a retry here could double-charge.
          await Transaction.updateOne(
            { _id: feeTx._id },
            {
              $set: {
                status: 'failed',
                txHash,
                'metadata.deliveryUncertain': true,
                'metadata.error':
                  'fee delivery unconfirmed — manual verification required',
              },
            }
          );
          await Transaction.updateOne(
            { _id: swap._id },
            { $set: { feeStatus: 'failed' } }
          );
          return 'uncertain';
        }
      }

      await Transaction.updateOne(
        { _id: feeTx._id },
        { $set: { status: 'completed', txHash } }
      );
      await Transaction.updateOne(
        { _id: swap._id },
        { $set: { feeStatus: 'completed', feeTxHash: txHash } }
      );

      console.log(
        `[FeeCollector] Platform fee DELIVERED for swap ${swapId}: ${feeTx.amount} ${feeAsset} (${txHash})`
      );

      /* ── FIX D: disclosed token→TON output fee (1% default) ── */
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
            ...(broadcastUncertain
              ? { 'metadata.broadcastUncertain': true }
              : {}),
          },
          $inc: { 'metadata.feeRetryCount': 1 },
        }
      );

      console.error(`[FeeCollector] Fee transfer failed for swap ${swapId}:`, msg);
      return broadcastUncertain ? 'uncertain' : 'pending';
    }
  }

  /* ─────────────────────────────────────────
     TOKEN→TON OUTPUT FEE (FIX D)
     ───────────────────────────────────────── */

  /**
   * Collect the disclosed token→TON extra output fee (1% default).
   * Sources the amount from metadata.feePlan when present; for LEGACY
   * swaps (no feePlan) derives it from metadata.expectedOutputBaseUnits
   * — which legacy ATF→TON swaps always record.
   */
  private async collectTonOutputFee(swap: any, telegramId: number): Promise<void> {
    const meta = (swap.metadata || {}) as any;

    const isTokenToTon =
      meta.swapDirection === 'atf_to_ton' ||
      meta.feePlan?.kind === 'token_to_ton';
    if (!isTokenToTon) return;

    if (meta.tonOutputFeeCollected) return;

    let tonFeeBase: bigint;
    if (meta.feePlan?.tonOutputFeeBase) {
      tonFeeBase = BigInt(meta.feePlan.tonOutputFeeBase);
    } else {
      const grossOut = BigInt(meta.expectedOutputBaseUnits || '0');
      if (grossOut <= 0n) return;
      tonFeeBase = FeeEngine.percentOf(
        grossOut,
        config.feePolicy.tokenToTonOutputPercent
      );
    }

    if (tonFeeBase <= 0n) return;

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
        tonFeeBase
      );
      await Transaction.create({
        userId: swap.userId,
        type: 'fee',
        asset: 'TON',
        amount: tonFeeBase.toString(),
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

  /* ─────────────────────────────────────────
     SWEEPER
     ───────────────────────────────────────── */

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

      if (meta.feeTxId) {
        const feeTx = await Transaction.findById(meta.feeTxId).lean();
        // Never auto-requeue uncertain rows (double-charge protection).
        if (feeTx?.metadata?.broadcastUncertain) continue;
        if (feeTx?.metadata?.deliveryUncertain) continue;
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
  
