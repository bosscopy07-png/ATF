import { Transaction, ITransaction } from '../models/Transaction';
import { WalletService } from './wallet-service';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS } from '../config';

export type GasRecoveryStatus = 'pending' | 'processing' | 'partial' | 'completed' | 'failed';

export interface GasAdvanceRecord {
  /** The swap Transaction _id whose metadata carries the gas-advance/recovery audit trail. */
  swapTransactionId: string;
  userId: number; // telegramId, matches WalletService.sendTon(userId, ...)
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
 * ONE centralized, safe, idempotent mechanism for recovering TON that the
 * admin/platform wallet advanced to a user for network gas.
 *
 * Used from every path that needs it:
 *   A. Failed ATF→TON swap before broadcast          (swap-service.ts)
 *   B. Successful ATF→TON swap, post-broadcast        (swap-service.ts)
 *   C. Retry/recovery worker                          (jobs/gas-recovery-retry.ts)
 *
 * Design constraints this implements (see the audit fields on the swap
 * Transaction's metadata):
 *   - Never recovers more than was actually advanced (capped by the
 *     recorded pre-advance balance, not just "whatever the wallet has now").
 *   - Never sends an amount that would make the recovery transfer itself
 *     fail — it reserves a configurable fee + safety buffer.
 *   - Idempotent: safe to call twice for the same swap; a completed
 *     recovery is never repeated, and concurrent calls cannot double-send.
 *   - Partial recoveries are recorded and retryable; nothing is silently
 *     lost or falsely marked complete.
 *
 * All TON accounting here is integer nanoTON via `Precision` / `bigint` —
 * no floating point anywhere in the money math.
 */
export class GasRecoveryService {
  private walletService: WalletService;

  constructor(walletService?: WalletService) {
    this.walletService = walletService || new WalletService();
  }

  /**
   * Record the admin gas advance on the swap transaction's metadata.
   * Call this immediately after the admin wallet successfully sends the
   * advance, with the balance captured immediately BEFORE that send.
   */
  async recordAdvance(params: {
    swapTransactionId: string;
    tonBalanceBeforeGasAdvanceNano: bigint;
    gasAdvanceAmountNano: bigint;
    gasAdvanceTxHash: string;
  }): Promise<void> {
    await Transaction.findByIdAndUpdate(params.swapTransactionId, {
      $set: {
        'metadata.gasAdvanceAmountNano': params.gasAdvanceAmountNano.toString(),
        'metadata.gasAdvanceTxHash': params.gasAdvanceTxHash,
        'metadata.gasAdvanceStatus': 'completed',
        'metadata.tonBalanceBeforeGasAdvance': params.tonBalanceBeforeGasAdvanceNano.toString(),
        'metadata.gasAdvanceTimestamp': new Date().toISOString(),
        'metadata.gasRecoveryStatus': 'pending' as GasRecoveryStatus,
        'metadata.gasRecoveryAttempted': 0,
        'metadata.gasRecoveredAmountNano': '0',
        'metadata.gasRecoveryPendingAmountNano': params.gasAdvanceAmountNano.toString(),
      },
    });
  }

  /**
   * Attempt to safely recover as much of the outstanding admin gas advance
   * as currently possible for this swap. Safe to call repeatedly (idempotent)
   * and safe to call from multiple instances concurrently — only one
   * attempt will actually run at a time per swap, enforced atomically by
   * MongoDB (`gasRecoveryStatus` transition pending/partial/failed -> processing).
   */
  async recoverAdminGasSafely(record: GasAdvanceRecord): Promise<RecoveryResult> {
    // Atomically claim the right to attempt recovery for this swap. If
    // another attempt is already 'processing' or has already 'completed',
    // this update matches nothing and we bail out — this IS the idempotency
    // and concurrency guard, not an in-memory flag.
    const claimed = await Transaction.findOneAndUpdate(
      {
        _id: record.swapTransactionId,
        'metadata.gasRecoveryStatus': { $in: ['pending', 'partial', 'failed'] },
      },
      {
        $set: { 'metadata.gasRecoveryStatus': 'processing' as GasRecoveryStatus },
        $inc: { 'metadata.gasRecoveryAttempted': 1 },
      },
      { new: true }
    );

    if (!claimed) {
      // Either already completed, already processing elsewhere, or there is
      // no advance to recover at all. Report current state without acting.
      const existing = await Transaction.findById(record.swapTransactionId).lean();
      const meta = (existing?.metadata || {}) as Record<string, any>;
      const status: GasRecoveryStatus = meta.gasRecoveryStatus || 'completed';
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
      const meta = claimed.metadata as Record<string, any>;
      const adminAdvancedNano = BigInt(meta.gasAdvanceAmountNano || '0');
      const preAdvanceBalanceNano = BigInt(meta.tonBalanceBeforeGasAdvance || '0');
      const alreadyRecoveredNano = BigInt(meta.gasRecoveredAmountNano || '0');

      const stillOwed = adminAdvancedNano - alreadyRecoveredNano;

      if (adminAdvancedNano <= 0n || stillOwed <= 0n) {
        return await this.settle(claimed, 'completed', 0n, alreadyRecoveredNano, 0n);
      }

      const { ton: currentBalanceRaw } = await this.walletService.getBalance(record.walletAddress);
      const currentBalanceNano = BigInt(currentBalanceRaw.toString());

      // Step 4: how much of the admin advance is still attributable, capped
      // at the actual advance — never touch the user's own pre-existing TON.
      const netIncreaseFromAdvance = currentBalanceNano > preAdvanceBalanceNano
        ? currentBalanceNano - preAdvanceBalanceNano
        : 0n;

      const adminGasRemaining = min2(stillOwed, netIncreaseFromAdvance);

      if (adminGasRemaining <= 0n) {
        // Nothing left that is safely attributable to the advance right now
        // (e.g. user has already spent it all). Leave it retryable — the
        // user's balance may recover later — rather than falsely completing.
        return await this.settle(claimed, 'partial', 0n, alreadyRecoveredNano, stillOwed, 'Nothing currently recoverable.');
      }

      // Step 5: leave enough for the recovery transfer's own fee + buffer,
      // and never dip below the configured floor.
      const requiredFee = config.tonTransferFeeReserveNano;
      const buffer = config.gasRecoveryBufferNano;
      const floor = config.gasRecoveryMinBalanceNano;
      const reserve = requiredFee + buffer + floor;

      let safeRecoverable: bigint;
      if (currentBalanceNano >= adminGasRemaining + reserve) {
        safeRecoverable = adminGasRemaining;
      } else {
        const maxSendable = currentBalanceNano - reserve;
        safeRecoverable = maxSendable > 0n ? min2(adminGasRemaining, maxSendable) : 0n;
      }

      if (safeRecoverable <= 0n) {
        return await this.settle(
          claimed,
          'partial',
          0n,
          alreadyRecoveredNano,
          stillOwed,
          'Balance too low to safely cover the recovery transfer fee right now.'
        );
      }

      // sendTon's `amount` is what the destination receives; the wallet
      // pays the network fee separately out of its own balance (confirmed
      // from WalletService.sendTon's use of PAY_GAS_SEPARATELY / `internal({
      // value: amount })`), which is exactly why `reserve` above is on top
      // of `safeRecoverable`, not deducted from it.
      const txHash = await this.walletService.sendTon(
        record.userId,
        config.adminFeeWalletAddress,
        safeRecoverable
      );

      const newTotalRecovered = alreadyRecoveredNano + safeRecoverable;
      const finalStatus: GasRecoveryStatus = newTotalRecovered >= adminAdvancedNano ? 'completed' : 'partial';
      const pendingNano = adminAdvancedNano > newTotalRecovered ? adminAdvancedNano - newTotalRecovered : 0n;

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
          description: 'Recovery of gas TON advanced by admin for ATF→TON swap',
          swapTxId: record.swapTransactionId,
        },
      });

      return await this.settle(claimed, finalStatus, safeRecoverable, newTotalRecovered, pendingNano, undefined, txHash);
    } catch (error: any) {
      // Never mark completed on failure. Revert to 'partial' (retryable) so
      // the retry worker can pick it back up; the amounts already recovered
      // stay exactly as they were.
      const meta = claimed.metadata as Record<string, any>;
      const alreadyRecoveredNano = BigInt(meta.gasRecoveredAmountNano || '0');
      const adminAdvancedNano = BigInt(meta.gasAdvanceAmountNano || '0');
      const pendingNano = adminAdvancedNano > alreadyRecoveredNano ? adminAdvancedNano - alreadyRecoveredNano : 0n;

      await Transaction.findByIdAndUpdate(record.swapTransactionId, {
        $set: {
          'metadata.gasRecoveryStatus': (alreadyRecoveredNano > 0n ? 'partial' : 'pending') as GasRecoveryStatus,
          'metadata.gasRecoveryLastError': error?.message || String(error),
        },
      });

      console.error(`[GasRecoveryService] Recovery attempt failed for swap ${record.swapTransactionId}:`, error);

      return {
        status: alreadyRecoveredNano > 0n ? 'partial' : 'pending',
        recoveredThisAttemptNano: 0n,
        totalRecoveredNano: alreadyRecoveredNano,
        pendingNano,
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
    await Transaction.findByIdAndUpdate(claimed._id, {
      $set: {
        'metadata.gasRecoveryStatus': status,
        'metadata.gasRecoveredAmountNano': totalRecoveredNano.toString(),
        'metadata.gasRecoveryPendingAmountNano': pendingNano.toString(),
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
}

function min2(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Convenience: convert the STON.fi decimal `gasTon` string to exact nanoTON. */
export function gasTonToNano(gasTon: string): bigint {
  return Precision.toBaseUnits(gasTon, TON_DECIMALS);
               }
    
