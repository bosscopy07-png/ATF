import mongoose, { ClientSession } from 'mongoose';
import { TonClient, Address } from '@ton/ton';
import { Transaction, TransactionStatus, TransactionType } from '../models/Transaction';
import { User } from '../models/User';
import { Precision } from '../utils/precision';
import { config } from '../config';
import { WalletService } from '../services/wallet-service';
import { GasRecoveryService } from '../services/gas-recovery-service';

const RECONCILE_INTERVAL_MS = 30_000;
const MAX_CONFIRMATION_WAIT_MS = 3_600_000;
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

      if (!swap.txHash || !swap.toAddress) {
        metrics.skipped++;
        continue;
      }

      try {
        const verified = await this.verifier.verifyTransaction(
          swap.txHash,
          swap.toAddress
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

  private async detectSwapOutput(swap: any): Promise<{
    status: 'success' | 'failed' | 'pending';
    actualOutputBaseUnits: bigint;
    method: string;
  }> {
    const meta = (swap.metadata || {}) as SwapMetadata & Record<string, any>;
    const walletAddress = meta.walletAddress as string | undefined;
    if (!walletAddress) {
      throw new ReconcileError(
        `Swap ${swap._id} has no recorded wallet address`,
        'INVALID_STATE',
        false
      );
    }

    const isTonToAtf = meta.swapDirection === 'ton_to_atf';
    const minOutput = BigInt(
      meta.minOutputBaseUnits || meta.swapMinOutputBaseUnits || meta.quote?.minAskUnits || '0'
    );

    const preTon = BigInt(meta.preSwapTonBalanceNano || '0');
    const preAtf = BigInt(meta.preSwapAtfBalanceNano || '0');
    const ageMs = Date.now() - new Date(swap.createdAt).getTime();

    const balance = await this.walletService.getBalanceStrict(walletAddress);

    if (isTonToAtf) {
      const delta = balance.atf > preAtf ? balance.atf - preAtf : 0n;

      if (delta >= minOutput && minOutput > 0n) {
        return {
          status: 'success',
          actualOutputBaseUnits: delta,
          method: 'ATF balance increase >= STON.fi minAskUnits',
        };
      }
    } else {
      /**
       * The ATF -> TON wallet transaction itself spends `swapValueNano`
       * TON on DEX gas. Adding that maximum spend back lets us detect the
       * guaranteed output without mistaking the gas payment for swap output.
       * Any excess gas refund remains user-owned and is deliberately not
       * recovered by the gas service unless it is above the recorded advance.
       */
      const swapValue = BigInt(meta.swapValueNano || '0');
      const adjustedDelta = balance.ton + swapValue > preTon
        ? balance.ton + swapValue - preTon
        : 0n;

      if (adjustedDelta >= minOutput && minOutput > 0n) {
        return {
          status: 'success',
          actualOutputBaseUnits: minOutput,
          method: 'TON balance after accounting for swap gas >= STON.fi minAskUnits',
        };
      }
    }

    /**
     * A confirmed wallet transaction with no minimum-output delivery is not
     * immediately declared failed. STON.fi may still be completing the trace.
     * Once the bounded confirmation window expires, it becomes a failed swap
     * and the gas-recovery path is triggered.
     */
    if (ageMs < 90_000) {
      return {
        status: 'pending',
        actualOutputBaseUnits: 0n,
        method: 'Waiting for DEX output/refund trace',
      };
    }

    return {
      status: 'failed',
      actualOutputBaseUnits: 0n,
      method: 'Confirmed wallet transaction but no minimum swap output observed within 90 seconds',
    };
  }

  private async finalizeSwap(
    swap: any,
    session: ClientSession,
    metrics: ReconcileMetrics
  ): Promise<(() => Promise<void>) | undefined> {
    if (swap.status === 'completed') return undefined;

    const user = await User.findById(swap.userId).session(session);
    if (!user) throw new ReconcileError('User not found', 'INVALID_STATE', false);

    const meta = (swap.metadata || {}) as SwapMetadata & Record<string, any>;
    const isTonToAtf = meta.swapDirection === 'ton_to_atf';
    const outputAsset = isTonToAtf ? 'atfBalance' : 'tonBalance';
    const outputAmount = BigInt(meta.actualOutputBaseUnits || meta.minOutputBaseUnits || '0');

    if (outputAmount <= 0n) {
      throw new ReconcileError('Successful swap has zero observed output', 'INVALID_STATE', false);
    }

    if (!meta.outputCredited) {
      user[outputAsset] = Precision.add(
        BigInt(user[outputAsset] || '0'),
        outputAmount
      ).toString();
      await user.save({ session });
    }

    swap.status = 'completed';
    swap.reconciledAt = new Date();
    swap.metadata = {
      ...swap.metadata,
      outputCredited: true,
      swapOutcome: 'success',
    };
    await swap.save({ session });
    metrics.confirmed++;

    const swapId = swap._id.toString();
    const telegramId = user.telegramId;
    const needsGasRecovery = !isTonToAtf && !!meta.gasAdvanceAmountNano;
    const gasWallet = meta.gasRecoveryWalletAddress || meta.walletAddress;

    let needsFee = false;
    if (swap.feeStatus === 'pending' || swap.feeStatus === 'processing') {
      await this.ensureFeeTransfer(swap, session);
      needsFee = true;
    }

    console.log(
      `[Reconciler] Swap ${swap._id} confirmed with output=${outputAmount.toString()} base units`
    );

    // Executed by the caller AFTER the Mongo transaction commits.
    // Order matters: the platform fee is sent FIRST (ATF fee needs TON gas in
    // the user wallet), then the admin gas advance is clawed back. Running them
    // in parallel caused seqno collisions and a drained wallet.
    return async () => {
      if (needsFee) {
        try {
          await this.processFeeTransfer(swapId, telegramId);
        } catch (err) {
          console.error('[Reconciler] Swap fee transfer failed (will retry):', err);
        }
      }

      if (needsGasRecovery) {
        if (needsFee) await new Promise(r => setTimeout(r, 8000));
        try {
          await this.gasRecovery.recoverAdminGasSafely({
            swapTransactionId: swapId,
            userId: telegramId,
            walletAddress: gasWallet,
          });
        } catch (err) {
          console.error('[Reconciler] Successful-swap gas recovery failed:', err);
        }
      }
    };
  }

  private async ensureFeeTransfer(
    swap: any,
    session: ClientSession
  ): Promise<void> {
    const existing = await Transaction.findOne({
      type: 'fee_transfer',
      'metadata.swapTxId': swap._id.toString(),
    }).session(session);

    if (existing?.status === 'completed') {
      swap.feeStatus = 'completed';
      swap.feeTxHash = existing.txHash;
      await swap.save({ session });
      return;
    }

    if (!existing) {
      await Transaction.create([
        {
          userId: swap.userId,
          type: 'fee_transfer',
          asset: swap.feeAsset,
          amount: swap.fee || '0',
          status: 'pending',
          toAddress: config.adminFeeWalletAddress,
          metadata: { swapTxId: swap._id.toString(), purpose: 'swap_fee' },
        },
      ], { session });
    }

    swap.feeStatus = 'processing';
    await swap.save({ session });
  }

  private async processFeeTransfer(swapId: string, telegramId: number): Promise<void> {
    // Atomic claim so the same fee can never be sent twice.
    const feeTx = await Transaction.findOneAndUpdate(
      {
        type: 'fee_transfer',
        'metadata.swapTxId': swapId,
        status: 'pending',
      },
      { $set: { status: 'processing', 'metadata.feeClaimedAt': new Date().toISOString() } },
      { new: true }
    );

    if (!feeTx) return;

    if (BigInt(feeTx.amount || '0') <= 0n) {
      await Transaction.findByIdAndUpdate(feeTx._id, { $set: { status: 'completed' } });
      await Transaction.findByIdAndUpdate(swapId, { $set: { feeStatus: 'completed' } });
      return;
    }

    try {
      const hash = feeTx.asset === 'TON'
        ? await this.walletService.sendTon(telegramId, config.adminFeeWalletAddress, BigInt(feeTx.amount))
        : await this.walletService.sendJetton(telegramId, config.adminFeeWalletAddress, config.atfJettonAddress!, BigInt(feeTx.amount));

      await Transaction.findByIdAndUpdate(feeTx._id, {
        $set: { status: 'completed', txHash: hash },
      });

      await Transaction.findByIdAndUpdate(swapId, {
        $set: { feeStatus: 'completed', feeTxHash: hash },
      });

      console.log(`[Reconciler] Platform fee sent for swap ${swapId}: ${feeTx.amount} ${feeTx.asset} (${hash})`);
    } catch (error: any) {
      await Transaction.findByIdAndUpdate(feeTx._id, {
        $set: { status: 'failed', 'metadata.error': error?.message || String(error) },
        $inc: { 'metadata.feeRetryCount': 1 },
      });
      await Transaction.findByIdAndUpdate(swapId, {
        $set: { feeStatus: 'failed' },
      });
      throw error;
    }
  }

  /**
   * Retry sweep: completed swaps whose platform fee was never sent
   * (pending or failed with no tx hash). Runs every tick.
   */
  private async retryUnpaidSwapFees(metrics: ReconcileMetrics): Promise<void> {
    const swaps = await Transaction.find({
      type: 'swap' as TransactionType,
      status: 'completed' as TransactionStatus,
      feeStatus: { $in: ['pending', 'failed', 'processing'] },
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    for (const swap of swaps) {
      if (this.shuttingDown) break;
      if (BigInt(swap.fee || '0') <= 0n) continue;

      const swapId = swap._id.toString();

      let feeTx: any = await Transaction.findOne({
        type: 'fee_transfer',
        'metadata.swapTxId': swapId,
      });

      if (!feeTx) {
        feeTx = await Transaction.create({
          userId: swap.userId,
          type: 'fee_transfer',
          asset: swap.feeAsset,
          amount: swap.fee || '0',
          status: 'pending',
          toAddress: config.adminFeeWalletAddress,
          metadata: { swapTxId: swapId, purpose: 'swap_fee', recovery: true },
        });
      }

      if (feeTx.status === 'completed' || feeTx.txHash) continue;

      const retries = Number(feeTx.metadata?.feeRetryCount || 0);
      if (retries >= 5) continue;

      // Only re-queue fees that never produced a tx hash (nothing was broadcast).
      if (feeTx.status === 'failed') {
        await Transaction.updateOne(
          { _id: feeTx._id, status: 'failed', txHash: { $exists: false } },
          { $set: { status: 'pending' } }
        );
      }

      const user = await User.findById(swap.userId).lean();
      if (!user) continue;

      try {
        await this.processFeeTransfer(swapId, user.telegramId);
        metrics.feesRecovered++;
      } catch (err) {
        console.error(`[Reconciler] Fee retry failed for swap ${swapId}:`, err);
      }
    }
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
      actualOutputBaseUnits: '0',
    };
    swap.reconciledAt = new Date();
    await swap.save({ session });
    metrics.failed++;

    const meta = (swap.metadata || {}) as Record<string, any>;
    if (meta.gasAdvanceAmountNano && meta.gasRecoveryWalletAddress) {
      const gasUser = await User.findById(swap.userId).session(session);
      const telegramId = gasUser?.telegramId;
      if (telegramId) {
        setImmediate(() => {
          this.gasRecovery
            .recoverAdminGasSafely({
              swapTransactionId: swap._id.toString(),
              userId: telegramId,
              walletAddress: meta.gasRecoveryWalletAddress,
            })
            .catch(err => console.error('[Reconciler] Failed-swap gas recovery failed:', err));
        });
      }
    }

    console.log(`[Reconciler] Swap ${swap._id} failed on-chain; gas recovery queued`);
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

      const meta = (swap.metadata || {}) as Record<string, any>;
      if (meta.gasAdvanceAmountNano && meta.gasRecoveryWalletAddress) {
        const gasUser = await User.findById(swap.userId).lean();
        if (gasUser?.telegramId) {
          setImmediate(() => {
            this.gasRecovery
              .recoverAdminGasSafely({
                swapTransactionId: swap._id.toString(),
                userId: gasUser.telegramId,
                walletAddress: meta.gasRecoveryWalletAddress,
              })
              .catch(err => console.error('[Reconciler] Timeout gas recovery failed:', err));
          });
        }
      }
    } else {
      console.warn(`[Reconciler] Swap ${swap._id} recoverable error: ${error.message}`);
    }
  }


  private async rollbackSwap(swap: any, session: ClientSession): Promise<void> {
    const user = await User.findById(swap.userId).session(session);
    if (!user) return;

    const meta = swap.metadata as SwapMetadata;
    const inputAsset = meta?.swapDirection === 'ton_to_atf' ? 'tonBalance' : 'atfBalance';
    const inputAmount = BigInt(swap.amount || '0');

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
      metrics.processed++;

      if (!tx.txHash) {
        metrics.skipped++;
        continue;
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const lockedTx = await Transaction.findOne(
            { _id: tx._id, status: 'processing' },
            null,
            { session }
          );
          if (!lockedTx) {
            metrics.skipped++;
            return;
          }

          const verified = await this.verifier.verifyTransaction(
            lockedTx.txHash!,
            lockedTx.toAddress || undefined
          );

          if (verified === 'confirmed') {
            lockedTx.status = 'completed';
            lockedTx.reconciledAt = new Date();
            await lockedTx.save({ session });
            metrics.confirmed++;
            console.log(`[Reconciler] Withdrawal ${tx._id} confirmed`);
          } else if (verified === 'failed') {
            await this.rollbackWithdrawal(lockedTx, session);
            metrics.failed++;
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

    const balanceKey = tx.asset === 'TON' ? 'tonBalance' : 'atfBalance';
    const amount = BigInt(tx.amount || '0');

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
      metrics.processed++;

      if (!tx.txHash) {
        metrics.skipped++;
        continue;
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const lockedTx = await Transaction.findOne(
            { _id: tx._id, status: 'processing' },
            null,
            { session }
          );
          if (!lockedTx) {
            metrics.skipped++;
            return;
          }

          const verified = await this.verifier.verifyTransaction(
            lockedTx.txHash!,
            config.adminFeeWalletAddress
          );

          if (verified === 'confirmed') {
            lockedTx.status = 'completed';
            lockedTx.reconciledAt = new Date();
            await lockedTx.save({ session });
            metrics.confirmed++;

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
            metrics.failed++;
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
      metrics.processed++;

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

   
