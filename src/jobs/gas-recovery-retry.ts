import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { GasRecoveryService } from '../services/gas-recovery-service';
import { config } from '../config';

export class GasRecoveryRetryJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private gasRecovery = new GasRecoveryService();

  start(): void {
    if (this.timer) return;

    this.tick().catch(err =>
      console.error('[GasRecoveryRetry] Initial tick error:', err)
    );

    this.timer = setInterval(() => {
      this.tick().catch(err =>
        console.error('[GasRecoveryRetry] Tick error:', err)
      );
    }, config.gasRecoveryRetryIntervalMs);

    console.log(
      `[GasRecoveryRetry] Started (interval=${config.gasRecoveryRetryIntervalMs}ms)`
    );
  }

  stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;

    this.running = true;

    try {
      const staleBefore = new Date(
        Date.now() - config.gasRecoveryProcessingTimeoutMs
      );

      // Reopen only genuinely stale processing records.
      // Never reopen completed recovery records.
      await Transaction.updateMany(
        {
          type: 'swap',
          'metadata.gasRecoveryStatus': 'processing',
          'metadata.gasRecoveryPendingAmountNano': {
            $nin: ['0', 0, null],
          },
          $or: [
            {
              'metadata.gasRecoveryProcessingAt': {
                $lte: staleBefore,
              },
            },
            {
              'metadata.gasRecoveryProcessingAt': {
                $exists: false,
              },
            },
          ],
        },
        {
          $set: {
            'metadata.gasRecoveryStatus': 'partial',
            'metadata.gasRecoveryLastError':
              'Previous recovery worker stopped before completing; recovery reopened automatically.',
            'metadata.gasRecoveryProcessingAt': null,
          },
        }
      );

      // Select only unfinished recoveries with a positive pending amount.
      // Legacy records without a pending amount remain eligible.
      const candidates = await Transaction.find({
        type: 'swap',
        'metadata.gasRecoveryStatus': {
          $in: ['pending', 'partial'],
        },
        $or: [
          {
            'metadata.gasRecoveryPendingAmountNano': {
              $exists: false,
            },
          },
          {
            'metadata.gasRecoveryPendingAmountNano': {
              $nin: ['0', 0, null],
            },
          },
        ],
        // ── FEE FIRST ── The ATF platform fee transfer needs ~0.1 TON
        // attached. Clawing back before the fee settles starves the fee
        // (previously masked by the recovery confirmation bug: recovery
        // failed → wallet kept TON → fee worked). Swaps with no platform
        // fee ('0'/missing — includes failed swaps) stay eligible.
        $or: [
          { fee: { $in: ['0', 0, null] } },
          { fee: { $exists: false } },
          { feeStatus: 'completed' },
        ],
      })
        .sort({ createdAt: 1 })
        .limit(25)
        .lean();

      for (const swap of candidates) {
        try {
          const metadata = (swap.metadata || {}) as Record<string, any>;

          // Completed means terminal: never retry it.
          if (metadata.gasRecoveryStatus === 'completed') {
            continue;
          }

          const pendingRaw =
            metadata.gasRecoveryPendingAmountNano;

          if (
            pendingRaw !== undefined &&
            pendingRaw !== null &&
            BigInt(String(pendingRaw)) <= 0n
          ) {
            continue;
          }

          const user = await User.findById(swap.userId).lean();

          if (!user) {
            console.error(
              `[GasRecoveryRetry] User not found for swap ${swap._id}`
            );
            continue;
          }

          const telegramId = user.telegramId;

          // Always use the wallet that received the company gas advance.
          let walletAddress = metadata.gasRecoveryWalletAddress as
            | string
            | undefined;

          // Backward compatibility for older records.
          if (!walletAddress) {
            const gasAdvance = await Transaction.findOne({
              type: 'fee_transfer',
              'metadata.purpose': 'gas_advance',
              'metadata.swapTxId': swap._id.toString(),
            })
              .select('toAddress')
              .lean();

            walletAddress = gasAdvance?.toAddress || undefined;
          }

          if (!walletAddress) {
            console.error(
              `[GasRecoveryRetry] Cannot resolve original gas wallet for swap ${swap._id}`
            );
            continue;
          }

          const result = await this.gasRecovery.recoverAdminGasSafely({
            swapTransactionId: swap._id.toString(),
            userId: telegramId,
            walletAddress,
          });

          if (
            result.recoveredThisAttemptNano > 0n ||
            result.status !== 'completed'
          ) {
            console.log(
              `[GasRecoveryRetry] Swap ${swap._id}: ` +
                `status=${result.status}, ` +
                `recovered=${result.recoveredThisAttemptNano} nanoTON, ` +
                `total=${result.totalRecoveredNano} nanoTON, ` +
                `pending=${result.pendingNano} nanoTON` +
                (result.skippedReason
                  ? ` (${result.skippedReason})`
                  : '')
            );
          }
        } catch (err) {
          console.error(
            `[GasRecoveryRetry] Failed for swap ${swap._id}:`,
            err
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
              }
