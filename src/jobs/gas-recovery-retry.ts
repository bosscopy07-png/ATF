import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { WalletService } from '../services/wallet-service';
import { GasRecoveryService } from '../services/gas-recovery-service';
import { config } from '../config';

/**
 * Retry worker for TON admin gas recovery (Part C of the gas-recovery
 * design). Picks up swap transactions where recovery previously could only
 * be partial, or couldn't safely happen at all, and tries again — using the
 * SAME centralized, idempotent `GasRecoveryService`, so it can never recover
 * more than was actually advanced and can never double-send.
 */
export class GasRecoveryRetryJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private gasRecovery = new GasRecoveryService();
  private walletService = new WalletService();

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(err => console.error('[GasRecoveryRetry] Tick error:', err));
    }, config.gasRecoveryRetryIntervalMs);
    console.log(`[GasRecoveryRetry] Started (interval=${config.gasRecoveryRetryIntervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const candidates = await Transaction.find({
        type: 'swap',
        'metadata.gasRecoveryStatus': { $in: ['pending', 'partial'] },
      })
        .limit(25)
        .lean();

      for (const swap of candidates) {
        try {
          const user = await User.findById(swap.userId).lean();
          if (!user) continue;

          const telegramId = (user as any).telegramId;
          // Same resolution path the swap itself used — the user's
          // currently active wallet — not an arbitrary wallet doc.
          const walletAddress = await this.walletService.getAddress(telegramId);
          if (!walletAddress) continue;

          const result = await this.gasRecovery.recoverAdminGasSafely({
            swapTransactionId: swap._id.toString(),
            userId: telegramId,
            walletAddress,
          });

          if (result.recoveredThisAttemptNano > 0n) {
            console.log(
              `[GasRecoveryRetry] Swap ${swap._id}: recovered ${result.recoveredThisAttemptNano} nanoTON, ` +
                `status=${result.status}, pending=${result.pendingNano}`
            );
          }
        } catch (err) {
          console.error(`[GasRecoveryRetry] Failed for swap ${swap._id}:`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
