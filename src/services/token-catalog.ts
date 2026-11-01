/**
 * token-catalog — pure helpers (no network / DB / SDK) that turn STON.fi
 * provider responses into selectable Jetton tokens.
 *
 * Address normalisation is injected so this module has no runtime
 * dependency and is unit-testable with fixtures. TokenRegistry passes the
 * real @ton/core implementation.
 */

export type CatalogVerification = 'verified' | 'community' | 'suspicious' | 'blacklisted';

export type CatalogKind = 'jetton' | 'native' | 'proxy';

export interface CatalogToken {
  /** Canonical (bounceable, url-safe) Jetton master address. */
  masterAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  verification: CatalogVerification;
  kind: CatalogKind;
  imageUrl?: string;
  priceUsd?: string;
  /** Provider popularity index; higher = more popular. 0 when unknown. */
  popularity: number;
}

export type AddressNormalizer = (address: string) => string | null;

/**
 * TON is a NATIVE asset. It is never a Jetton and never searched as one.
 * The all-zero address below is STON.fi's API alias for native TON.
 */
export const NATIVE_TON = Object.freeze({
  symbol: 'TON',
  name: 'Toncoin',
  decimals: 9,
  /** STON.fi API alias for native TON (not a Jetton master). */
  apiAddress: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
});

/** Words that mean "the native coin" when typed by a user. */
export function isNativeTonQuery(input: string): boolean {
  const s = (input || '').trim().toLowerCase();
  return s === 'ton' || s === 'toncoin' || s === 'gram' || s === 'native' || s === 'native ton';
}

/** Extract the asset array from every response shape STON.fi has used. */
export function extractAssetRows(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.asset_list,
    payload?.assets,
    payload?.data?.asset_list,
    payload?.data?.assets,
    payload?.data,
    payload?.result,
    payload?.items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  // single-asset responses: { asset: {...} } or the asset object itself
  if (payload?.asset && typeof payload.asset === 'object') return [payload.asset];
  if (payload?.contract_address || payload?.address) return [payload];
  return [];
}

function truthy(v: any): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function kindOf(raw: any): CatalogKind {
  const k = String(raw?.kind ?? '').toLowerCase();
  if (k === 'ton') return 'native';
  if (k === 'wton') return 'proxy';
  const sym = String(raw?.symbol ?? '').toUpperCase();
  if (sym === 'PTON') return 'proxy';
  return 'jetton';
}

function verificationOf(raw: any): CatalogVerification {
  const tags: string[] = Array.isArray(raw?.tags) ? raw.tags.map((t: any) => String(t).toLowerCase()) : [];

  if (truthy(raw?.blacklisted) || tags.includes('asset:blacklisted')) return 'blacklisted';

  const explicit = String(raw?.verification ?? '').toLowerCase();
  if (explicit === 'blacklist' || explicit === 'blacklisted' || explicit === 'scam' || explicit === 'fake') {
    return 'blacklisted';
  }
  if (truthy(raw?.deprecated) || tags.includes('asset:deprecated')) return 'suspicious';
  if (explicit === 'none' || explicit === 'unverified') return 'suspicious';
  if (explicit === 'whitelist' || explicit === 'verified' || explicit === 'trusted') return 'verified';

  // STON.fi v1: community=true → community-added (not curated).
  if (truthy(raw?.community)) return 'community';
  if (raw?.community === false) return 'verified';
  return 'community';
}

export function parseProviderAsset(raw: any, normalize: AddressNormalizer): CatalogToken | null {
  const rawAddress = raw?.contract_address ?? raw?.address ?? raw?.jetton_address ?? raw?.master;
  if (!rawAddress) return null;

  const masterAddress = normalize(String(rawAddress));
  if (!masterAddress) return null;

  const symbol = String(raw?.symbol ?? '').trim().toUpperCase();
  if (!symbol) return null;

  const decimals = Number(raw?.decimals ?? 9);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;

  const name = String(raw?.display_name ?? raw?.name ?? symbol).trim() || symbol;

  const price =
    raw?.dex_price_usd ?? raw?.third_party_usd_price ?? raw?.price_usd ?? raw?.usd_price ?? null;
  const popularity = Number(raw?.popularity_index ?? raw?.popularity ?? 0);

  return {
    masterAddress,
    symbol,
    name,
    decimals,
    verification: verificationOf(raw),
    kind: kindOf(raw),
    imageUrl: raw?.image_url ?? raw?.image ?? undefined,
    priceUsd: price != null && price !== '' ? String(price) : undefined,
    popularity: Number.isFinite(popularity) ? popularity : 0,
  };
}

export function parseProviderAssets(payload: any, normalize: AddressNormalizer): CatalogToken[] {
  const out: CatalogToken[] = [];
  const seen = new Set<string>();
  for (const raw of extractAssetRows(payload)) {
    try {
      const t = parseProviderAsset(raw, normalize);
      if (t && !seen.has(t.masterAddress)) {
        seen.add(t.masterAddress);
        out.push(t);
      }
    } catch {
      // one malformed row must never hide the rest
    }
  }
  return out;
}

export interface Exclusions {
  /** Canonical addresses that must never be offered (ATF, pTON masters). */
  addresses: string[];
}

/**
 * A token is selectable for multi-token swaps only when it is a real Jetton:
 *  - not native TON / pTON proxy (TON is a native asset, never a Jetton),
 *  - not blacklisted / deprecated,
 *  - not ATF (it has its own dedicated swap interface).
 */
export function isSelectableJetton(t: CatalogToken, ex: Exclusions): boolean {
  if (t.kind !== 'jetton') return false;
  if (t.verification !== 'verified' && t.verification !== 'community') return false;
  if (ex.addresses.includes(t.masterAddress)) return false;
  return true;
}

function score(t: CatalogToken, q: string): number {
  const sym = t.symbol.toLowerCase();
  const name = t.name.toLowerCase();
  if (sym === q) return 0;
  if (name === q) return 1;
  if (sym.startsWith(q)) return 2;
  if (name.startsWith(q)) return 3;
  if (sym.includes(q)) return 4;
  if (name.includes(q)) return 5;
  return 99;
}

/**
 * Filter + rank by name / symbol. An empty query is a BROWSE request and
 * returns the most popular selectable tokens (it must never be empty just
 * because the user has not typed anything yet).
 */
export function filterAndRank(tokens: CatalogToken[], query: string): CatalogToken[] {
  const q = (query || '').trim().toLowerCase();

  const byPopularity = (a: CatalogToken, b: CatalogToken) =>
    b.popularity - a.popularity || a.symbol.localeCompare(b.symbol);

  if (!q) return [...tokens].sort(byPopularity);

  return tokens
    .map((t) => ({ t, s: score(t, q) }))
    .filter((x) => x.s < 99)
    .sort((a, b) => a.s - b.s || byPopularity(a.t, b.t))
    .map((x) => x.t);
}

/** Exact master-address lookup in a parsed list (addresses already canonical). */
export function findByAddress(tokens: CatalogToken[], canonicalAddress: string): CatalogToken | null {
  return tokens.find((t) => t.masterAddress === canonicalAddress) ?? null;
}

/** Paginate a list. page is 1-based. */
export function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; total: number } {
  const p = Math.max(1, Math.floor(page) || 1);
  const start = (p - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length };
}
