/**
 * multi-token-swap-policy — pure decision helpers (no SDK / DB / RPC) for the
 * TON → TOKEN and TOKEN → TON swaps. Kept dependency-free so every decision
 * is unit-testable with fixtures.
 *
 * Nothing here ever reports success from a broadcast. Success is only ever
 * derived from on-chain evidence (balances + the wallet transaction).
 *
 * The TON ↔ ATF decision helpers live in swap-output-policy.ts and are NOT
 * touched or reused here: the multi-token flow is deliberately isolated.
 */

export type MultiTokenDirection = 'ton_to_token' | 'token_to_ton';

export function isMultiTokenDirection(value: unknown): value is MultiTokenDirection {
  return value === 'ton_to_token' || value === 'token_to_ton';
}

/** True when a swap's metadata marks it as owned by the multi-token flow. */
export function isMultiTokenSwapMeta(meta: any): boolean {
  return !!meta && isMultiTokenDirection(meta.swapDirection);
}

/* ─────────────────────────────────────────────
   TIMING (ms) — conservative on purpose: a wrong
   "failed" verdict forfeits the platform fee and
   triggers recovery, a late "success" costs nothing.
   ───────────────────────────────────────────── */

export const MT_TIMING = {
  /** token → TON: jettons must stay gone this long (refund window) before success.
   *  10s = the window the live ATF flow already uses; was 30s (the main delay). */
  tokenSettleMs: 10_000,
  /** token → TON: jettons still in the wallet this long after broadcast → failed. */
  tokenNotConsumedFailMs: 90_000,
  /** TON → token: no output token this long after broadcast → failed. */
  noOutputFailMs: 180_000,
  /**
   * External messages from our wallets expire 60s after signing. After this
   * long, a message that never produced a wallet transaction can never land.
   */
  messageDeadMs: 180_000,
} as const;

/* ─────────────────────────────────────────────
   WALLET TRANSACTION EVIDENCE
   ───────────────────────────────────────────── */

export type MtWalletTxEvidence =
  /** RPC failure / could not read history — NEVER treated as "not found". */
  | { state: 'unreadable' }
  /** History read fine but our swap message is not in it (yet). */
  | { state: 'not_found' }
  | {
      state: 'found';
      /** wallet tx aborted or its compute/action phase failed */
      failed: boolean;
      /** outbound message count of the wallet tx, null if unreadable */
      outMessages: number | null;
    };

export interface MtOutcomeEvidence {
  direction: MultiTokenDirection;
  ageMs: number;
  /** true when the broadcast response was uncertain (no real tx hash known) */
  broadcastUncertain: boolean;
  tx: MtWalletTxEvidence;

  /** Min output enforced by the DEX contract (base units of the output asset). */
  minOutputBase: bigint;

  /** Token balances of the TOKEN asset (jetton) in the user's wallet. null = unreadable. */
  preTokenBase: bigint;
  nowTokenBase: bigint | null;

  /** TOKEN → TON only: net jetton amount sent into the DEX (quote.offerUnits). */
  expectedTokenInBase: bigint;
}

export interface MtOutcomeVerdict {
  status: 'success' | 'failed' | 'pending';
  /** Proven output in output-asset base units (0 when not proven). */
  actualOutputBase: bigint;
  method: string;
}

/**
 * Decide what a multi-token swap actually did.
 *
 * ORDER OF AUTHORITY: token-side evidence first. A wallet-transaction flag
 * can only ever contribute a FAILURE verdict when the token side shows the
 * swap did not execute — a wallet tx that merely looks failed must never
 * override tokens that actually moved (the same lesson the ATF reconciler
 * learned: "the wallet-tx check can read failed even though the swap ran").
 *
 * TON → TOKEN
 *   success : token balance rose by ≥ minOutput (the DEX guarantees ≥ min).
 *             actualOutput = the OBSERVED token increase (exact, not a bound).
 *   failed  : no output AND (our wallet tx aborted / sent no outbound
 *             message, or nothing arrived within noOutputFailMs).
 *
 * TOKEN → TON
 *   success : ≥99% of the net jetton input left the wallet and stayed gone
 *             for the refund window. STON.fi either executes (output ≥ min,
 *             enforced on-chain) or refunds the jettons — so "left and not
 *             back" is proof of execution. actualOutput is the
 *             contract-guaranteed minimum: a PROVEN LOWER BOUND, labelled.
 *   failed  : jettons did not leave AND (our wallet tx aborted / sent no
 *             outbound message, or the jettons never left in time).
 *
 * `tx` is only ever 'found' for OUR external wallet transaction (matched by
 * hash AND external-in, or by an outbound message to the router), so an
 * unrelated tx can never produce a failure verdict.
 *
 * Unreadable evidence is always 'pending' — never a verdict.
 */
export function evaluateMultiTokenOutcome(e: MtOutcomeEvidence): MtOutcomeVerdict {
  const pending = (method: string, out = 0n): MtOutcomeVerdict => ({
    status: 'pending',
    actualOutputBase: out,
    method,
  });
  const failed = (method: string): MtOutcomeVerdict => ({
    status: 'failed',
    actualOutputBase: 0n,
    method,
  });

  if (e.nowTokenBase === null) {
    return pending('token_balance_unreadable');
  }

  const walletTxDead =
    e.tx.state === 'found' && (e.tx.failed || e.tx.outMessages === 0);

  if (e.direction === 'ton_to_token') {
    const delta = e.nowTokenBase > e.preTokenBase ? e.nowTokenBase - e.preTokenBase : 0n;

    if (e.minOutputBase > 0n && delta >= e.minOutputBase) {
      return { status: 'success', actualOutputBase: delta, method: 'token_balance_delta' };
    }

    if (walletTxDead && delta === 0n) {
      return failed(e.tx.state === 'found' && e.tx.failed ? 'wallet_tx_failed' : 'no_swap_message_sent');
    }

    if (e.tx.state === 'not_found') {
      // Our message never produced a wallet transaction. It expires after
      // ~60s, so after messageDeadMs it can never land.
      if (delta === 0n && e.ageMs >= MT_TIMING.messageDeadMs) return failed('message_never_consumed');
      return pending('waiting_for_wallet_tx', delta);
    }
    if (e.tx.state === 'unreadable') return pending('wallet_tx_unreadable', delta);

    if (e.ageMs < MT_TIMING.noOutputFailMs) return pending('waiting', delta);
    if (delta === 0n) return failed('timeout_no_token_output');
    // Some tokens arrived but < min: neither proof of success nor failure.
    return pending('inconclusive_partial_token_gain', delta);
  }

  // ── TOKEN → TON
  const expected = e.expectedTokenInBase;
  const drop = e.preTokenBase > e.nowTokenBase ? e.preTokenBase - e.nowTokenBase : 0n;

  if (expected > 0n && drop * 100n >= expected * 99n) {
    if (e.ageMs < MT_TIMING.tokenSettleMs) return pending('token_left_waiting_refund_window');
    // Token proof is independent of the wallet tx — sufficient on its own.
    return {
      status: 'success',
      actualOutputBase: e.minOutputBase,
      method: 'token_consumed_min_output_guaranteed',
    };
  }

  const notLeft = expected > 0n ? drop * 100n <= expected : drop === 0n;
  if (notLeft) {
    if (walletTxDead) {
      return failed(e.tx.state === 'found' && e.tx.failed ? 'wallet_tx_failed' : 'no_swap_message_sent');
    }
    if (e.tx.state === 'not_found' && e.ageMs >= MT_TIMING.messageDeadMs) {
      return failed('message_never_consumed');
    }
    if (e.tx.state === 'found' && e.ageMs >= MT_TIMING.tokenNotConsumedFailMs) {
      return failed('token_not_consumed');
    }
    return pending('token_waiting_to_leave');
  }

  return pending('token_partial_or_waiting');
}

/* ─────────────────────────────────────────────
   FUNDING / ADVANCE
   ───────────────────────────────────────────── */

/**
 * TON the platform must advance so the swap message can be sent.
 *
 * Only a TOKEN → TON swap ever receives an advance (it needs ~0.3 TON of
 * gas attached and users typically hold none — same policy as ATF → TON).
 * TON → TOKEN is paid from the user's own TON and never advanced.
 *
 * The advance is the SHORTFALL only: TON the user already holds is never
 * "advanced", so it can never be recovered as if it were platform money.
 */
export function computeAdvanceNano(args: {
  direction: MultiTokenDirection;
  swapValueNano: bigint;
  reserveNano: bigint;
  walletTonNano: bigint;
  maxAdvanceNano: bigint;
}): { advanceNano: bigint; error?: string } {
  if (args.direction !== 'token_to_ton') return { advanceNano: 0n };

  const required = args.swapValueNano + args.reserveNano;
  const shortfall = required > args.walletTonNano ? required - args.walletTonNano : 0n;

  if (shortfall > args.maxAdvanceNano) {
    return {
      advanceNano: 0n,
      error: 'The network gas for this swap is higher than the platform will advance. Try again later.',
    };
  }
  return { advanceNano: shortfall };
}

/** Uncertain broadcast classifier (mirrors the wallet-service/fee-service regexes). */
export function isUncertainBroadcastMessage(message: string): boolean {
  return /BROADCAST_OUTCOME_UNKNOWN|Broadcast outcome unknown|HTTP 5\d\d|\b50[0234]\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|aborted|socket|fetch failed/i.test(
    message || ''
  );
}

/** Decimal string → base units without floating point. Returns null if invalid. */
export function parseDecimalToBase(amount: string, decimals: number): bigint | null {
  const s = (amount || '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) {
    // Never silently round a user's amount — reject excess precision.
    if (/[1-9]/.test(frac.slice(decimals))) return null;
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(whole + padded);
  } catch {
    return null;
  }
          }
        
