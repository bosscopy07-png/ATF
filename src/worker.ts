import { BlockchainMonitor } from './services/blockchain-monitor';
import { startReconciler } from './jobs/reconciler';
import { GasRecoveryRetryJob } from './jobs/gas-recovery-retry';
// ── PHASE 4 addition ──
import { RelayReconcilerJob } from './jobs/relay-reconciler';

/**
 * Background Worker
 *
 * Responsibilities:
 * - BlockchainMonitor: Poll for TON + AFT deposits every 30s
 * - Reconciler: Confirm swaps/withdrawals/fees on-chain every 30s
 * - GasRecoveryRetryJob: Retry pending/partial admin gas recoveries
 * - RelayReconcilerJob: Resume interrupted relay ops (feature-gated)
 *
 * Does NOT run:
 * - Express HTTP server
 * - Telegram webhook/polling
 * - Admin dashboard
 */

export async function startWorker(): Promise<void> {
  console.log('Starting background worker...');

  // Start blockchain deposit monitor
  const monitor = new BlockchainMonitor();
  monitor.start();
  console.log('Blockchain monitor started');

  // Start reconciler (swap confirmation, fee recovery, rollback)
  await startReconciler();
  console.log('Reconciler started');

  // Start gas recovery retry job (picks up pending/partial TON admin
  // gas-advance recoveries and safely retries them via GasRecoveryService)
  const gasRecoveryRetry = new GasRecoveryRetryJob();
  gasRecoveryRetry.start();
  console.log('Gas recovery retry job started');

  // ── PHASE 4 addition: relay reconciler (no-ops when flag is off) ──
  const relayReconciler = new RelayReconcilerJob();
  relayReconciler.start();
  console.log('Relay reconciler started');

  console.log('AFTSwap Background Worker is operational');
}
