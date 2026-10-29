import mongoose, { ClientSession } from 'mongoose';
import { TonClient, Address } from '@ton/ton';
import { Transaction, TransactionStatus, TransactionType } from '../models/Transaction';
import { User } from '../models/User';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS, ATF_DECIMALS } from '../config';
import { WalletService } from '../services/wallet-service';
import { GasRecoveryService } from '../services/gas-recovery-service';
import {
  txTotalFeesNano,
  txOutMessageCount,
  evaluateAtfToTonOutput,
  WalletTxEvidence,
} from '../services/swap-output-policy';

/**
 * FIX A: platform-internal senders (admin treasury, admin fee wallet)
 * are never deposit sources. Mirrors blockchain-monitor's guard so
 * pre-fix deposit records are absorbed without crediting.
 */
function isInternalSender(address: string): boolean {
  const internal = [
    config.adminFeeWalletAddress,
    (config as any).adminWalletAddress,
  ]
    .filter(Boolean)
    .map((a) =>
      Address.parse(a as string).toString({ bounceable: false })
    );

  try {
    return internal.includes(
      Address.parse(address).toString({ bounceable: false })
    );
  } catch {
    return false;
  }
}


const RECONCILE_INTERVAL_MS = 10_000; // was 30s: swaps settle ~10s after broadcast

// Reconciliation must never abandon a swap by age while it is still
// pending/processing — a stranded swap meant a stranded platform fee.
// Age-based FAILURE decisions live in detectSwapOutput (90s output
// timeout) and handleSwapError instead. This is only a query safety
// bound for the auxiliary sweeps (withdrawals/deposits/fee transfers).
const MAX_CONFIRMATION_WAIT_MS = 86_400_000; // 24h

const BATCH_SIZE = 50;
const RPC_RETRY_ATTEMPTS = 3;
const RPC_RETRY_DELAY_MS = 1_000;

// ─── Utilities ─────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface ReconcileMetrics {
  processed: number;
  confirmed: number;
  failed: number;
  feesRecovered: number;
  skipped: number;
}

interface SwapMetadata {
  swapDirection: 'ton_to_atf' | 'atf_to_ton';
  expectedOutput?: string;
  gasTon?: string;
  [key: string]: unknown;
}

type VerificationResult = 'confirmed' | 'failed' | 'pending';

// ─── Errors ────────────────────────────────────────────────────────────────

class ReconcileError extends Error {
  constructor(
    message: string,
    public readonly code: 'RPC_ERROR' | 'TIMEOUT' | 'ROLLBACK_FAILED' | 'INVALID_STATE',
    public readonly recoverable: boolean
  ) {
    super(message);
  }
}

// ─── On-Chain Verifier (with retries & circuit breaker) ────────────────────

class OnChainVerifier {
  private client: TonClient;
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private readonly circuitThreshold = 5;

  constructor() {
    this.client = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });
  }

  async verifyTransaction(txHash: string, toAddress?: string): Promise<VerificationResult> {
    if (!toAddress) return 'pending';

    // Wallet-service tracking references (waitForTransaction):
    //   "addr_seqno"    → minted ONLY after the wallet's seqno increased,
    //                     i.e. the external message WAS consumed on-chain.
    //   "addr_seqno_ts" → minted after the seqno never moved (timeout) —
    //                     genuinely unknown, keep pending.
    if (txHash.includes('_')) {
      return txHash.split('_').length === 2 ? 'confirmed' : 'pending';
    }

    if (this.circuitOpen) {
      throw new ReconcileError('Circuit breaker open', 'RPC_ERROR', true);
    }

    try {
      const addr = Address.parse(toAddress);
      const transactions = await this.withRetry(() =>
        this.client.getTransactions(addr, { limit: 100 })
      );

      this.consecutiveFailures = 0;

      for (const tx of transactions) {
        const hash = tx.hash().toString('hex');
        if (hash !== txHash) continue;

        // Bounced message = failure
        if (tx.inMessage && 'bounced' in tx.inMessage && tx.inMessage.bounced) {
          return 'failed';
        }

        // Compute phase failure
        const desc = tx.description as any;
        if (desc?.computePhase?.success === false) {
          return 'failed';
        }

        // Action phase failure (important for outgoing transfers)
        if (desc?.actionPhase?.success === false) {
          return 'failed';
        }

        return 'confirmed';
      }

      return 'pending';
    } catch (error) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.circuitThreshold) {
        this.circuitOpen = true;
        setTimeout(() => {
          this.circuitOpen = false;
          this.consecutiveFailures = 0;
        }, 60_000);
      }

      if (error instanceof ReconcileError) throw error;
      throw new ReconcileError(
        `Verification failed: ${(error as Error).message}`,
        'RPC_ERROR',
        true
      );
    }
  }

  /** Wallet-side tx evidence (real fees via totalFees.coins, outbound message count). */
  async inspectWalletTx(txHash: string, walletAddress?: string): Promise<WalletTxEvidence> {
    if (!walletAddress || txHash.includes('_')) return { state: 'unreadable' };
    try {
      const addr = Address.parse(walletAddress);
      const transactions = await this.withRetry(() =>
        this.client.getTransactions(addr, { limit: 100 })
      );
      for (const tx of transactions) {
        if (tx.hash().toString('hex') === txHash) {
          return { state: 'found', feesNano: txTotalFeesNano(tx), outMessages: txOutMessageCount(tx) };
        }
      }
    } catch {
      // fall through
    }
    return { state: 'unreadable' };
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts = RPC_RETRY_ATTEMPTS): Promise<T> {
    let lastError: Error | undefined;

    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        if (i < attempts - 1) {
          await delay(RPC_RETRY_DELAY_MS * Math.pow(2, i));
        }
      }
    }

    throw lastError;
  }
        }
  // ─── Atomic Reconciliation Service ─────────────────────────────────────────

class ReconciliationService {
  private verifier: OnChainVerifier;
  private walletService: WalletService;
  private gasRecovery: GasRecoveryService;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor() {
    this.verifier = new OnChainVerifier();
    this.walletService = new WalletService();
    this.gasRecovery = new GasRecoveryService(this.walletService);
  }

  async start(): Promise<void> {
    if (this.timer) return;

    console.log('[Reconciler] Started');
    await this.tick();

    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[Reconciler] Tick error:', err));
    }, RECONCILE_INTERVAL_MS);
  }

  stop(): void {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[Reconciler] Stopped');
  }

  private async tick(): Promise<void> {
    if (this.isRunning || this.shuttingDown) return;
    this.isRunning = true;

    const startTime = Date.now();
    const metrics: ReconcileMetrics = {
      processed: 0,
      confirmed: 0,
      failed: 0,
      feesRecovered: 0,
      skipped: 0,
    };

    try {
      // Run sequentially to avoid MongoDB session contention
      await this.reconcileSwaps(metrics).catch((e) => console.error('[Reconciler] Swaps error:', e));
      await this.reconcileWithdrawals(metrics).catch((e) => console.error('[Reconciler] Withdrawals error:', e));
      await this.retryUnpaidSwapFees(metrics).catch((e) => console.error('[Reconciler] Fee retry error:', e));
      await this.reconcileFeeTransfers(metrics).catch((e) => console.error('[Reconciler] Fee transfers error:', e));
      await this.reconcileDeposits(metrics).catch((e) => console.error('[Reconciler] Deposits error:', e));
    } catch (error) {
      console.error('[Reconciler] Fatal tick error:', error);
    } finally {
      this.isRunning = false;
      const duration = Date.now() - startTime;

      // Only log when there is actual activity — stops empty spam
      if (metrics.processed > 0 || metrics.confirmed > 0 || metrics.failed > 0 || metrics.feesRecovered > 0) {
        console.log(
          `[Reconciler] Tick complete in ${duration}ms: ` +
            `processed=${metrics.processed}, confirmed=${metrics.confirmed}, ` +
            `failed=${metrics.failed}, recovered=${metrics.feesRecovered}, skipped=${metrics.skipped}`
        );
      }
    }
  }

  // ─── Swaps ─────────────────────────────────────────────────────────────

  private async reconcileSwaps(metrics: ReconcileMetrics): Promise<void> {
    // NO createdAt window: a swap stays reconcilable until it is finalized
    // or explicitly failed by the outcome logic. (A 1-hour window here
    // previously stranded swaps — and their platform fees — forever.)
    const pendingSwaps = await Transaction.find({
      type: 'swap' as TransactionType,
      status: { $in: ['pending', 'processing'] as TransactionStatus[] },
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    for (const swap of pendingSwaps) {
      if (this.shuttingDown) break;
      metrics.processed++;

      if (!swap.txHash || !swap.toAddress) {
        metrics.skipped++;
        continue;
      }

      try {
        const swapMeta = (swap.metadata || {}) as Record<string, any>;

        // CRITICAL: txHash is the WALLET-side transaction hash
        // (WalletService.waitForTransaction returns txs[0].hash() of the
        // SENDER wallet). It can never be found at the DEX router, whose
        // processing of our message is a DIFFERENT transaction with a
        // different hash. Verify at the wallet address.
        const verifyAddress = (swapMeta.walletAddress || swap.toAddress) as string;

        let verified = await this.verifier.verifyTransaction(
          swap.txHash,
          verifyAddress
        );

        // The wallet-tx check can read 'failed' even though the swap ran.
        // For ATF→TON the token side is the authority: if the ATF actually
        // left the wallet, the swap is NOT failed — let detectSwapOutput decide.
        if (verified === 'failed' && swapMeta.swapDirection === 'atf_to_ton') {
          const left = await this.atfLeftWallet(swapMeta);
          console.log(`[Reconciler] Swap ${swap._id}: wallet-tx check said failed; ATF left wallet=${left}`);
          if (left) verified = 'confirmed';
        }

        if (verified === 'pending') {
          metrics.skipped++;
          continue;
        }

        if (verified === 'failed') {
          const session = await mongoose.startSession();
          try {
            await session.withTransaction(async () => {
              const lockedSwap = await Transaction.findOne(
                { _id: swap._id, status: { $in: ['pending', 'processing'] } },
                null,
                { session }
              );
              if (!lockedSwap) return;
              await this.failSwap(lockedSwap, session, metrics);
            });
          } finally {
            await session.endSession();
          }
          continue;
        }

        const outcome = await this.detectSwapOutput(swap);

        if (outcome.status === 'pending') {
          metrics.skipped++;
          continue;
        }

        console.log(
          `[Reconciler] Swap ${swap._id} outcome=${outcome.status} method=${outcome.method} ` +
            `actualOutput=${outcome.actualOutputBaseUnits}`
        );

        let postCommit = undefined as (() => Promise<void>) | undefined;
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            postCommit = undefined;
            const lockedSwap = await Transaction.findOne(
              { _id: swap._id, status: { $in: ['pending', 'processing'] } },
              null,
              { session }
            );
            if (!lockedSwap) return;

            lockedSwap.metadata = {
              ...lockedSwap.metadata,
              swapOutcome: outcome.status,
              actualOutputBaseUnits: outcome.actualOutputBaseUnits.toString(),
              outcomeDetectedAt: new Date().toISOString(),
              outputDetectionMethod: outcome.method,
            };

            if (outcome.status === 'success') {
              postCommit = await this.finalizeSwap(lockedSwap, session, metrics);
            } else {
              await this.failSwap(lockedSwap, session, metrics);
            }
          });
        } finally {
          await session.endSession();
        }

        // Runs only AFTER the Mongo transaction has committed, so the fee
        // record created inside it is guaranteed to be visible.
        if (postCommit) {
          await postCommit().catch(err =>
            console.error('[Reconciler] Post-swap actions failed:', err)
          );
        }
      } catch (error) {
        await this.handleSwapError(swap, error as Error, metrics);
      }
    }
  }

  /** True when the offered ATF has left the swap wallet (>= 99% of the swapped amount). */
  private async atfLeftWallet(meta: Record<string, any>): Promise<boolean> {
    try {
      const wallet = (meta.walletAddress || '') as string;
      const expected = BigInt(meta.quote?.offerUnits || '0');
      if (!wallet || expected <= 0n) return false;
      const balances = await this.walletService.getBalance(wallet);
      const pre = BigInt(meta.preSwapAtfBalanceNano || '0');
      const drop = pre > balances.atf ? pre - balances.atf : 0n;
      return drop * 100n >= expected * 99n;
    } catch {
      return false;
    }
  }

  /**
   * Determines whether the DEX swap actually produced the expected output,
   * using on-chain balance deltas captured before the swap was broadcast.
   * 'pending' while the chain is still settling (90s grace), then 'failed'.
   */
  private async detectSwapOutput(swap: any): Promise<{
    status: 'success' | 'failed' | 'pending';
    actualOutputBaseUnits: bigint;
    method: string;
  }> {
    const meta = (swap.metadata || {}) as Record<string, any>;
    const walletAddress = (meta.walletAddress || '') as string;
    if (!walletAddress) {
      return { status: 'pending', actualOutputBaseUnits: 0n, method: 'no_wallet' };
    }

    const isTonToAtf = meta.swapDirection === 'ton_to_atf';
    const minOutput = BigInt(
      meta.minOutputBaseUnits || meta.swapMinOutputBaseUnits || '0'
    );

    const balances = await this.walletService.getBalance(walletAddress);
    // Grace runs from the BROADCAST. createdAt is often minutes old for
    // ATF→TON (queue + gas advance), which made the 90s grace already
    // expired on the first tick and a still-settling swap was marked failed.
    const broadcastMs = meta.broadcastedAt ? Date.parse(String(meta.broadcastedAt)) : NaN;
    const startMs = Number.isFinite(broadcastMs) ? broadcastMs : new Date(swap.createdAt).getTime();
    const ageMs = Math.max(0, Date.now() - startMs);

    if (isTonToAtf) {
      // Expected: ATF balance increased
      const atfDelta =
        balances.atf - BigInt(meta.preSwapAtfBalanceNano || '0');

      if (minOutput > 0n && atfDelta >= minOutput) {
        return { status: 'success', actualOutputBaseUnits: atfDelta, method: 'atf_balance_delta' };
      }

      if (ageMs < 90_000) {
        return { status: 'pending', actualOutputBaseUnits: atfDelta > 0n ? atfDelta : 0n, method: 'waiting' };
      }

      return {
        status: 'failed',
        actualOutputBaseUnits: atfDelta > 0n ? atfDelta : 0n,
        method: 'timeout_no_atf_output',
      };
    }

    // ATF → TON: success when the ATF actually left the wallet and was not
    // refunded (STON.fi guarantees output >= minOutput); failure when it came
    // back / never left. TON balance deltas alone are unreliable because the
    // DEX consumes part of the attached gas.
    const evidence = await this.verifier.inspectWalletTx(swap.txHash as string, walletAddress);

    return evaluateAtfToTonOutput({
      balanceTonNano: balances.ton,
      preSwapTonNano: BigInt(meta.preSwapTonBalanceNano || '0'),
      minOutputNano: minOutput,
      ageMs,
      tx: evidence,
      atf: {
        preSwapNano: BigInt(meta.preSwapAtfBalanceNano || '0'),
        nowNano: balances.atf,
        expectedInputNano: BigInt(meta.quote?.offerUnits || '0'),
      },
    });
  }

  private async finalizeSwap(
    swap: any,
    session: ClientSession,
    metrics: ReconcileMetrics
  ): Promise<() => Promise<void>> {
    const meta = (swap.metadata || {}) as Record<string, any>;

    swap.status = 'completed';
    swap.reconciledAt = new Date();
    swap.metadata = {
      ...meta,
      swapOutcome: 'success',
    };
    await swap.save({ session });
    metrics.confirmed++;

    // Credit the user's internal balance with the observed on-chain output.
    const outputBaseUnits = BigInt(meta.actualOutputBaseUnits || '0');
    const user = await User.findById(swap.userId).session(session);
    if (user && outputBaseUnits > 0n) {
      const isTonToAtf = meta.swapDirection === 'ton_to_atf';
      const balanceKey = isTonToAtf ? 'atfBalance' : 'tonBalance';
      const current = BigInt(user[balanceKey] || '0');
      user[balanceKey] = Precision.add(current, outputBaseUnits).toString();
      await user.save({ session });
    }

    // Platform fee is settled AFTER commit via the dedicated fee service
    // (single source of truth — see fee-collection-service.ts).
    const postCommit = await this.ensureFeeTransfer(swap, session);
    return postCommit;
  }

  /**
   * Ensures a fee record exists for a completed swap (created inside the
   * finalize transaction so it's atomic with completion) and returns a
   * post-commit closure that hands off to the FeeCollectionService.
   *
   * DUPLICATE-BROADCAST FIX: the record is an UPSERT keyed by the unique
   * metadata.feeKey (`<swapId>:platform`) instead of an unconditional
   * create — a duplicate here would abort the finalize transaction with
   * DuplicateKey, and pre-existing records are adopted rather than doubled.
   */
  private async ensureFeeTransfer(
    swap: any,
    session: ClientSession
  ): Promise<() => Promise<void>> {
    const swapId = swap._id.toString();

    if (swap.feeStatus === 'completed' || swap.feeStatus === 'processing') {
      return async () => {};
    }

    let feeTxId = (swap.metadata as any)?.feeTxId as string | undefined;

    if (!feeTxId) {
      // Canonical record, one per swap — unique index on metadata.feeKey.
      const feeKey = `${swapId}:platform`;
      const rec = await Transaction.findOneAndUpdate(
        { type: 'fee' as TransactionType, 'metadata.feeKey': feeKey },
        {
          $setOnInsert: {
            userId: swap.userId,
            type: 'fee' as TransactionType,
            asset: swap.asset,
            amount: swap.fee || '0',
            feePercentage: swap.feePercentage,
            feeWallet: config.adminFeeWalletAddress,
            status: 'pending' as TransactionStatus,
            toAddress: config.adminFeeWalletAddress,
            txHash: `fee-pending-${swapId}`,
            metadata: {
              swapTxId: swapId,
              feeKind: 'swap_platform_fee',
              feeKey,
              attempts: 0,
            },
          },
        },
        { upsert: true, new: true, session }
      );
      feeTxId = rec._id.toString();
    }

    swap.feeStatus = 'pending';
    (swap.metadata as any).feeTxId = feeTxId;
    await swap.save({ session });

    return async () => {
      const meta = swap.metadata as any;

      // ── Steps 1 + 2 FIRST: platform fees — while the wallet is flush
      // (advance leftover + swap output) and can definitely afford the
      // 0.1 TON attach the jetton fee transfer needs. Running the gas
      // clawback first could drain the wallet below that threshold on
      // small swaps, silently blocking fee collection forever.
      const { FeeCollectionService } = await import('../services/fee-collection-service');
      await new FeeCollectionService().collectSwapFee(swapId);

      // ── Step 3 LAST: claw back the admin gas advance — it takes
      // whatever platform TON remains (still ≈0.28 minus fee gas).
      // recoverAdminGasSafely is idempotent and re-entrant; the
      // GasRecoveryRetry job resumes anything the 3 attempts miss.
      if (meta.gasAdvanceTxId || meta.gasRecoveryWalletAddress) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await this.gasRecovery.recoverAdminGasSafely({
              swapTransactionId: swapId,
              userId: swap.userId,
              walletAddress: meta.walletAddress,
            });
            break;
          } catch (err) {
            console.error(`[Reconciler] Gas recovery attempt ${attempt} failed:`, err);
            if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
            // after 3 failures leave it — the GasRecoveryRetry job resumes.
          }
        }
      }
    };
  }
    /**
   * Delegates to FeeCollectionService (kept as the reconciler's entry
   * point so older call sites keep working). All fee logic — record
   * creation, claims, sending, broadcast-uncertain handling — lives in
   * the fee service now.
   */
  private async processFeeTransfer(swapId: string, _telegramId: number): Promise<void> {
    const { FeeCollectionService } = await import('../services/fee-collection-service');
    await new FeeCollectionService().collectSwapFee(swapId);
  }

  /**
   * Sweeps platform fees that never settled. Delegates entirely to the
   * FeeCollectionService, which selects from the CANONICAL FEE RECORDS.
   *
   * DUPLICATE-BROADCAST FIX: the old implementation queried swaps by
   * swap.feeStatus ∈ {pending, processing, failed} and called
   * collectSwapFee() directly — a stale mirror (e.g. reset to 'pending'
   * by the bounce path, or an error that didn't set the uncertain flag)
   * re-authorized a broadcast of an already-broadcast fee on every 30s
   * tick. Selection now lives in collectDueFees(), which is driven by the
   * fee record's status/feeOutcome/attempts/cooldown and never by the
   * swap mirror.
   */
  private async retryUnpaidSwapFees(metrics: ReconcileMetrics): Promise<void> {
    const { FeeCollectionService } = await import('../services/fee-collection-service');
    const { collected } = await new FeeCollectionService().collectDueFees();
    metrics.feesRecovered += collected;
  }

  private async failSwap(
    swap: any,
    session: ClientSession,
    metrics: ReconcileMetrics
  ): Promise<void> {
    if (swap.status === 'failed') return;

    await this.rollbackSwap(swap, session);

    swap.status = 'failed';
    swap.metadata = {
      ...swap.metadata,
      onChainFailure: true,
      swapOutcome: 'failed',
    };
    await swap.save({ session });
    metrics.failed++;

    // Gas recovery runs outside the transaction; the wallet state may lag.
    setImmediate(() => {
      const meta = (swap.metadata || {}) as Record<string, any>;
      if (meta.gasRecoveryWalletAddress && meta.gasRecoveryStatus) {
        this.gasRecovery
          .recoverAdminGasSafely({
            swapTransactionId: swap._id.toString(),
            userId: swap.userId,
            walletAddress: meta.gasRecoveryWalletAddress as string,
          })
          .then((result) => {
            console.log(
              `[Reconciler] Gas recovery after failed swap ${swap._id}: status=${result.status}, ` +
              `recovered=${Precision.fromBaseUnits(result.totalRecoveredNano, TON_DECIMALS)} TON, ` +
              `pending=${Precision.fromBaseUnits(result.pendingNano, TON_DECIMALS)} TON` +
              (result.skippedReason ? ` (${result.skippedReason})` : '')
            );
          })
          .catch((err) => {
            console.error(`[Reconciler] Gas recovery failed for swap ${swap._id}:`, err);
          });
      }
    });
  }

  private async rollbackSwap(swap: any, session: ClientSession): Promise<void> {
    const meta = (swap.metadata || {}) as Record<string, any>;
    if (meta.rolledBack) return;

    const user = await User.findById(swap.userId).session(session);
    if (!user) return;

    const isTonToAtf = meta.swapDirection === 'ton_to_atf';
    const balanceKey = isTonToAtf ? 'tonBalance' : 'atfBalance';

    const current = BigInt(user[balanceKey] || '0');
    const amount = BigInt(swap.amount || '0');

    user[balanceKey] = Precision.add(current, amount).toString();
    await user.save({ session });

    swap.metadata = {
      ...meta,
      rolledBack: true,
      rolledBackAt: new Date().toISOString(),
    };
  }

  private async handleSwapError(swap: any, error: Error, metrics: ReconcileMetrics): Promise<void> {
    const isRecoverable =
      error instanceof ReconcileError ? error.recoverable : true;

    if (isRecoverable) {
      console.warn(
        `[Reconciler] Recoverable error on swap ${swap._id}: ${error.message} — will retry next tick`
      );
      return;
    }

    const ageMs = Date.now() - new Date(swap.createdAt).getTime();
    if (ageMs > MAX_CONFIRMATION_WAIT_MS) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const lockedSwap = await Transaction.findOne(
            { _id: swap._id, status: { $in: ['pending', 'processing'] } },
            null,
            { session }
          );
          if (lockedSwap) {
            await this.failSwap(lockedSwap, session, metrics);
          }
        });
      } catch (txError) {
        console.error(`[Reconciler] Failed to mark timed-out swap ${swap._id} as failed:`, txError);
      } finally {
        await session.endSession();
      }
    }
  }

  // ─── Withdrawals ───────────────────────────────────────────────────────

  private async reconcileWithdrawals(metrics: ReconcileMetrics): Promise<void> {
    const pendingWithdrawals = await Transaction.find({
      type: 'withdrawal' as TransactionType,
      status: { $in: ['pending', 'processing'] as TransactionStatus[] },
      createdAt: { $gte: new Date(Date.now() - MAX_CONFIRMATION_WAIT_MS) },
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    for (const withdrawal of pendingWithdrawals) {
      if (this.shuttingDown) break;
      metrics.processed++;

      if (!withdrawal.txHash || !withdrawal.toAddress) {
        metrics.skipped++;
        continue;
      }

      try {
        // txHash is wallet-side (waitForTransaction); verify at the
        // sender wallet, not the destination. Underscore seqno refs are
        // handled inside the verifier. Fall back to toAddress if the
        // wallet cannot be resolved.
        let verifyAddress = withdrawal.toAddress as string;
        try {
          const wUser = await User.findById(withdrawal.userId).lean();
          if (wUser) {
            const wAddr = await this.walletService.getAddress(wUser.telegramId);
            if (wAddr) verifyAddress = wAddr;
          }
        } catch { /* fall back to toAddress */ }

        const verified = await this.verifier.verifyTransaction(
          withdrawal.txHash,
          verifyAddress
        );

        if (verified === 'pending') {
          metrics.skipped++;
          continue;
        }

        if (verified === 'confirmed') {
          await Transaction.findByIdAndUpdate(withdrawal._id, {
            status: 'completed',
            reconciledAt: new Date(),
          });
          metrics.confirmed++;
          continue;
        }

        // failed
        await Transaction.findByIdAndUpdate(withdrawal._id, {
          status: 'failed',
          metadata: {
            ...(withdrawal.metadata || {}),
            onChainFailure: true,
            error: 'Withdrawal transaction failed on-chain',
          },
        });
        metrics.failed++;
      } catch (error) {
        console.warn(
          `[Reconciler] Withdrawal verification error for ${withdrawal._id}:`,
          (error as Error).message
        );
      }
    }
  }

  // ─── Deposits ──────────────────────────────────────────────────────────

  private async reconcileDeposits(metrics: ReconcileMetrics): Promise<void> {
    const pendingDeposits = await Transaction.find({
      type: 'deposit' as TransactionType,
      status: 'pending' as TransactionStatus,
      txHash: { $exists: true, $ne: '' },
      createdAt: { $gte: new Date(Date.now() - MAX_CONFIRMATION_WAIT_MS) },
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    for (const deposit of pendingDeposits) {
      if (this.shuttingDown) break;

      try {
        const amount = BigInt(deposit.amount || '0');
        if (amount <= 0n) continue;

        // Atomic claim — prevents double-credit when the monitor and the
        // reconciler both observe the same deposit.
        const claimed = await Transaction.findOneAndUpdate(
          { _id: deposit._id, status: 'pending' },
          { $set: { status: 'processing' } },
          { new: true }
        );
        if (!claimed) {
          console.log(`ATF deposit check for ${deposit.fromAddress || ''}: deposit already recorded by another check (safe, no double-credit).`);
          continue;
        }

        /**
         * FIX A: platform-internal inflows are never user deposits.
         * Absorb any pre-fix records silently without crediting.
         */
        if (deposit.fromAddress && isInternalSender(deposit.fromAddress)) {
          await Transaction.findByIdAndUpdate(deposit._id, {
            status: 'completed',
            reconciledAt: new Date(),
          });
          continue;
        }

        const user = await User.findById(deposit.userId);
        if (!user) {
          await Transaction.findByIdAndUpdate(deposit._id, { status: 'failed' });
          continue;
        }

        const balanceKey = deposit.asset === 'TON' ? 'tonBalance' : 'atfBalance';
        const current = BigInt(user[balanceKey] || '0');
        user[balanceKey] = Precision.add(current, amount).toString();
        await user.save();

        await Transaction.findByIdAndUpdate(deposit._id, {
          status: 'completed',
          reconciledAt: new Date(),
        });

        console.log(`TON deposit credited: ${amount.toString()} nanoTON to user ${user.telegramId}`);
        metrics.confirmed++;
      } catch (error) {
        console.error(`[Reconciler] Deposit credit failed for ${deposit._id}:`, error);
      }
    }
  }

  // ─── Fee transfers ─────────────────────────────────────────────────────

  private async reconcileFeeTransfers(metrics: ReconcileMetrics): Promise<void> {
    const pendingFees = await Transaction.find({
      type: 'fee_transfer' as TransactionType,
      status: 'processing' as TransactionStatus,
      txHash: { $exists: true, $ne: '' },
      createdAt: { $gte: new Date(Date.now() - MAX_CONFIRMATION_WAIT_MS) },
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    for (const fee of pendingFees) {
      if (this.shuttingDown) break;
      metrics.processed++;

      try {
        const verified = await this.verifier.verifyTransaction(
          fee.txHash as string,
          fee.toAddress || config.adminFeeWalletAddress
        );

        if (verified === 'pending') {
          metrics.skipped++;
          continue;
        }

        await Transaction.findByIdAndUpdate(fee._id, {
          status: verified === 'confirmed' ? 'completed' : 'failed',
          reconciledAt: verified === 'confirmed' ? new Date() : undefined,
        });
        metrics.confirmed++;
      } catch (error) {
        console.warn(
          `[Reconciler] Fee transfer verification error for ${fee._id}:`,
          (error as Error).message
        );
      }
    }

    await this.claimFeeTransfer(metrics);
  }

  /**
   * Re-queues orphaned fee_transfer records stuck in 'processing' (e.g.
   * after a worker crash between claim and broadcast) once their lock is
   * stale. Platform-fee records (type 'fee') are NOT touched here — they
   * belong to the FeeCollectionService (reconcileUncertainFees).
   */
  private async claimFeeTransfer(metrics: ReconcileMetrics): Promise<void> {
    const stale = await Transaction.find({
      type: 'fee_transfer' as TransactionType,
      status: 'processing' as TransactionStatus,
      txHash: { $exists: false },
      updatedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) },
    })
      .limit(BATCH_SIZE)
      .lean();

    for (const fee of stale) {
      if (this.shuttingDown) break;

      await Transaction.updateOne(
        { _id: fee._id, status: 'processing', txHash: { $exists: false } },
        { $set: { status: 'pending' } }
      );
      metrics.skipped++;
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

const service = new ReconciliationService();

export async function startReconciler(): Promise<void> {
  await service.start();
}

export function stopReconciler(): void {
  service.stop();
      }

            
