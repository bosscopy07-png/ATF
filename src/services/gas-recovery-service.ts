import {
  Transaction,
  ITransaction,
} from '../models/Transaction';

import { WalletService } from './wallet-service';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS } from '../config';
import { acquireLock } from '../utils/distributed-lock';
import { TonClient, Address } from '@ton/ton';
import {
  gasRecoveryGate,
  platformFeeKey,
  outputFeeKey,
  GasRecoveryGate,
} from './fee-record-policy';

/** A previous clawback that never showed up on-chain may only be replaced after this. */
const RECOVERY_REPLACE_AFTER_MS = 10 * 60 * 1000;

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

  private _tonClient: TonClient | null = null;

  protected get tonClient(): TonClient {
    if (!this._tonClient) {
      this._tonClient = new TonClient({
        endpoint: (config as any).tonFeeRpcUrl ?? config.tonRpcUrl,
        apiKey: config.tonApiKey,
      });
    }
    return this._tonClient;
  }

  /**
   * Durable-state gate. Failed swaps are always eligible (no fee is ever
   * owed). Successful swaps are eligible only once every required fee
   * record (platform + token→TON output) is durably completed — read from
   * the fee RECORDS, never from the swap.feeStatus mirror or a return value.
   */
  protected async evaluateGate(record: GasAdvanceRecord): Promise<GasRecoveryGate> {
    const id = record.swapTransactionId;
    const swap: any = await Transaction.findById(id).lean();
    if (!swap) return { eligible: false, reason: 'swap_unresolved' };

    const recs: any[] = await Transaction.find({
      type: 'fee',
      'metadata.feeKey': { $in: [platformFeeKey(id), outputFeeKey(id)] },
    }).lean();
    const byKey = (k: string) => recs.find((r) => r.metadata && r.metadata.feeKey === k);

    return gasRecoveryGate(
      swap,
      { platform: byKey(platformFeeKey(id)), output: byKey(outputFeeKey(id)) },
      Date.now()
    );
  }

  /**
   * Did an earlier clawback land on-chain? Looks at the ADMIN wallet's
   * inbound transactions for an internal message from the advance wallet of
   * ≥ ~amount since the broadcast. Throws on RPC failure (caller must not
   * replace a transfer it could not rule out).
   */
  protected async findLandedRecovery(
    fromAddress: string,
    toAddress: string,
    amount: bigint,
    sinceUtime: number
  ): Promise<boolean> {
    const from = Address.parse(fromAddress).toString({ bounceable: false });
    const txs = await this.tonClient.getTransactions(Address.parse(toAddress), { limit: 100 });
    const floor = amount - amount / 20n;

    for (const tx of txs) {
      if (((tx as any).utime ?? 0) < sinceUtime) continue;
      const im: any = tx.inMessage;
      if (!im || im.info?.type !== 'internal') continue;
      const src = im.info.src?.toString ? im.info.src.toString({ bounceable: false }) : '';
      if (src !== from) continue;
      const value: bigint = im.info.value?.coins ?? 0n;
      if (value < floor) continue;
      const desc: any = tx.description;
      if (desc?.aborted || desc?.computePhase?.success === false) continue;
      return true;
    }
    return false;
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
    // ── ORDERING GATE (successful swaps wait for durable fee settlement) ──
    const gate = await this.evaluateGate(record);
    if (!gate.eligible) {
      const meta0 = ((await Transaction.findById(record.swapTransactionId).lean())?.metadata || {}) as Record<string, any>;
      return {
        status: 'pending',
        recoveredThisAttemptNano: 0n,
        totalRecoveredNano: BigInt(meta0.gasRecoveredAmountNano || '0'),
        pendingNano: BigInt(meta0.gasRecoveryPendingAmountNano || '0'),
        skippedReason: `Gas recovery deferred: ${gate.reason}`,
      };
    }

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

    // Hoisted so the catch path can persist an unconfirmed transfer's
    // tracking ref for re-verification on the next attempt (no double-send).
    let txHash: string | undefined;

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

      /**
       * FIX F — re-verify a previous attempt's UNCONFIRMED transfer before
       * broadcasting a replacement. The old flow threw "not confirmed
       * on-chain" and let the next scheduled tick send a NEW clawback —
       * while the first transfer could still land minutes later. That both
       * delayed recovery (advance sits in the user's wallet, spendable) and
       * risked a double clawback. Now: if the last transfer later landed,
       * credit it here; only if it provably never landed do we replace it.
       */
      const lastTxHash = meta.gasRecoveryLastTxHash as string | undefined;
      if (lastTxHash) {
        // Amount that transfer actually carried (persisted at broadcast).
        // Legacy records without it fall back to the outstanding amount but
        // can never credit more than that.
        const lastAmount = meta.gasRecoveryLastAmountNano
          ? min2(BigInt(meta.gasRecoveryLastAmountNano), stillOwed)
          : stillOwed;
        const broadcastAtMs = meta.gasRecoveryLastBroadcastAt
          ? Date.parse(meta.gasRecoveryLastBroadcastAt)
          : NaN;
        const sinceUtime = Number.isFinite(broadcastAtMs)
          ? Math.floor(broadcastAtMs / 1000) - 120
          : 0;

        // Throws on RPC failure → catch path keeps the ref; never replaces blindly.
        const landed = await this.findLandedRecovery(
          record.walletAddress,
          config.adminFeeWalletAddress,
          lastAmount,
          sinceUtime
        );

        if (landed) {
          const newRecovered = recovered + lastAmount;
          const pendingAfter = advanced > newRecovered + writtenOff
            ? advanced - (newRecovered + writtenOff)
            : 0n;
          await Transaction.create({
            userId: claimed.userId,
            type: 'fee_transfer',
            asset: 'TON',
            amount: lastAmount.toString(),
            status: 'completed',
            toAddress: config.adminFeeWalletAddress,
            txHash: lastTxHash,
            metadata: {
              purpose: 'gas_recovery',
              description: 'Recovery of TON advanced by admin for ATF -> TON swap (late-confirmed transfer)',
              swapTxId: record.swapTransactionId,
              walletAddress: record.walletAddress,
              recoveredAmountNano: lastAmount.toString(),
              gasAdvanceAmountNano: advanced.toString(),
              swapOutcome: meta.swapOutcome || 'unknown',
            },
          });
          await Transaction.updateOne(
            { _id: record.swapTransactionId },
            {
              $unset: {
                'metadata.gasRecoveryLastTxHash': '',
                'metadata.gasRecoveryLastAmountNano': '',
                'metadata.gasRecoveryLastBroadcastAt': '',
              },
            }
          );
          return this.settle(
            claimed,
            pendingAfter > 0n ? 'partial' : 'completed',
            lastAmount,
            newRecovered,
            pendingAfter,
            undefined,
            lastTxHash
          );
        }

        // Not seen yet. A broadcast can still land for a while: replace it
        // only after it is old enough that it provably cannot.
        if (!Number.isFinite(broadcastAtMs) || Date.now() - broadcastAtMs < RECOVERY_REPLACE_AFTER_MS) {
          if (Number.isFinite(broadcastAtMs)) {
            throw new Error(
              `Previous gas recovery transfer (${lastTxHash}) not yet visible on-chain; ` +
              `waiting before any replacement`
            );
          }
        }
        // Old enough and absent on-chain → a replacement is safe below.
      }

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

      // Reserve: only the recovery transfer's own fee + buffers. By the time
      // a successful swap reaches this point every required fee transfer is
      // durably settled (gate above), so no fee-transfer gas needs protecting;
      // a failed swap never owes a fee. (The old blanket +0.1 TON "fee
      // unsettled" reserve starved failed swaps, which never settle a fee.)
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

      txHash = await this.walletService.sendTonFromWalletAddress(
        record.walletAddress,
        config.adminFeeWalletAddress,
        safeRecoverable
      );

      // Persist the broadcast IMMEDIATELY (hash + exact amount + time): a
      // crash/restart from here on is resolved by on-chain lookup, never by
      // a blind second clawback.
      await Transaction.updateOne(
        { _id: record.swapTransactionId },
        {
          $set: {
            'metadata.gasRecoveryLastTxHash': txHash,
            'metadata.gasRecoveryLastAmountNano': safeRecoverable.toString(),
            'metadata.gasRecoveryLastBroadcastAt': new Date().toISOString(),
          },
        }
      );

      const delivered = await this.verifyTonDelivery(
        record.walletAddress,
        config.adminFeeWalletAddress,
        walletBefore,
        adminBefore,
        safeRecoverable
      );

      if (!delivered) {
        // Throw WITHOUT crediting — the catch path resets the claim, stores
        // the tracking ref (FIX F), and the retry job re-attempts. Exactly-once
        // is preserved because gasRecoveredAmountNano was never bumped, and
        // the next attempt re-verifies THIS transfer before replacing it.
        throw new Error(
          `Gas recovery transfer of ${safeRecoverable} nanoTON not ` +
          `confirmed on-chain (tracking ref ${txHash}) — not crediting recovery`
        );
      }

      const newRecovered = recovered + safeRecoverable;
      // FIX G: WAS `advanced - newRecovered + writtenOff` — missing
      // parentheses overstated pending by 2×writtenOff once write-offs
      // exist, making recovery chase money it must not collect.
      const pending = advanced > newRecovered + writtenOff
        ? advanced - (newRecovered + writtenOff)
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

      // A fresh confirmed transfer supersedes any older unconfirmed ref.
      await Transaction.updateOne(
        { _id: record.swapTransactionId },
        {
          $unset: {
            'metadata.gasRecoveryLastTxHash': '',
            'metadata.gasRecoveryLastAmountNano': '',
            'metadata.gasRecoveryLastBroadcastAt': '',
          },
        }
      );

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
        ? advanced - (recovered + writtenOff)
        : 0n;

      await Transaction.findByIdAndUpdate(record.swapTransactionId, {
        $set: {
          'metadata.gasRecoveryStatus': recovered > 0n ? 'partial' : 'pending',
          'metadata.gasRecoveryLastError': error?.message || String(error),
          'metadata.gasRecoveryProcessingAt': null,
          'metadata.gasRecoveryPendingAmountNano': pending.toString(),
          // FIX F: remember the unconfirmed transfer so the next attempt
          // re-verifies it BEFORE broadcasting a replacement.
          ...(txHash ? { 'metadata.gasRecoveryLastTxHash': txHash } : {}),
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
   *
   * FIX F: 30 attempts × 3s = 90s of patience (was 45s) — most transfers
   * that used to time out now confirm in place, so no retry is needed.
   */
  private async verifyTonDelivery(
    fromAddress: string,
    toAddress: string,
    fromBefore: bigint,
    toBefore: bigint,
    amount: bigint
  ): Promise<boolean> {
    const threshold = amount / 2n;

    for (let attempt = 0; attempt < 30; attempt++) {
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
    
