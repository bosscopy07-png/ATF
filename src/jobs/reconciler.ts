import mongoose, { ClientSession } from 'mongoose';
import { TonClient, Address } from '@ton/ton';
import { Transaction, TransactionStatus, TransactionType } from '../models/Transaction';
import { User } from '../models/User';
import { Precision } from '../utils/precision';
import { config } from '../config';

const RECONCILE_INTERVAL_MS = 30_000;
const MAX_CONFIRMATION_WAIT_MS = 3_600_000;
const BATCH_SIZE = 50;
const RPC_RETRY_ATTEMPTS = 3;
const RPC_RETRY_DELAY_MS = 1_000;

// ─── Types ─────────────────────────────────────────────────────────────────

interface ReconcileMetrics {
  processed: number;
  confirmed: number;
  failed: number;
  feesRecovered: number;
  skipped: number;
}

interface SwapMetadata {
  swapDirection: 'ton_to_aft' | 'aft_to_ton';
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

  private async withRetry<T>(fn: () => Promise<T>, attempts = RPC_RETRY_ATTEMPTS): Promise<T> {
    let lastError: Error | undefined;

    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        if (i < attempts - 1) {
          await delay(RPC_RETRY_DELAY_MS * Math.pow(2, i)); // exponential backoff
        }
      }
    }

    throw lastError;
  }
}

// ─── Atomic Reconciliation Service ─────────────────────────────────────────

class ReconciliationService {
  private verifier: OnChainVerifier;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor() {
    this.verifier = new OnChainVerifier();
  }

  async start(): Promise<void> {
    if (this.timer) return;

    console.log('[Reconciler] Starting...');
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
      await Promise.all([
        this.reconcileSwaps(metrics),
        this.reconcileWithdrawals(metrics),
        this.reconcileFeeTransfers(metrics),
        this.reconcileDeposits(metrics),
      ]);
    } catch (error) {
      console.error('[Reconciler] Fatal tick error:', error);
    } finally {
      this.isRunning = false;
      const duration = Date.now() - startTime;
      console.log(
        `[Reconciler] Tick complete in ${duration}ms: ` +
          `processed=${metrics.processed}, confirmed=${metrics.confirmed}, ` +
          `failed=${metrics.failed}, recovered=${metrics.feesRecovered}, skipped=${metrics.skipped}`
      );
    }
  }

  // ─── Swaps ─────────────────────────────────────────────────────────────

  private async reconcileSwaps(metrics: ReconcileMetrics): Promise<void> {
    const pendingSwaps = await Transaction.find({
      type: 'swap' as TransactionType,
      status: { $in: ['pending', 'processing'] as TransactionStatus[] },
      createdAt: { $gte: new Date(Date.now() - MAX_CONFIRMATION_WAIT_MS) },
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    for (const swap of pendingSwaps) {
      if (this.shuttingDown) break;
      metrics.processed++;

      if (!swap.txHash) {
        metrics.skipped++;
        continue;
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          // Re-fetch with session lock to prevent race conditions
          const lockedSwap = await Transaction.findOne(
            { _id: swap._id, status: { $in: ['pending', 'processing'] } },
            null,
            { session }
          );

          if (!lockedSwap) {
            metrics.skipped++;
            return;
          }

          const verified = await this.verifier.verifyTransaction(
            lockedSwap.txHash!,
            lockedSwap.toAddress || undefined
          );

          if (verified === 'confirmed') {
            await this.finalizeSwap(lockedSwap, session, metrics);
          } else if (verified === 'failed') {
            await this.failSwap(lockedSwap, session, metrics);
          }
          // If pending: do nothing, wait for next tick
        });
      } catch (error) {
        await this.handleSwapError(swap, error as Error, metrics);
      } finally {
        await session.endSession();
      }
    }
  }

  private async finalizeSwap(
    swap: any,
    session: ClientSession,
    metrics: ReconcileMetrics
  ): Promise<void> {
    // Idempotency: already completed?
    if (swap.status === 'completed') return;

    const user = await User.findById(swap.userId).session(session);
    if (!user) throw new ReconcileError('User not found', 'INVALID_STATE', false);

    const meta = swap.metadata as SwapMetadata;
    const outputAsset = meta?.swapDirection === 'ton_to_aft' ? 'aftBalance' : 'tonBalance';
    const outputAmount = BigInt(meta?.expectedOutput || '0');

    // Atomic credit
    user[outputAsset] = Precision.add(BigInt(user[outputAsset] || '0'), outputAmount).toString();
    await user.save({ session });

    // Update swap
    swap.status = 'completed';
    swap.reconciledAt = new Date();
    await swap.save({ session });
    metrics.confirmed++;

    // Finalize gas funding tx if present
    if (meta?.gasTon) {
      await Transaction.updateMany(
        {
          type: 'fee_transfer',
          'metadata.swapTxId': swap._id.toString(),
          'metadata.purpose': 'swap_gas_funding',
        },
        { $set: { status: 'completed' } },
        { session }
      );
    }

    // Handle fee
    if (swap.feeStatus === 'pending' || swap.feeStatus === 'processing') {
      const feeTx = await Transaction.findOne({
        type: 'fee_transfer',
        'metadata.swapTxId': swap._id.toString(),
      }).session(session);

      if (feeTx?.status === 'completed') {
        swap.feeStatus = 'completed';
        await swap.save({ session });
      } else if (!feeTx || feeTx.status === 'failed') {
        await this.recoverFeeTransfer(swap, session);
        metrics.feesRecovered++;
      }
    }

    console.log(`[Reconciler] Swap ${swap._id} confirmed`);
  }

  private async failSwap(
    swap: any,
    session: ClientSession,
    metrics: ReconcileMetrics
  ): Promise<void> {
    if (swap.status === 'failed') return;

    await this.rollbackSwap(swap, session);

    swap.status = 'failed';
    swap.metadata = { ...swap.metadata, onChainFailure: true };
    swap.reconciledAt = new Date();
    await swap.save({ session });
    metrics.failed++;

    console.log(`[Reconciler] Swap ${swap._id} failed on-chain`);
  }

  private async handleSwapError(
    swap: any,
    error: Error,
    metrics: ReconcileMetrics
  ): Promise<void> {
    const ageMs = Date.now() - new Date(swap.createdAt).getTime();
    const isRecoverable =
      error instanceof ReconcileError ? error.recoverable : true;

    if (!isRecoverable || ageMs > MAX_CONFIRMATION_WAIT_MS) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const lockedSwap = await Transaction.findById(swap._id).session(session);
          if (!lockedSwap || lockedSwap.status === 'failed') return;

          await this.rollbackSwap(lockedSwap, session);
          lockedSwap.status = 'failed';
          lockedSwap.metadata = {
            ...lockedSwap.metadata,
            reconcileTimeout: true,
            reconcileError: error.message,
          };
          await lockedSwap.save({ session });
          metrics.failed++;
        });
      } finally {
        await session.endSession();
      }
    } else {
      console.warn(`[Reconciler] Swap ${swap._id} recoverable error: ${error.message}`);
    }
  }

  private async rollbackSwap(swap: any, session: ClientSession): Promise<void> {
    const user = await User.findById(swap.userId).session(session);
    if (!user) return;

    const meta = swap.metadata as SwapMetadata;
    const inputAsset = meta?.swapDirection === 'ton_to_aft' ? 'tonBalance' : 'aftBalance';
    const inputAmount = BigInt(swap.amount || '0');

    // Idempotency: check if already rolled back
    if (swap.metadata?.rolledBack) return;

    user[inputAsset] = Precision.add(BigInt(user[inputAsset] || '0'), inputAmount).toString();
    await user.save({ session });

    swap.metadata = { ...swap.metadata, rolledBack: true };
    console.log(`[Reconciler] Swap ${swap._id} rolled back`);
  }

  private async recoverFeeTransfer(swap: any, session: ClientSession): Promise<void> {
    const feeAmount = BigInt(swap.fee || '0');
    if (feeAmount <= 0n) return;

    const feeTx = await Transaction.findOneAndUpdate(
      { type: 'fee_transfer', 'metadata.swapTxId': swap._id.toString() },
      {
        $setOnInsert: {
          userId: swap.userId,
          type: 'fee_transfer',
          asset: swap.feeAsset,
          amount: feeAmount.toString(),
          status: 'pending',
          toAddress: config.adminFeeWalletAddress,
          metadata: { swapTxId: swap._id.toString(), recovery: true },
        },
      },
      { upsert: true, new: true, session }
    );

    if (feeTx.status === 'pending') {
      feeTx.status = 'processing';
      await feeTx.save({ session });
    }
  }

  // ─── Withdrawals ─────────────────────────────────────────────────────────

  private async reconcileWithdrawals(metrics: ReconcileMetrics): Promise<void> {
    const pending = await Transaction.find({
      type: 'withdrawal' as TransactionType,
      status: 'processing' as TransactionStatus,
      createdAt: { $gte: new Date(Date.now() - MAX_CONFIRMATION_WAIT_MS) },
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    for (const tx of pending) {
      if (this.shuttingDown) break;

      if (!tx.txHash) continue;

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const lockedTx = await Transaction.findOne(
            { _id: tx._id, status: 'processing' },
            null,
            { session }
          );
          if (!lockedTx) return;

          const verified = await this.verifier.verifyTransaction(
            lockedTx.txHash!,
            lockedTx.toAddress || undefined
          );

          if (verified === 'confirmed') {
            lockedTx.status = 'completed';
            lockedTx.reconciledAt = new Date();
            await lockedTx.save({ session });
            console.log(`[Reconciler] Withdrawal ${tx._id} confirmed`);
          } else if (verified === 'failed') {
            await this.rollbackWithdrawal(lockedTx, session);
          }
        });
      } catch (error) {
        console.error(`[Reconciler] Withdrawal ${tx._id} error:`, error);
      } finally {
        await session.endSession();
      }
    }
  }

  private async rollbackWithdrawal(tx: any, session: ClientSession): Promise<void> {
    const user = await User.findById(tx.userId).session(session);
    if (!user) return;

    const balanceKey = tx.asset === 'TON' ? 'tonBalance' : 'aftBalance';
    const amount = BigInt(tx.amount || '0');

    // Check if already rolled back
    if (tx.metadata?.rolledBack) return;

    user[balanceKey] = Precision.add(BigInt(user[balanceKey] || '0'), amount).toString();
    await user.save({ session });

    tx.status = 'failed';
    tx.metadata = { ...tx.metadata, onChainFailure: true, rolledBack: true };
    tx.reconciledAt = new Date();
    await tx.save({ session });

    console.log(`[Reconciler] Withdrawal ${tx._id} failed — funds returned`);
  }

  // ─── Fee Transfers ───────────────────────────────────────────────────────

  private async reconcileFeeTransfers(metrics: ReconcileMetrics): Promise<void> {
    const pending = await Transaction.find({
      type: 'fee_transfer' as TransactionType,
      status: 'processing' as TransactionStatus,
      createdAt: { $gte: new Date(Date.now() - MAX_CONFIRMATION_WAIT_MS) },
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    for (const tx of pending) {
      if (this.shuttingDown) break;
      if (!tx.txHash) continue;

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const lockedTx = await Transaction.findOne(
            { _id: tx._id, status: 'processing' },
            null,
            { session }
          );
          if (!lockedTx) return;

          const verified = await this.verifier.verifyTransaction(
            lockedTx.txHash!,
            config.adminFeeWalletAddress
          );

          if (verified === 'confirmed') {
            lockedTx.status = 'completed';
            lockedTx.reconciledAt = new Date();
            await lockedTx.save({ session });

            if (lockedTx.metadata?.swapTxId) {
              await Transaction.findByIdAndUpdate(
                lockedTx.metadata.swapTxId,
                { $set: { feeStatus: 'completed', feeTxHash: lockedTx.txHash } },
                { session }
              );
            }
            console.log(`[Reconciler] Fee transfer ${tx._id} confirmed`);
          } else if (verified === 'failed') {
            lockedTx.status = 'failed';
            lockedTx.metadata = { ...lockedTx.metadata, onChainFailure: true };
            await lockedTx.save({ session });
            console.log(`[Reconciler] Fee transfer ${tx._id} failed`);
          }
        });
      } catch (error) {
        console.error(`[Reconciler] Fee ${tx._id} error:`, error);
      } finally {
        await session.endSession();
      }
    }
  }

  // ─── Deposits ────────────────────────────────────────────────────────────

  private async reconcileDeposits(metrics: ReconcileMetrics): Promise<void> {
    const orphaned = await Transaction.find({
      type: 'deposit' as TransactionType,
      status: 'pending' as TransactionStatus,
      createdAt: { $lte: new Date(Date.now() - 86_400_000) },
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    for (const tx of orphaned) {
      if (this.shuttingDown) break;

      await Transaction.findByIdAndUpdate(tx._id, {
        $set: {
          status: 'failed',
          'metadata.reconcileNote': 'Orphaned deposit — no confirmation within 24h',
          reconciledAt: new Date(),
        },
      });
      console.log(`[Reconciler] Orphaned deposit ${tx._id} marked failed`);
    }
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

let service: ReconciliationService | null = null;

export async function startReconciler(): Promise<void> {
  service = new ReconciliationService();
  await service.start();
}

export function stopReconciler(): void {
  service?.stop();
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[Reconciler] SIGINT received');
  stopReconciler();
  await mongoose.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[Reconciler] SIGTERM received');
  stopReconciler();
  await mongoose.disconnect();
  process.exit(0);
});

if (require.main === module) {
  startReconciler().catch(console.error);
          }
          
