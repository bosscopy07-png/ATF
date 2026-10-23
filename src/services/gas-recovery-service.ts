import {
  Transaction,
  ITransaction,
} from '../models/Transaction';

import { WalletService } from './wallet-service';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS } from '../config';
import { acquireLock } from '../utils/distributed-lock';

export type GasRecoveryStatus =
  | 'pending'
  | 'processing'
  | 'partial'
  | 'completed'
  | 'failed';

export interface GasAdvanceRecord {
  swapTransactionId: string;
  userId: number;
  walletAddress: string;
}

export interface RecoveryResult {
  status: GasRecoveryStatus;
  recoveredThisAttemptNano: bigint;
  totalRecoveredNano: bigint;
  pendingNano: bigint;
  txHash?: string;
  skippedReason?: string;
}

/**
 * Owns the platform TON advance lifecycle for ATF -> TON swaps.
 *
 * The important rule is that the recovery obligation is tied to the exact
 * wallet address that received the advance. Never resolve a user's active
 * wallet during recovery.
 */
export class GasRecoveryService {
  private walletService: WalletService;

  constructor(_walletService?: WalletService) {
    // FIX E: recovery always uses the fee-profile RPC/API key so a
    // rate-limit on the swap or monitor path can't stall clawbacks.
    // The optional parameter is kept for backward compatibility.
    this.walletService = new WalletService(undefined, 'fee');
  }

  async recordAdvance(params: {
    swapTransactionId: string;
    walletAddress: string;
    tonBalanceBeforeGasAdvanceNano: bigint;
    gasAdvanceAmountNano: bigint;
    gasAdvanceTxHash: string;
  }): Promise<void> {
    const updated = await Transaction.findByIdAndUpdate(
      params.swapTransactionId,
      {
        $set: {
          'metadata.gasAdvanceAmountNano': params.gasAdvanceAmountNano.toString(),
          'metadata.gasAdvanceTxHash': params.gasAdvanceTxHash,
          'metadata.gasRecoveryWalletAddress': params.walletAddress,
          'metadata.gasAdvanceStatus': 'completed',
          'metadata.tonBalanceBeforeGasAdvance': params.tonBalanceBeforeGasAdvanceNano.toString(),
          'metadata.gasAdvanceTimestamp': new Date().toISOString(),
          'metadata.gasRecoveryStatus': 'pending' as GasRecoveryStatus,
          'metadata.gasRecoveryAttempted': 0,
          'metadata.gasRecoveredAmountNano': '0',
          'metadata.gasRecoveryPendingAmountNano': params.gasAdvanceAmountNano.toString(),
          'metadata.gasRecoveryWrittenOffNano': '0',
          'metadata.gasRecoveryProcessingAt': null,
          'metadata.gasRecoveryLastError': null,
        },
      },
      { new: true }
    );

    if (!updated) {
      throw new Error(`Swap transaction ${params.swapTransactionId} not found while recording gas advance`);
    }
  }

  async recoverAdminGasSafely(record: GasAdvanceRecord): Promise<RecoveryResult> {
    const lock = await acquireLock(
      `lock:ton-gas:${record.walletAddress}`,
      config.gasRecoveryLockTtlMs
    );

    if (!lock) {
      return {
        status: 'pending',
        recoveredThisAttemptNano: 0n,
        totalRecoveredNano: 0n,
        pendingNano: 0n,
        skippedReason: 'Wallet gas-recovery lock is busy; retry will run again.',
      };
    }

    try {
      return await this.recoverAdminGasSafelyUnlocked(record);
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  private async recoverAdminGasSafelyUnlocked(
    record: GasAdvanceRecord
  ): Promise<RecoveryResult> {
    // FIX B: pipeline update — $toInt normalizes legacy BOOLEAN values
    // written by older swap-service code (true → 1) so the attempt counter
    // can never crash the retry job with:
    //   "Cannot apply $inc to a value of non-numeric type ... bool"
    const claimed = await Transaction.findOneAndUpdate(
      {
        _id: record.swapTransactionId,
        'metadata.gasRecoveryStatus': { $in: ['pending', 'partial', 'failed'] },
      },
      [
        {
          $set: {
            'metadata.gasRecoveryStatus': 'processing' as GasRecoveryStatus,
            'metadata.gasRecoveryProcessingAt': new Date().toISOString(),
            'metadata.gasRecoveryAttempted': {
              $add: [
                { $toInt: { $ifNull: ['$metadata.gasRecoveryAttempted', 0] } },
                1,
              ],
            },
          },
        },
      ],
      { new: true }
    );

    if (!claimed) {
      const existing = await Transaction.findById(record.swapTransactionId).lean();
      const meta = (existing?.metadata || {}) as Record<string, any>;
      const status = (meta.gasRecoveryStatus || 'completed') as GasRecoveryStatus;

      return {
        status,
        recoveredThisAttemptNano: 0n,
        totalRecoveredNano: BigInt(meta.gasRecoveredAmountNano || '0'),
        pendingNano: BigInt(meta.gasRecoveryPendingAmountNano || '0'),
        skippedReason:
          status === 'processing'
            ? 'Recovery already in progress for this swap.'
            : status === 'completed'
              ? 'Gas already fully recovered for this swap.'
              : 'Nothing to recover.',
      };
    }

    try {
      const meta = (claimed.metadata || {}) as Record<string, any>;
      const advanced = BigInt(meta.gasAdvanceAmountNano || '0');
      const preAdvance = BigInt(meta.tonBalanceBeforeGasAdvance || '0');
      const recovered = BigInt(meta.gasRecoveredAmountNano || '0');
      const writtenOff = BigInt(meta.gasRecoveryWrittenOffNano || '0');

      const stillOwed = advanced > recovered + writtenOff
        ? advanced - recovered - writtenOff
        : 0n;

      if (advanced <= 0n || stillOwed <= 0n) {
        return this.settle(
          claimed,
          'completed',
          0n,
          recovered,
          0n,
          'No outstanding platform gas obligation.'
        );
      }

      // This is deliberately strict. A provider/RPC failure must never look
      // like a zero balance and cause a false recovery decision.
      const currentBalance = await this.walletService.getTonBalanceStrict(
        record.walletAddress
      );

      const balanceIncrease = currentBalance > preAdvance
        ? currentBalance - preAdvance
        : 0n;

      /**
       * For a failed swap there is no user swap output to protect.
       * For a successful swap, `actualOutputBaseUnits` is written by the
       * reconciler after it observes the real on-chain output. We subtract
       * that observed user-owned output before calculating the platform
       * amount that remains in the wallet.
       */
      const swapSucceeded = meta.swapOutcome === 'success';
      const actualUserOutput = swapSucceeded
        ? BigInt(meta.actualOutputBaseUnits || '0')
        : 0n;

      const platformIncrease = balanceIncrease > actualUserOutput
        ? balanceIncrease - actualUserOutput
        : 0n;

      const recoverable = min2(stillOwed, platformIncrease);

      if (recoverable <= 0n) {
        return this.settle(
          claimed,
          'partial',
          0n,
          recovered,
          stillOwed,
          swapSucceeded
            ? 'No platform TON is currently recoverable after protecting observed swap output.'
            : 'No platform TON is currently recoverable; retry remains active.'
        );
      }

      const reserve =
        config.tonTransferFeeReserveNano +
        config.gasRecoveryBufferNano +
        config.gasRecoveryMinBalanceNano;

      const maxSendable = currentBalance > reserve
        ? currentBalance - reserve
        : 0n;

      const safeRecoverable = min2(recoverable, maxSendable);

      if (safeRecoverable <= 0n) {
        return this.settle(
          claimed,
          'partial',
          0n,
          recovered,
          stillOwed,
          'Wallet balance is below the safe recovery-send threshold.'
        );
      }

      /**
       * CRITICAL: send from the exact wallet that received the advance.
       *
       * FIX E (delivery verification): a returned hash/tracking ref only
       * proves the message LEFT our node — not that it LANDED. The old
       * code credited `recovered` on broadcast alone; that is exactly
       * how 289597274 was marked recovered while the TON never moved.
       * Recovery is credited only after both balances are observed to
       * shift by ≈ the sent amount.
       */
      const [adminBefore, walletBefore] = await Promise.all([
        this.walletService.getTonBalanceStrict(config.adminFeeWalletAddress),
        this.walletService.getTonBalanceStrict(record.walletAddress),
      ]);

      const txHash = await this.walletService.sendTonFromWalletAddress(
        record.walletAddress,
        config.adminFeeWalletAddress,
        safeRecoverable
      );

      const delivered = await this.verifyTonDelivery(
        record.walletAddress,
        config.adminFeeWalletAddress,
        walletBefore,
        adminBefore,
        safeRecoverable
      );

      if (!delivered) {
        // Throw WITHOUT crediting — the catch path resets the claim and
        // the retry job re-attempts. Exactly-once is preserved because
        // gasRecoveredAmountNano was never bumped.
        throw new Error(
          `Gas recovery transfer of ${safeRecoverable} nanoTON not ` +
          `confirmed on-chain (tracking ref ${txHash}) — not crediting recovery`
        );
      }

      const newRecovered = recovered + safeRecoverable;
      const pending = advanced > newRecovered + writtenOff
        ? advanced - newRecovered + writtenOff
        : 0n;
      const status: GasRecoveryStatus = pending > 0n ? 'partial' : 'completed';

      await Transaction.create({
        userId: claimed.userId,
        type: 'fee_transfer',
        asset: 'TON',
        amount: safeRecoverable.toString(),
        status: 'completed',
        toAddress: config.adminFeeWalletAddress,
        txHash,
        metadata: {
          purpose: 'gas_recovery',
          description: 'Recovery of TON advanced by admin for ATF -> TON swap',
          swapTxId: record.swapTransactionId,
          walletAddress: record.walletAddress,
          recoveredAmountNano: safeRecoverable.toString(),
          gasAdvanceAmountNano: advanced.toString(),
          swapOutcome: meta.swapOutcome || 'unknown',
        },
      });

      return this.settle(
        claimed,
        status,
        safeRecoverable,
        newRecovered,
        pending,
        undefined,
        txHash
      );
    } catch (error: any) {
      const meta = (claimed.metadata || {}) as Record<string, any>;
      const recovered = BigInt(meta.gasRecoveredAmountNano || '0');
      const advanced = BigInt(meta.gasAdvanceAmountNano || '0');
      const writtenOff = BigInt(meta.gasRecoveryWrittenOffNano || '0');
      const pending = advanced > recovered + writtenOff
        ? advanced - recovered - writtenOff
        : 0n;

      await Transaction.findByIdAndUpdate(record.swapTransactionId, {
        $set: {
          'metadata.gasRecoveryStatus': recovered > 0n ? 'partial' : 'pending',
          'metadata.gasRecoveryLastError': error?.message || String(error),
          'metadata.gasRecoveryProcessingAt': null,
          'metadata.gasRecoveryPendingAmountNano': pending.toString(),
        },
      });

      console.error(
        `[GasRecoveryService] Recovery failed for swap ${record.swapTransactionId}:`,
        error
      );

      return {
        status: recovered > 0n ? 'partial' : 'pending',
        recoveredThisAttemptNano: 0n,
        totalRecoveredNano: recovered,
        pendingNano: pending,
        skippedReason: error?.message || String(error),
      };
    }
        }
      private async settle(
    claimed: ITransaction,
    status: GasRecoveryStatus,
    recoveredThisAttemptNano: bigint,
    totalRecoveredNano: bigint,
    pendingNano: bigint,
    skippedReason?: string,
    txHash?: string
  ): Promise<RecoveryResult> {
    await Transaction.findByIdAndUpdate(claimed.id, {
      $set: {
        'metadata.gasRecoveryStatus': status,
        'metadata.gasRecoveredAmountNano': totalRecoveredNano.toString(),
        'metadata.gasRecoveryPendingAmountNano': pendingNano.toString(),
        'metadata.gasRecoveryProcessingAt': null,
        ...(txHash ? { 'metadata.gasRecoveryTxHash': txHash } : {}),
      },
    });

    return {
      status,
      recoveredThisAttemptNano,
      totalRecoveredNano,
      pendingNano,
      txHash,
      skippedReason,
    };
  }

  /**
   * FIX E: poll both ends of a clawback. Delivered only when the source
   * wallet dropped by ≥ ~amount AND the destination rose by ~amount.
   * Timeout → NOT delivered (caller throws; the retry job resumes).
   * An RPC hiccup never reads as delivered — it keeps polling.
   */
  private async verifyTonDelivery(
    fromAddress: string,
    toAddress: string,
    fromBefore: bigint,
    toBefore: bigint,
    amount: bigint
  ): Promise<boolean> {
    const threshold = amount / 2n;

    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));

      try {
        const [fromNow, toNow] = await Promise.all([
          this.walletService.getTonBalanceStrict(fromAddress),
          this.walletService.getTonBalanceStrict(toAddress),
        ]);

        const fromDelta = fromBefore - fromNow;
        const toDelta = toNow - toBefore;

        if (fromDelta >= threshold && toDelta >= threshold) {
          return true;
        }
      } catch {
        // RPC hiccup — keep polling.
      }
    }

    return false;
  }
}

function min2(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function gasTonToNano(gasTon: string): bigint {
  return Precision.toBaseUnits(gasTon, TON_DECIMALS);
                                        }
          
