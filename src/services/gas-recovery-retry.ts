/**
 * Backward-compatible export.
 *
 * The live worker uses src/jobs/gas-recovery-retry.ts. Keeping this module as
 * a re-export prevents the old duplicate implementation from drifting and,
 * importantly, prevents an accidental future import from using wallet
 * resolution logic that does not honor the exact recovery wallet address.
 */
export { GasRecoveryRetryJob } from '../jobs/gas-recovery-retry';
