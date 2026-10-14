import Decimal from 'decimal.js';
import { config } from './index';

Decimal.set({ precision: 50, rounding: Decimal.ROUND_DOWN });

export type SwapDirectionKind =
  | 'ton_to_token'
  | 'token_to_ton'
  | 'token_to_token';

export type FeeRounding = 'down' | 'up' | 'half_up';

/**
 * Centralized fee calculation. THE ONLY place fee percentages live.
 *
 * Guarantees:
 *  - Decimal-safe (no float).
 *  - ROUND_DOWN by default → never overcharge.
 *  - input fee and output fee are calculated INDEPENDENTLY (token→TON).
 *  - No double charging: a direction charges either input OR output
 *    platform fee (never both), plus the token→TON output-side TON fee
 *    which is a distinct disclosed charge.
 */
export class FeeEngine {
  static percentOf(
    amountBase: bigint,
    percent: number,
    rounding: FeeRounding = 'down'
  ): bigint {
    if (percent <= 0 || amountBase <= 0n) return 0n;

    const amount = new Decimal(amountBase.toString());
    const exact = amount.times(percent).dividedBy(100);

    const mode =
      rounding === 'up'
        ? Decimal.ROUND_UP
        : rounding === 'half_up'
          ? Decimal.ROUND_HALF_UP
          : Decimal.ROUND_DOWN;

    return BigInt(exact.toFixed(0, mode));
  }

  static platformPercentFor(
    kind: SwapDirectionKind
  ): number {
    const p = config.feePolicy;

    switch (kind) {
      case 'ton_to_token':
        return p.tonToTokenPercent;
      case 'token_to_ton':
        return p.tokenToTonInputPercent;
      case 'token_to_token':
        return p.tokenToTokenPercent;
    }
  }

  /**
   * Compute the full fee plan for a swap BEFORE execution.
   *
   * @param grossInputBase   input amount in input-asset base units
   * @param quotedOutputBase raw DEX output in output-asset base units
   */
  static planSwapFees(
    kind: SwapDirectionKind,
    grossInputBase: bigint,
    quotedOutputBase: bigint
  ): SwapFeePlan {
    const base = config.feePolicy.platformFeeBase;
    const percent = this.platformPercentFor(kind);

    // ── Platform fee: input XOR output, never both ──
    let platformFeeInputBase = 0n;
    let platformFeeOutputBase = 0n;
    let netInputBase = grossInputBase;
    let netOutputBase = quotedOutputBase;

    if (base === 'input') {
      platformFeeInputBase = this.percentOf(grossInputBase, percent);
      netInputBase = grossInputBase - platformFeeInputBase;
    } else {
      platformFeeOutputBase = this.percentOf(quotedOutputBase, percent);
      netOutputBase = quotedOutputBase - platformFeeOutputBase;
    }

    // ── token→TON additional 1% charged on TON OUTPUT (independent) ──
    let tonOutputFeeBase = 0n;
    if (kind === 'token_to_ton') {
      tonOutputFeeBase = this.percentOf(
        quotedOutputBase,
        config.feePolicy.tokenToTonOutputPercent
      );
      netOutputBase = netOutputBase - tonOutputFeeBase;
    }

    if (netInputBase <= 0n) {
      throw new Error('Amount too small after platform fee');
    }
    if (netOutputBase <= 0n) {
      throw new Error('Expected output too small after fees');
    }

    return {
      kind,
      feeBase: base,
      platformPercent: percent,

      grossInputBase,
      platformFeeInputBase,
      platformFeeOutputBase,
      tonOutputFeeBase,

      netInputBase,
      netOutputBase,
    };
  }

  /** Relay transfer: 2% platform fee on requested destination amount. */
  static planRelayFee(
    requestedNano: bigint
  ): { platformFeeNano: bigint; totalDebitNano: bigint } {
    const platformFeeNano = this.percentOf(
      requestedNano,
      config.feePolicy.relayTransferPercent
    );
    return {
      platformFeeNano,
      totalDebitNano: requestedNano + platformFeeNano,
    };
  }
}

export interface SwapFeePlan {
  kind: SwapDirectionKind;
  feeBase: 'input' | 'output';
  platformPercent: number;

  /** All values in base units of their respective assets. */
  grossInputBase: bigint;
  platformFeeInputBase: bigint;
  platformFeeOutputBase: bigint;
  tonOutputFeeBase: bigint;

  netInputBase: bigint;
  netOutputBase: bigint;
}
