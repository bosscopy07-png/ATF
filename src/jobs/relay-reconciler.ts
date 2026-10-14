import { TransferRelayService } from '../services/transfer-relay-service';
import { config } from '../config';

/**
 * Reconciles interrupted relay operations every 30s.
 * Safe across multiple workers: each op transitions are atomic
 * (findOneAndUpdate / updateOne), and the per-address locks in
 * TransferRelayService prevent double-execution.
 */
export class RelayReconcilerJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (!config.features.transferRelay) {
      console.log('[RelayReconciler] disabled by feature flag');
      return;
    }
    this.timer = setInterval(() => this.tick(), 30_000);
    console.log('[RelayReconciler] started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const service = new TransferRelayService();
      const { resumed, flagged } = await service.reconcileStale();
      if (resumed || flagged) {
        console.log(`[RelayReconciler] resumed=${resumed} flagged=${flagged}`);
      }
    } catch (err) {
      console.error('[RelayReconciler] tick error:', (err as Error).message);
    } finally {
      this.running = false;
    }
  }
}
