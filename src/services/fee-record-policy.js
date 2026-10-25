/**
 * fee-record-policy — the single source of truth for platform-fee-record
 * idempotency. Dependency-free on purpose: it is imported by
 * fee-collection-service.ts (via fee-record-policy.d.ts) AND exercised
 * directly by the Node regression test (fee-policy.node-test.mjs), so the
 * exact claim/transition semantics that prevent duplicate fee broadcasts are
 * tested without a database or RPC.
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
'use strict';

const FEE_MAX_ATTEMPTS = 5;
const FEE_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
/** A 'processing' lock older than this is presumed a crashed worker. */
const FEE_PROCESSING_TTL_MS = 15 * 60 * 1000;
/** Hash-less 'uncertain' records older than this may be downgraded to a
 *  bounded, pre-broadcast retry after a full wallet scan finds nothing. */
const FEE_UNCERTAIN_GRACE_MS = 60 * 60 * 1000;
/** TON the user wallet must hold to attach gas to a jetton fee transfer. */
const MIN_TON_FOR_JETTON_FEE_NANO = 150000000n; // 0.15 TON

const PLACEHOLDER_PREFIX = 'fee-pending-';

const FEE_OUTCOME = Object.freeze({
  PRE_BROADCAST: 'pre_broadcast',
  BOUNCED: 'bounced',
  UNCERTAIN: 'uncertain',
});

const FEE_KIND = Object.freeze({
  SWAP_PLATFORM_FEE: 'swap_platform_fee',
  SWAP_TON_OUTPUT_FEE: 'swap_ton_output_fee',
});

function placeholderFor(swapId) {
  return PLACEHOLDER_PREFIX + swapId;
}

/**
 * A missing hash or the `fee-pending-*` placeholder means NO broadcast was
 * persisted. Callers must never treat a non-placeholder arbitrary string as
 * proof of delivery either — delivery requires on-chain verification.
 */
function isPlaceholderTxHash(txHash, swapId) {
  if (typeof txHash !== 'string' || txHash === '') return true;
  return txHash.startsWith(PLACEHOLDER_PREFIX);
}

function attemptsOf(doc) {
  const a = doc && doc.metadata ? doc.metadata.attempts : undefined;
  return typeof a === 'number' ? a : 0;
}

function feeOutcomeOf(doc) {
  return (doc && doc.metadata && doc.metadata.feeOutcome) || undefined;
}

function nextRetryAtFrom(nowMs) {
  return new Date(nowMs + FEE_RETRY_COOLDOWN_MS);
}

function isRetryableOutcome(outcome) {
  return outcome === FEE_OUTCOME.PRE_BROADCAST || outcome === FEE_OUTCOME.BOUNCED;
}

/**
 * The single authority for "may this fee record be broadcast right now".
 * Returns null when claimable, otherwise a stable machine-readable reason:
 *   'completed' | 'uncertain' | 'in_flight' | 'cooldown' |
 *   'max_attempts' | 'unresolved' | 'invalid'
 */
function getClaimBlockReason(doc, nowMs, swapId) {
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

function isClaimableFeeRecord(doc, nowMs, swapId) {
  return getClaimBlockReason(doc, nowMs, swapId) === null;
}

/**
 * Mongo filter for the atomic claim. Semantics MUST match
 * getClaimBlockReason — the Node regression test asserts both against each
 * other across every reachable document state (see fee-policy.node-test.mjs).
 */
function buildClaimFilter(docId, now, swapId) {
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
function buildCompletionGuard() {
  return { status: 'processing' };
}

/** From-state guard for reconciliation resolving ambiguous records. */
function buildResolveGuard() {
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
function classifyBroadcastError(message) {
  const msg = String(message || '');
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|aborted|socket|unreachable|EAI_AGAIN|status 5\d\d/i.test(msg)) {
    return { kind: FEE_OUTCOME.UNCERTAIN };
  }
  if (/not enough|insufficient|balance is too low|no gas|not sufficient funds|exit code 37|account not found|invalid seqno/i.test(msg)) {
    return { kind: FEE_OUTCOME.PRE_BROADCAST };
  }
  return { kind: FEE_OUTCOME.UNCERTAIN };
}

module.exports = {
  FEE_MAX_ATTEMPTS,
  FEE_RETRY_COOLDOWN_MS,
  FEE_PROCESSING_TTL_MS,
  FEE_UNCERTAIN_GRACE_MS,
  MIN_TON_FOR_JETTON_FEE_NANO,
  PLACEHOLDER_PREFIX,
  FEE_OUTCOME,
  FEE_KIND,
  placeholderFor,
  isPlaceholderTxHash,
  attemptsOf,
  feeOutcomeOf,
  nextRetryAtFrom,
  isRetryableOutcome,
  getClaimBlockReason,
  isClaimableFeeRecord,
  buildClaimFilter,
  buildCompletionGuard,
  buildResolveGuard,
  classifyBroadcastError,
};
            /**
 * Type declarations for ./fee-record-policy.js (the dependency-free
 * idempotency core shared with the executable Node regression test).
 * If the project disallows JS imports from TS, port fee-record-policy.js to
 * TS mechanically — the semantics are frozen by fee-policy.node-test.mjs.
 */
export const FEE_MAX_ATTEMPTS: number;
export const FEE_RETRY_COOLDOWN_MS: number;
export const FEE_PROCESSING_TTL_MS: number;
export const FEE_UNCERTAIN_GRACE_MS: number;
export const MIN_TON_FOR_JETTON_FEE_NANO: bigint;
export const PLACEHOLDER_PREFIX: string;

export const FEE_OUTCOME: {
  readonly PRE_BROADCAST: 'pre_broadcast';
  readonly BOUNCED: 'bounced';
  readonly UNCERTAIN: 'uncertain';
};
export const FEE_KIND: {
  readonly SWAP_PLATFORM_FEE: 'swap_platform_fee';
  readonly SWAP_TON_OUTPUT_FEE: 'swap_ton_output_fee';
};

export function placeholderFor(swapId: string): string;
export function isPlaceholderTxHash(txHash: unknown, swapId?: string): boolean;
export function attemptsOf(doc: any): number;
export function feeOutcomeOf(doc: any): string | undefined;
export function nextRetryAtFrom(nowMs: number): Date;
export function isRetryableOutcome(outcome: string | undefined): boolean;
export function getClaimBlockReason(
  doc: any,
  nowMs: number,
  swapId?: string
): 'completed' | 'uncertain' | 'in_flight' | 'cooldown' | 'max_attempts' | 'unresolved' | 'invalid' | null;
export function isClaimableFeeRecord(doc: any, nowMs: number, swapId?: string): boolean;
export function buildClaimFilter(docId: any, now: Date, swapId: string): any;
export function buildCompletionGuard(): any;
export function buildResolveGuard(): any;
export function classifyBroadcastError(message: string): { kind: 'pre_broadcast' | 'uncertain' };
