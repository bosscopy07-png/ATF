/**
 * fee-record-policy — the single source of truth for platform-fee-record
 * idempotency. The semantics in this file are frozen by the Node regression
 * test (fee-policy.node-test.mjs), which exercises the compiled
 * fee-record-policy.js counterpart of this module without a database or RPC.
 *
 * Fee record lifecycle (type 'fee', one canonical record per swap+feeKind):
 *
 *   status: 'pending'    → never broadcast. Claimable.
 *   status: 'processing' → claimed, outcome unknown (in-process only; a
 *                          stale lock is reclaimed to 'uncertain', NEVER
 *                          straight to re-broadcast).
 *   status: 'completed'  → DELIVERED, real txHash persisted. TERMINAL.
 *   status: 'failed'     + metadata.feeOutcome:
 *       'pre_broadcast'  → definitive failure BEFORE any broadcast (e.g.
 *                          insufficient TON for gas). Retryable: bounded
 *                          attempts + cooldown + gas pre-check.
 *       'bounced'        → confirmed on-chain bounce/failure of a broadcast
 *                          transfer. Retryable under the same policy.
 *       'uncertain'      → broadcast may have happened, outcome unknown.
 *                          NEVER auto-retried. Reconciliation only.
 *
 * swap.feeStatus / swap.feeTxHash are MIRRORS of this record, never the
 * trigger for broadcasting. A placeholder `fee-pending-<swapId>` txHash is
 * proof of NO persisted broadcast, never proof of delivery.
 */

export const FEE_MAX_ATTEMPTS = 5;
export const FEE_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
/** A 'processing' lock older than this is presumed a crashed worker. */
export const FEE_PROCESSING_TTL_MS = 15 * 60 * 1000;
/** Hash-less 'uncertain' records older than this may be downgraded to a
 *  bounded, pre-broadcast retry after a full wallet scan finds nothing. */
export const FEE_UNCERTAIN_GRACE_MS = 60 * 60 * 1000;
/** TON the user wallet must hold to attach gas to a jetton fee transfer. */
export const MIN_TON_FOR_JETTON_FEE_NANO = BigInt(150_000_000); // 0.15 TON

export const PLACEHOLDER_PREFIX = 'fee-pending-';

export const FEE_OUTCOME = {
  PRE_BROADCAST: 'pre_broadcast',
  BOUNCED: 'bounced',
  UNCERTAIN: 'uncertain',
} as const;
export type FeeOutcome = (typeof FEE_OUTCOME)[keyof typeof FEE_OUTCOME];

export const FEE_KIND = {
  SWAP_PLATFORM_FEE: 'swap_platform_fee',
  SWAP_TON_OUTPUT_FEE: 'swap_ton_output_fee',
} as const;

export function placeholderFor(swapId: string): string {
  return PLACEHOLDER_PREFIX + swapId;
}

/**
 * A missing hash or the `fee-pending-*` placeholder means NO broadcast was
 * persisted. Callers must never treat a non-placeholder arbitrary string as
 * proof of delivery either — delivery requires on-chain verification.
 */
export function isPlaceholderTxHash(txHash: unknown, _swapId?: string): boolean {
  if (typeof txHash !== 'string' || txHash === '') return true;
  return txHash.startsWith(PLACEHOLDER_PREFIX);
}

export function attemptsOf(doc: any): number {
  const a = doc && doc.metadata ? doc.metadata.attempts : undefined;
  return typeof a === 'number' ? a : 0;
}

export function feeOutcomeOf(doc: any): FeeOutcome | undefined {
  return (doc && doc.metadata && doc.metadata.feeOutcome) || undefined;
}

export function nextRetryAtFrom(nowMs: number): Date {
  return new Date(nowMs + FEE_RETRY_COOLDOWN_MS);
}

export function isRetryableOutcome(outcome: FeeOutcome | undefined): boolean {
  return outcome === FEE_OUTCOME.PRE_BROADCAST || outcome === FEE_OUTCOME.BOUNCED;
}

export type ClaimBlockReason =
  | 'completed'
  | 'uncertain'
  | 'in_flight'
  | 'cooldown'
  | 'max_attempts'
  | 'unresolved'
  | 'invalid'
  | null;

/**
 * The single authority for "may this fee record be broadcast right now".
 * Returns null when claimable, otherwise a stable machine-readable reason.
 */
export function getClaimBlockReason(doc: any, nowMs: number, swapId?: string): ClaimBlockReason {
  if (!doc) return 'invalid';
  const status = doc.status;
  const outcome = feeOutcomeOf(doc);

  if (status === 'completed') return 'completed';
  if (status === 'failed' && outcome === FEE_OUTCOME.UNCERTAIN) return 'uncertain';
  if (status === 'processing') return 'in_flight';
  if (status === 'failed') {
    if (!isRetryableOutcome(outcome)) return 'unresolved';
    const due = !doc.metadata.nextRetryAt || Date.parse(doc.metadata.nextRetryAt) <= nowMs;
    if (!due) return 'cooldown';
  } else if (status !== 'pending') {
    return 'invalid';
  }
  // pending but a REAL hash was persisted → a worker crashed after
  // broadcasting, before resolving. Never re-broadcast; reconcile instead.
  if (status === 'pending' && !isPlaceholderTxHash(doc.txHash, swapId)) {
    return 'unresolved';
  }
  if (attemptsOf(doc) >= FEE_MAX_ATTEMPTS) return 'max_attempts';
  return null;
}

export function isClaimableFeeRecord(doc: any, nowMs: number, swapId?: string): boolean {
  return getClaimBlockReason(doc, nowMs, swapId) === null;
}

/**
 * Mongo filter for the atomic claim. Semantics MUST match
 * getClaimBlockReason — the Node regression test asserts both against each
 * other across every reachable document state.
 */
export function buildClaimFilter(docId: any, now: Date, swapId: string): any {
  return {
    _id: docId,
    $and: [
      {
        $or: [
          // Never broadcast (placeholder proves nothing was persisted).
          { status: 'pending', txHash: placeholderFor(swapId) },
          // Definitive pre-broadcast failure or CONFIRMED bounce, cooldown due.
          {
            status: 'failed',
            'metadata.feeOutcome': { $in: [FEE_OUTCOME.PRE_BROADCAST, FEE_OUTCOME.BOUNCED] },
            'metadata.nextRetryAt': { $lte: now },
          },
          {
            status: 'failed',
            'metadata.feeOutcome': { $in: [FEE_OUTCOME.PRE_BROADCAST, FEE_OUTCOME.BOUNCED] },
            'metadata.nextRetryAt': { $exists: false },
          },
        ],
      },
      {
        $or: [
          { 'metadata.attempts': { $lt: FEE_MAX_ATTEMPTS } },
          { 'metadata.attempts': { $exists: false } },
        ],
      },
    ],
  };
}

/** From-state guard for completion writes: only an in-flight worker may
 *  complete, and a completed record can never be reversed. */
export function buildCompletionGuard(): any {
  return { status: 'processing' };
}

/** From-state guard for reconciliation resolving ambiguous records. */
export function buildResolveGuard(): any {
  return {
    $or: [
      { status: 'processing' },
      { status: 'failed', 'metadata.feeOutcome': FEE_OUTCOME.UNCERTAIN },
    ],
  };
}

/**
 * Classify a sendJetton/sendTon rejection.
 *  - 'pre_broadcast': the node definitively refused BEFORE anything hit the
 *    chain (e.g. insufficient TON for gas). Safe to retry under policy.
 *  - 'uncertain': anything else — timeout, reset, or an unrecognised error.
 *    The transfer may or may not have been broadcast: NEVER auto-retry.
 * NOTE: a consumed wallet seqno is NOT proof of delivery and NOT proof of
 * failure; both require on-chain verification.
 */
export function classifyBroadcastError(message: string): { kind: FeeOutcome } {
  const msg = String(message || '');
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|aborted|socket|unreachable|EAI_AGAIN|status 5\d\d/i.test(msg)) {
    return { kind: FEE_OUTCOME.UNCERTAIN };
  }
  if (/not enough|insufficient|balance is too low|no gas|not sufficient funds|exit code 37|account not found|invalid seqno/i.test(msg)) {
    return { kind: FEE_OUTCOME.PRE_BROADCAST };
  }
  return { kind: FEE_OUTCOME.UNCERTAIN };
}
