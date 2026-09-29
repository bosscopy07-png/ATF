import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { GasRecoveryService } from '../services/gas-recovery-service';
import { config } from '../config';

/**
 * Background worker for pending/partial TON gas recoveries.
 *
 * This worker is deliberately based on the recorded gas-recovery wallet,
 * NOT the user's current active wallet.
 */
export class GasRecoveryRetryJob {
  private timer:
    NodeJS.Timeout | null = null;

  private running = false;

  private gasRecovery =
    new GasRecoveryService();

  start(): void {
    if (this.timer) {
      return;
    }

    /**
     * Run once immediately when the worker starts.
     */
    this.tick().catch(
      err =>
        console.error(
          '[GasRecoveryRetry] Initial tick error:',
          err
        )
    );

    this.timer =
      setInterval(
        () => {
          this.tick().catch(
            err =>
              console.error(
                '[GasRecoveryRetry] Tick error:',
                err
              )
          );
        },
        config.gasRecoveryRetryIntervalMs
      );

    console.log(
      `[GasRecoveryRetry] Started (interval=${config.gasRecoveryRetryIntervalMs}ms)`
    );
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);

    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const staleBefore =
        new Date(
          Date.now() -
            config.gasRecoveryProcessingTimeoutMs
        );

      /**
       * A worker can crash after changing recovery status to
       * "processing".
       *
       * Reopen stale processing records so they don't remain
       * permanently stuck.
       */
      await Transaction.updateMany(
        {
          type: 'swap',

          'metadata.gasRecoveryStatus':
            'processing',

          $or: [
            {
              'metadata.gasRecoveryProcessingAt':
                {
                  $lte:
                    staleBefore,
                },
            },
            {
              'metadata.gasRecoveryProcessingAt':
                {
                  $exists:
                    false,
                },
            },
          ],
        },
        {
          $set: {
            'metadata.gasRecoveryStatus':
              'partial',

            'metadata.gasRecoveryLastError':
              'Previous recovery worker stopped before completing; recovery reopened automatically.',

            'metadata.gasRecoveryProcessingAt':
              null,
          },
        }
      );

      /**
       * Oldest recovery first.
       */
      const candidates =
        await Transaction.find({
          type: 'swap',

          $or: [
            {
              'metadata.gasRecoveryStatus':
                {
                  $in: [
                    'pending',
                    'partial',
                  ],
                },
            },

            {
              'metadata.gasRecoveryStatus':
                'processing',

              'metadata.gasRecoveryProcessingAt':
                {
                  $lte:
                    staleBefore,
                },
            },
          ],
        })
          .sort({
            createdAt: 1,
          })
          .limit(25)
          .lean();

      for (const swap of candidates) {
        try {
          const user =
            await User.findById(
              swap.userId
            ).lean();

          if (!user) {
            continue;
          }

          const telegramId =
            user.telegramId;

          const metadata =
            (swap.metadata || {}) as Record<
              string,
              any
            >;

          /**
           * CRITICAL:
           *
           * Always recover from the wallet that received
           * the company gas advance.
           */
          let walletAddress =
            metadata.gasRecoveryWalletAddress as
              | string
              | undefined;

          /**
           * Backward compatibility for records created
           * before gasRecoveryWalletAddress existed.
           */
          if (!walletAddress) {
            const gasAdvance =
              await Transaction.findOne({
                type: 'fee_transfer',

                'metadata.purpose':
                  'gas_advance',

                'metadata.swapTxId':
                  swap._id.toString(),
              })
                .select(
                  'toAddress'
                )
                .lean();

            walletAddress =
              gasAdvance?.toAddress ||
              undefined;
          }

          if (!walletAddress) {
            console.error(
              `[GasRecoveryRetry] Cannot resolve original gas wallet for swap ${swap._id}`
            );

            continue;
          }

          const result =
            await this.gasRecovery
              .recoverAdminGasSafely({
                swapTransactionId:
                  swap._id.toString(),

                userId:
                  telegramId,

                walletAddress,
              });

          if (
            result.recoveredThisAttemptNano >
              0n ||
            result.status !==
              'completed'
          ) {
            console.log(
              `[GasRecoveryRetry] Swap ${swap._id}: ` +
                `status=${result.status}, ` +
                `recovered=${result.recoveredThisAttemptNano} nanoTON, ` +
                `total=${result.totalRecoveredNano} nanoTON, ` +
                `pending=${result.pendingNano} nanoTON` +
                (
                  result.skippedReason
                    ? ` (${result.skippedReason})`
                    : ''
                )
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
