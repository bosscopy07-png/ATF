import {
  Transaction,
  ITransaction,
} from '../models/Transaction';

import { WalletService } from './wallet-service';

import { Precision } from '../utils/precision';

import {
  config,
  TON_DECIMALS,
} from '../config';

import { acquireLock } from '../utils/distributed-lock';

export type GasRecoveryStatus =
  | 'pending'
  | 'processing'
  | 'partial'
  | 'completed'
  | 'failed';

export interface GasAdvanceRecord {
  /**
   * The swap transaction containing the recovery audit trail.
   */
  swapTransactionId: string;

  /**
   * Telegram user ID.
   */
  userId: number;

  /**
   * EXACT wallet address that received the platform gas.
   *
   * Never replace this with the user's current active wallet.
   */
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
 * Centralized TON gas recovery.
 *
 * The platform temporarily sends TON to a user's wallet so that
 * an ATF → TON transaction can execute.
 *
 * That advance is tracked against the exact wallet which received it.
 *
 * Recovery can happen from:
 *
 * 1. Successful ATF → TON swap
 * 2. Failed ATF → TON swap before broadcast
 * 3. Background retry worker
 *
 * Important:
 *
 * - bigint only for TON accounting
 * - never recover more than the recorded advance
 * - exact wallet address is stored
 * - withdrawal and recovery share the same distributed lock
 * - partial recovery remains retryable
 * - processing records can be reopened after worker crashes
 */
export class GasRecoveryService {
  private walletService: WalletService;

  constructor(
    walletService?: WalletService
  ) {
    this.walletService =
      walletService ||
      new WalletService();
  }

  /**
   * Record the company's gas advance.
   *
   * This must be called immediately after the admin wallet
   * successfully sends the gas.
   */
  async recordAdvance(params: {
    swapTransactionId: string;

    walletAddress: string;

    tonBalanceBeforeGasAdvanceNano: bigint;

    gasAdvanceAmountNano: bigint;

    gasAdvanceTxHash: string;
  }): Promise<void> {
    await Transaction.findByIdAndUpdate(
      params.swapTransactionId,
      {
        $set: {
          'metadata.gasAdvanceAmountNano':
            params.gasAdvanceAmountNano.toString(),

          'metadata.gasAdvanceTxHash':
            params.gasAdvanceTxHash,

          /**
           * Critical:
           *
           * This is the exact wallet that received the
           * company's TON.
           */
          'metadata.gasRecoveryWalletAddress':
            params.walletAddress,

          'metadata.gasAdvanceStatus':
            'completed',

          'metadata.tonBalanceBeforeGasAdvance':
            params.tonBalanceBeforeGasAdvanceNano.toString(),

          'metadata.gasAdvanceTimestamp':
            new Date().toISOString(),

          'metadata.gasRecoveryStatus':
            'pending' as GasRecoveryStatus,

          'metadata.gasRecoveryAttempted':
            0,

          'metadata.gasRecoveredAmountNano':
            '0',

          'metadata.gasRecoveryPendingAmountNano':
            params.gasAdvanceAmountNano.toString(),

          'metadata.gasRecoveryProcessingAt':
            null,

          'metadata.gasRecoveryLastError':
            null,
        },
      }
    );
  }

  /**
   * Public recovery entry point.
   *
   * Recovery and withdrawal use the SAME wallet lock.
   *
   * This prevents:
   *
   * recovery reads balance
   *       ↓
   * withdrawal reads same balance
   *       ↓
   * withdrawal drains gas
   *       ↓
   * recovery fails
   *
   * Only one can operate on that wallet at a time.
   */
  async recoverAdminGasSafely(
    record: GasAdvanceRecord
  ): Promise<RecoveryResult> {
    const lock =
      await acquireLock(
        `lock:ton-gas:${record.walletAddress}`,
        config.gasRecoveryLockTtlMs
      );

    if (!lock) {
      return {
        status: 'pending',

        recoveredThisAttemptNano:
          0n,

        totalRecoveredNano:
          0n,

        pendingNano:
          0n,

        skippedReason:
          'Wallet gas-recovery lock is busy; retry will run again.',
      };
    }

    try {
      return await this.recoverAdminGasSafelyUnlocked(
        record
      );
    } finally {
      await lock
        .release()
        .catch(() => undefined);
    }
  }

  /**
   * Actual recovery implementation.
   */
  private async recoverAdminGasSafelyUnlocked(
    record: GasAdvanceRecord
  ): Promise<RecoveryResult> {
    /**
     * Atomically claim this recovery.
     *
     * Only one process can move:
     *
     * pending/partial/failed
     *
     * to:
     *
     * processing
     */
    const claimed =
      await Transaction.findOneAndUpdate(
        {
          _id:
            record.swapTransactionId,

          'metadata.gasRecoveryStatus': {
            $in: [
              'pending',
              'partial',
              'failed',
            ],
          },
        },
        {
          $set: {
            'metadata.gasRecoveryStatus':
              'processing' as GasRecoveryStatus,

            'metadata.gasRecoveryProcessingAt':
              new Date().toISOString(),
          },

          $inc: {
            'metadata.gasRecoveryAttempted':
              1,
          },
        },
        {
          new: true,
        }
      );

    if (!claimed) {
      const existing =
        await Transaction.findById(
          record.swapTransactionId
        ).lean();

      const meta =
        (existing?.metadata || {}) as Record<
          string,
          any
        >;

      const status:
        GasRecoveryStatus =
        meta.gasRecoveryStatus ||
        'completed';

      return {
        status,

        recoveredThisAttemptNano:
          0n,

        totalRecoveredNano:
          BigInt(
            meta.gasRecoveredAmountNano ||
              '0'
          ),

        pendingNano:
          BigInt(
            meta.gasRecoveryPendingAmountNano ||
              '0'
          ),

        skippedReason:
          status === 'processing'
            ? 'Recovery already in progress for this swap.'
            : status === 'completed'
            ? 'Gas already fully recovered for this swap.'
            : 'Nothing to recover.',
      };
    }

    try {
      const meta =
        claimed.metadata as Record<
          string,
          any
        >;

      const adminAdvancedNano =
        BigInt(
          meta.gasAdvanceAmountNano ||
            '0'
        );

      const preAdvanceBalanceNano =
        BigInt(
          meta.tonBalanceBeforeGasAdvance ||
            '0'
        );

      const alreadyRecoveredNano =
        BigInt(
          meta.gasRecoveredAmountNano ||
            '0'
        );

      const stillOwed =
        adminAdvancedNano -
        alreadyRecoveredNano;

      /**
       * No outstanding company gas.
       */
      if (
        adminAdvancedNano <= 0n ||
        stillOwed <= 0n
      ) {
        console.log(
          `[GasRecovery] Recovery already settled: ` +
            `swap=${record.swapTransactionId} ` +
            `user=${record.userId} ` +
            `wallet=${record.walletAddress} ` +
            `gasAdvancedNanoTon=${adminAdvancedNano} ` +
            `recoveredNanoTon=${alreadyRecoveredNano} ` +
            `recoveryStatus=completed`
        );

        return await this.settle(
          claimed,
          'completed',
          0n,
          alreadyRecoveredNano,
          0n
        );
      }

      /**
       * IMPORTANT:
       *
       * Query the exact wallet that received
       * the company's advance.
       */
      const {
        ton: currentBalanceRaw,
      } =
        await this.walletService.getBalance(
          record.walletAddress
        );

      const currentBalanceNano =
        BigInt(
          currentBalanceRaw.toString()
        );

      /**
       * Only consider TON above the user's balance
       * immediately before the company gas advance.
       *
       * This prevents us from taking the user's own
       * pre-existing TON.
       */
      const netIncreaseFromAdvance =
        currentBalanceNano >
        preAdvanceBalanceNano
          ? currentBalanceNano -
            preAdvanceBalanceNano
          : 0n;

      /**
       * A genuinely successful ATF → TON swap delivers TON
       * output to the user's wallet. That output belongs to
       * the user and must never be mistaken for recoverable
       * platform gas.
       *
       * The stored quote's minAskUnits is the on-chain
       * GUARANTEED minimum swap output, so at least that much
       * of the balance increase is definitely user-owned
       * output, not platform gas.
       *
       * A swap that failed before broadcast produced no
       * output, so the entire increase above the pre-advance
       * balance is still platform gas — existing failed-swap
       * behavior is preserved exactly.
       */
      const swapSucceeded =
        claimed.status ===
          'completed' ||
        meta.swapBroadcasted ===
          true;

      let guaranteedUserOutputNano =
        0n;

      if (swapSucceeded) {
        try {
          const minAskUnits =
            meta.quote?.minAskUnits;

          if (
            minAskUnits !==
              undefined &&
            minAskUnits !==
              null &&
            minAskUnits !==
              ''
          ) {
            guaranteedUserOutputNano =
              BigInt(
                minAskUnits.toString()
              );
          }
        } catch {
          guaranteedUserOutputNano =
            0n;
        }
      }

      const advanceAttributedIncrease =
        guaranteedUserOutputNano >
        0n
          ? netIncreaseFromAdvance >
            guaranteedUserOutputNano
            ? netIncreaseFromAdvance -
              guaranteedUserOutputNano
            : 0n
          : netIncreaseFromAdvance;

      /**
       * Recoverable platform gas is capped by:
       *
       * 1. the recorded advance obligation still owed
       *    (stillOwed), and
       * 2. the balance increase attributable to the advance
       *    itself.
       *
       * The user's entire wallet balance is NEVER treated as
       * recoverable, and never more than the recorded advance
       * can be recovered.
       */
      const adminGasRemaining =
        min2(
          stillOwed,
          advanceAttributedIncrease
        );

      /**
       * The advance may already have been consumed by
       * the swap transaction.
       *
       * Do NOT mark it completed merely because it is gone.
       *
       * Leave it retryable.
       */
      if (
        adminGasRemaining <= 0n
      ) {
        console.log(
          `[GasRecovery] ${swapSucceeded ? 'Successful' : 'Failed'} ATF→TON recovery pending: ` +
            `swap=${record.swapTransactionId} ` +
            `user=${record.userId} ` +
            `wallet=${record.walletAddress} ` +
            `gasAdvancedNanoTon=${adminAdvancedNano} ` +
            `recoverableNanoTon=0 ` +
            `recoveredNanoTon=${alreadyRecoveredNano} ` +
            `recoveryStatus=partial ` +
            `reason=Nothing currently recoverable from the platform advance.`
        );

        return await this.settle(
          claimed,
          'partial',
          0n,
          alreadyRecoveredNano,
          stillOwed,
          'Nothing currently recoverable.'
        );
      }

      /**
       * Reserve enough TON for the recovery transfer itself.
       *
       * sendTon uses PAY_GAS_SEPARATELY, so the destination receives
       * `safeRecoverable` while the wallet still needs enough TON
       * to pay the network transaction.
       */
      const requiredFee =
        config.tonTransferFeeReserveNano;

      const buffer =
        config.gasRecoveryBufferNano;

      const floor =
        config.gasRecoveryMinBalanceNano;

      const reserve =
        requiredFee +
        buffer +
        floor;

      const maxSendable =
        currentBalanceNano -
        reserve;

      const safeRecoverable =
        maxSendable > 0n
          ? min2(
              adminGasRemaining,
              maxSendable
            )
          : 0n;

      if (
        safeRecoverable <= 0n
      ) {
        console.log(
          `[GasRecovery] ${swapSucceeded ? 'Successful' : 'Failed'} ATF→TON recovery pending: ` +
            `swap=${record.swapTransactionId} ` +
            `user=${record.userId} ` +
            `wallet=${record.walletAddress} ` +
            `gasAdvancedNanoTon=${adminAdvancedNano} ` +
            `recoverableNanoTon=${adminGasRemaining} ` +
            `recoveredNanoTon=${alreadyRecoveredNano} ` +
            `recoveryStatus=partial ` +
            `reason=Balance is currently below the safe recovery-send threshold.`
        );

        return await this.settle(
          claimed,
          'partial',
          0n,
          alreadyRecoveredNano,
          stillOwed,
          'Balance is currently below the safe recovery-send threshold.'
        );
      }

      /**
       * Send the recovered TON back to the company wallet.
       */
      const txHash =
        await this.walletService.sendTon(
          record.userId,
          config.adminFeeWalletAddress,
          safeRecoverable
        );

      const newTotalRecovered =
        alreadyRecoveredNano +
        safeRecoverable;

      const finalStatus:
        GasRecoveryStatus =
        newTotalRecovered >=
        adminAdvancedNano
          ? 'completed'
          : 'partial';

      const pendingNano =
        adminAdvancedNano >
        newTotalRecovered
          ? adminAdvancedNano -
            newTotalRecovered
          : 0n;

      /**
       * The exact consumed amount is not knowable
       * synchronously; this is a proven lower bound
       * (advance minus the increase attributable to the
       * advance). No transaction fee is guessed.
       */
      const consumedLowerBoundNano =
        adminAdvancedNano >
        advanceAttributedIncrease
          ? adminAdvancedNano -
            advanceAttributedIncrease
          : 0n;

      console.log(
        `[GasRecovery] ${swapSucceeded ? 'Successful' : 'Failed'} ATF→TON recovery: ` +
          `swap=${record.swapTransactionId} ` +
          `user=${record.userId} ` +
          `wallet=${record.walletAddress} ` +
          `gasAdvancedNanoTon=${adminAdvancedNano} ` +
          `gasConsumedNanoTon>=${consumedLowerBoundNano} ` +
          `guaranteedUserOutputNano=${guaranteedUserOutputNano} ` +
          `recoverableNanoTon=${adminGasRemaining} ` +
          `recoveredNanoTon=${safeRecoverable} ` +
          `recoveryStatus=${finalStatus}`
      );

      /**
       * Audit the actual recovery transfer.
       */
      await Transaction.create({
        userId:
          claimed.userId,

        type:
          'fee_transfer',

        asset:
          'TON',

        amount:
          safeRecoverable.toString(),

        status:
          'completed',

        toAddress:
          config.adminFeeWalletAddress,

        txHash,

        metadata: {
          purpose:
            'gas_recovery',

          description:
            'Recovery of gas TON advanced by admin for ATF→TON swap',

          swapTxId:
            record.swapTransactionId,

          walletAddress:
            record.walletAddress,

          recoveredAmountNano:
            safeRecoverable.toString(),

          gasAdvanceAmountNano:
            adminAdvancedNano.toString(),
        },
      });

      return await this.settle(
        claimed,
        finalStatus,
        safeRecoverable,
        newTotalRecovered,
        pendingNano,
        undefined,
        txHash
      );
    } catch (error: any) {
      /**
       * Never mark failed recovery as completed.
       *
       * The swap itself is NEVER touched here — a recovery
       * failure must never change a successful swap into a
       * failed one.
       */
      const meta =
        claimed.metadata as Record<
          string,
          any
        >;

      const alreadyRecoveredNano =
        BigInt(
          meta.gasRecoveredAmountNano ||
            '0'
        );

      const adminAdvancedNano =
        BigInt(
          meta.gasAdvanceAmountNano ||
            '0'
        );

      const pendingNano =
        adminAdvancedNano >
        alreadyRecoveredNano
          ? adminAdvancedNano -
            alreadyRecoveredNano
          : 0n;

      await Transaction.findByIdAndUpdate(
        record.swapTransactionId,
        {
          $set: {
            'metadata.gasRecoveryStatus':
              (alreadyRecoveredNano > 0n
                ? 'partial'
                : 'pending') as GasRecoveryStatus,

            'metadata.gasRecoveryLastError':
              error?.message ||
              String(error),

            'metadata.gasRecoveryProcessingAt':
              null,
          },
        }
      );

      console.error(
        `[GasRecoveryService] Recovery attempt failed for swap ${record.swapTransactionId}:`,
        error
      );

      return {
        status:
          alreadyRecoveredNano > 0n
            ? 'partial'
            : 'pending',

        recoveredThisAttemptNano:
          0n,

        totalRecoveredNano:
          alreadyRecoveredNano,

        pendingNano,

        skippedReason:
          error?.message ||
          String(error),
      };
    }
  }

  /**
   * Persist the current recovery state.
   */
  private async settle(
    claimed: ITransaction,
    status: GasRecoveryStatus,
    recoveredThisAttemptNano: bigint,
    totalRecoveredNano: bigint,
    pendingNano: bigint,
    skippedReason?: string,
    txHash?: string
  ): Promise<RecoveryResult> {
    await Transaction.findByIdAndUpdate(
      claimed._id,
      {
        $set: {
          'metadata.gasRecoveryStatus':
            status,

          'metadata.gasRecoveredAmountNano':
            totalRecoveredNano.toString(),

          'metadata.gasRecoveryPendingAmountNano':
            pendingNano.toString(),

          'metadata.gasRecoveryProcessingAt':
            null,

          ...(txHash
            ? {
                'metadata.gasRecoveryTxHash':
                  txHash,
              }
            : {}),
        },
      }
    );

    return {
      status,

      recoveredThisAttemptNano,

      totalRecoveredNano,

      pendingNano,

      txHash,

      skippedReason,
    };
  }
}

function min2(
  a: bigint,
  b: bigint
): bigint {
  return a < b ? a : b;
}

/**
 * Convert decimal TON into exact nanoTON.
 */
export function gasTonToNano(
  gasTon: string
): bigint {
  return Precision.toBaseUnits(
    gasTon,
    TON_DECIMALS
  );
          }
          
