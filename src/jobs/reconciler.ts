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


const RECONCILE_INTERVAL_MS = 30_000;

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

  /**
   * Reads the swap's WALLET-side transaction and returns the evidence the
   * output decision needs: the real total fees (`tx.totalFees.coins` —
   * totalFees is a CurrencyCollection, not a bigint) and how many
   * outbound messages the wallet actually emitted.
   *
   * 'unreadable' is returned for tracking-ref hashes ("addr_seqno"),
   * RPC failures, and when the tx is not in the fetched window. It is
   * NEVER mapped to zero fees: callers must keep the swap unresolved.
   */
  async inspectWalletTx(txHash: string, walletAddress?: string): Promise<WalletTxEvidence> {
    if (!walletAddress || txHash.includes('_')) return { state: 'unreadable' };

    try {
      const addr = Address.parse(walletAddress);
      const transactions = await this.withRetry(() =>
        this.client.getTransactions(addr, { limit: 100 })
      );

      for (const tx of transactions) {
        if (tx.hash().toString('hex') === txHash) {
          return {
            state: 'found',
            feesNano: txTotalFeesNano(tx),
            outMessages: txOutMessageCount(tx),
          };
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

        const verified = await this.verifier.verifyTransaction(
          swap.txHash,
          verifyAddress
        );

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
    const ageMs = Date.now() - new Date(swap.createdAt).getTime();

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

    // ATF → TON. A consumed wallet message is NOT proof of output: the
    // verdict comes only from the wallet's real tx fees plus its TON
    // balance change (see evaluateAtfToTonOutput). The attached
    // swapValueNano is never added back — STON.fi refunds part of it, so
    // that inflated output. Unreadable evidence leaves the swap pending.
    const evidence = await this.verifier.inspectWalletTx(
      swap.txHash as string,
      walletAddress
    );

    return evaluateAtfToTonOutput({
      balanceTonNano: balances.ton,
      preSwapTonNano: BigInt(meta.preSwapTonBalanceNano || '0'),
      minOutputNano: minOutput,
      ageMs,
      tx: evidence,
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

      // ── Steps 1 + 2 FIRST: input/platform fee, then the token→TON output
      // fee — while the wallet is still flush with the advance leftover.
      // Neither return value is trusted as "settled": GasRecoveryService
      // re-reads the DURABLE fee records and refuses to claw back until both
      // required fees are completed (or waived after a long no-gas block).
      const { FeeCollectionService } = await import('../services/fee-collection-service');
      await new FeeCollectionService().collectSwapFee(swapId);

      // ── Step 3 LAST: claw back the remaining gas advance. Idempotent and
      // re-entrant; the GasRecoveryRetry job resumes anything deferred.
      if (meta.gasAdvanceTxId || meta.gasRecoveryWalletAddress) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            // A deferral behind an unsettled fee is a normal result (not a
            // throw): the GasRecoveryRetry job owns the follow-up.
            await this.gasRecovery.recoverAdminGasSafely({
              swapTransactionId: swapId,
              userId: swap.userId,
              walletAddress: meta.walletAddress,
            });
            break;
          } catch (err) {
            console.error(`[Reconciler] Gas recovery attempt ${attempt} failed:`, err);
            if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
          }
    
