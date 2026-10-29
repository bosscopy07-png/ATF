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
  /** How long after broadcast the ATF must stay gone (no refund) before success. */
  atfSettleMs?: number;
  tx: WalletTxEvidence;
  /**
   * Token-side proof (independent of gas accounting): the offered jettons
   * must have LEFT the wallet and not come back. STON.fi either swaps them
   * (output ≥ minOutput is enforced by the contract) or refunds them.
   */
  atf?: {
    preSwapNano: bigint;
    nowNano: bigint;
    expectedInputNano: bigint; // quote.offerUnits (net swapped amount)
  };
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
  const settle = e.atfSettleMs ?? 10_000;

  // Token-side evidence. Used when present because TON balance deltas are
  // unreliable here: STON.fi consumes part of the attached gas, so
  // (balance + fees − pre) can be negative even for a successful swap.
  if (e.atf && e.atf.expectedInputNano > 0n && e.minOutputNano > 0n) {
    const drop = e.atf.preSwapNano > e.atf.nowNano ? e.atf.preSwapNano - e.atf.nowNano : 0n;
    const lower =
      e.tx.state === 'found' && e.tx.feesNano !== null
        ? e.balanceTonNano + e.tx.feesNano - e.preSwapTonNano
        : 0n;

    if (drop * 100n >= e.atf.expectedInputNano * 99n) {
      if (e.ageMs < settle) {
        return { status: 'pending', actualOutputBaseUnits: 0n, method: 'atf_left_waiting_refund_window' };
      }
      // Tokens consumed and not refunded → swap executed. The contract
      // guarantees output ≥ minOutput; credit the larger PROVEN bound.
      const proven = lower > e.minOutputNano ? lower : e.minOutputNano;
      return { status: 'success', actualOutputBaseUnits: proven, method: 'atf_consumed_min_output_guaranteed' };
    }
    if (e.ageMs >= grace && drop * 100n <= e.atf.expectedInputNano) {
      return { status: 'failed', actualOutputBaseUnits: 0n, method: 'atf_not_consumed' };
    }
    return { status: 'pending', actualOutputBaseUnits: 0n, method: 'atf_partial_or_waiting' };
  }

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
