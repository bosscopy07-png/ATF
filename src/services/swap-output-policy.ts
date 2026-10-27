/**
 * swap-output-policy — pure (no SDK / DB / RPC) decision helpers for
 * proving what a swap actually produced. Kept dependency-free so the
 * decisions are unit-testable with fixtures.
 */

/**
 * Real total fees of an @ton/core Transaction, in nanoTON.
 *
 * `Transaction.totalFees` is a CurrencyCollection `{ coins: bigint,
 * other?: Dictionary }`, NOT a bigint. Returns null when the structure
 * is missing/unexpected so callers treat the evidence as unreadable
 * (never as zero).
 */
export function txTotalFeesNano(tx: any): bigint | null {
  const coins = tx?.totalFees?.coins;
  return typeof coins === 'bigint' ? coins : null;
}

/** Number of outbound messages the wallet transaction produced, or null. */
export function txOutMessageCount(tx: any): number | null {
  const om = tx?.outMessages;
  if (!om) return null;
  if (typeof om.size === 'number') return om.size; // Dictionary<number, Message>
  if (typeof om.length === 'number') return om.length;
  return null;
}

export type WalletTxEvidence =
  | { state: 'unreadable' } // RPC failure, ref-style hash, tx not found
  | { state: 'found'; feesNano: bigint | null; outMessages: number | null };

export interface AtfToTonEvidence {
  balanceTonNano: bigint;
  preSwapTonNano: bigint;
  minOutputNano: bigint;
  ageMs: number;
  graceMs?: number;
  tx: WalletTxEvidence;
}

export interface OutputVerdict {
  status: 'success' | 'failed' | 'pending';
  actualOutputBaseUnits: bigint;
  method: string;
}

/**
 * ATF→TON output verdict.
 *
 *  adjusted = balanceNow + walletTxFees − preSwapBalance
 *           = output + refund − attachedValue          (≤ true output)
 *
 * - success  : adjusted ≥ minOutput. `adjusted` never exceeds the true
 *              output, so this can never prove a false success.
 * - failed   : the wallet tx sent NO outbound message (deployment-only /
 *              aborted action phase — no swap was ever submitted), or,
 *              after the grace window, the balance shows no TON gain at
 *              all (adjusted ≤ 0).
 * - pending  : everything else — fees unreadable, no minimum to compare
 *              against, or a partial/ambiguous gain. Unresolved swaps
 *              stay with the reconciler; they are NEVER refunded or
 *              charged on weak evidence. The attached swapValue is never
 *              used as an add-back.
 */
export function evaluateAtfToTonOutput(e: AtfToTonEvidence): OutputVerdict {
  const grace = e.graceMs ?? 90_000;

  if (e.tx.state === 'found' && e.tx.outMessages === 0) {
    return { status: 'failed', actualOutputBaseUnits: 0n, method: 'no_swap_message_sent' };
  }

  if (e.tx.state !== 'found' || e.tx.feesNano === null) {
    return { status: 'pending', actualOutputBaseUnits: 0n, method: 'fees_unreadable' };
  }

  if (e.minOutputNano <= 0n) {
    return { status: 'pending', actualOutputBaseUnits: 0n, method: 'no_min_output' };
  }

  const adjusted = e.balanceTonNano + e.tx.feesNano - e.preSwapTonNano;

  if (adjusted >= e.minOutputNano) {
    return { status: 'success', actualOutputBaseUnits: adjusted, method: 'ton_balance_delta_plus_fees' };
  }

  if (e.ageMs < grace) {
    return { status: 'pending', actualOutputBaseUnits: adjusted > 0n ? adjusted : 0n, method: 'waiting' };
  }

  if (adjusted <= 0n) {
    return { status: 'failed', actualOutputBaseUnits: 0n, method: 'timeout_no_ton_output' };
  }

  return { status: 'pending', actualOutputBaseUnits: adjusted, method: 'inconclusive_partial_gain' };
      }
