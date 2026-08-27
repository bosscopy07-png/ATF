import { BlockchainMonitor } from './services/blockchain-monitor';
import { startReconciler } from './jobs/reconciler';

/**
 * Background Worker
 * 
 * Responsibilities:
 * - BlockchainMonitor: Poll for TON + AFT deposits every 30s
 * - Reconciler: Confirm swaps/withdrawals/fees on-chain every 30s
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

  console.log('AFTSwap Background Worker is operational');
}
