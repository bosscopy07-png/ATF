/**
 * token-display — pure formatting for token rows (no I/O, no SDK).
 * One place decides the trend emoji, price and percent text so the token
 * picker, the browse list and the portfolio all look identical.
 */

/** 🟢 up · 🔴 down · ⚪ flat / unknown. */
export function trendEmoji(change?: number | null): string {
  if (change === undefined || change === null || !Number.isFinite(change)) return '⚪';
  if (change > 0) return '🟢';
  if (change < 0) return '🔴';
  return '⚪';
}

/** +5.20% / -1.30% / — */
export function pctText(change?: number | null): string {
  if (change === undefined || change === null || !Number.isFinite(change)) return '—';
  return `${change > 0 ? '+' : ''}${change.toFixed(2)}%`;
}

/**
 * USD price that stays readable from $67,000 down to $0.00000123:
 * large prices get 2 decimals, small ones keep 4 significant digits.
 */
export function priceText(price?: number | string | null): string {
  if (price === undefined || price === null || price === '') return '—';
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  // tiny prices: 4 significant digits, no scientific notation
  const digits = Math.min(12, Math.max(4, 3 - Math.floor(Math.log10(n))));
  return `$${n.toFixed(digits).replace(/0+$/, '')}`;
}

/** Parse "+5.23%" / "−3.4%" (TonAPI uses U+2212) / 5.2 → number | null. */
export function parseChange(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/\u2212/g, '-').replace(/[%,\s+]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface TokenRowInput {
  symbol: string;
  priceUsd?: number | string | null;
  change24h?: number | null;
  /** how many the user holds, already formatted (holdings list only) */
  balance?: string;
}

/** Short one-line label for an inline button (Telegram buttons are narrow). */
export function tokenButtonLabel(t: TokenRowInput): string {
  const parts = [`${trendEmoji(t.change24h)} ${t.symbol}`];
  if (t.balance !== undefined) parts.push(t.balance);
  parts.push(priceText(t.priceUsd));
  if (t.change24h !== undefined && t.change24h !== null) parts.push(pctText(t.change24h));
  return parts.join(' · ').slice(0, 56);
}

/** Detail line for the message body. */
export function tokenDetailLine(t: TokenRowInput): string {
  const bits: string[] = [];
  if (t.balance !== undefined) bits.push(`holding <code>${t.balance}</code>`);
  bits.push(priceText(t.priceUsd));
  bits.push(pctText(t.change24h));
  return bits.join(' · ');
}
