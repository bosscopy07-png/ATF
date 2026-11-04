
import axios from 'axios';
import { Address } from '@ton/core';
import { config } from '../config';
import { SupportedToken } from '../models/SupportedToken';
import {
  CatalogToken,
  NATIVE_TON,
  filterAndRank,
  isNativeTonQuery,
  isSelectableJetton,
  parseProviderAssets,
} from './token-catalog';

export interface TokenRef {
  masterAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  verification: string;
  imageUrl?: string;
  priceUsd?: string;
}

type HttpFn = (
  method: 'GET' | 'POST',
  path: string,
  opts?: { params?: Record<string, any>; data?: any; timeoutMs?: number }
) => Promise<any>;

/** STON.fi API root without a trailing slash or /v1 (paths below add /v1). */
function providerRoot(): string {
  return String(config.stonfiApiUrl || 'https://api.ston.fi')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
}

const defaultHttp: HttpFn = async (method, path, opts) => {
  const res = await axios.request({
    method,
    url: `${providerRoot()}${path}`,
    params: opts?.params,
    data: opts?.data,
    timeout: opts?.timeoutMs ?? 12_000,
    headers: { Accept: 'application/json' },
  });
  return res.data;
};

function toRef(t: CatalogToken): TokenRef {
  return {
    masterAddress: t.masterAddress,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    verification: t.verification,
    imageUrl: t.imageUrl,
    priceUsd: t.priceUsd,
  };
}

/**
 * Token registry — the STON.fi asset registry is the AUTHORITY.
 *
 *  - Discovery reads the provider (never fabricated, never limited to what a
 *    local database happens to contain). MongoDB is only a write-through
 *    cache for admin tooling; a local miss NEVER marks a token unavailable.
 *  - An empty query is a BROWSE request (most popular listed tokens), not an
 *    empty result.
 *  - TON is a NATIVE asset: it is never returned as, searched as, or treated
 *    as a Jetton (pTON / wTON proxies are excluded too).
 *  - ATF is excluded: it has its own dedicated swap interface.
 *  - Blacklisted / deprecated assets are never returned.
 *  - A provider OUTAGE throws; it is never reported as "no results".
 *
 * Whether a listed token has an actually EXECUTABLE route is decided at
 * quote time by the multi-token swap service (a real STON.fi simulation),
 * not here.
 */
export class TokenRegistry {
  private static cache: { tokens: CatalogToken[]; at: number } | null = null;
  private static inflight: Promise<void> | null = null;
  private static http: HttpFn = defaultHttp;

  static readonly CACHE_TTL_MS = 10 * 60 * 1000;

  /** Test seam — replace the provider transport. */
  static setHttpForTests(fn: HttpFn | null): void {
    this.http = fn ?? defaultHttp;
    this.cache = null;
    this.inflight = null;
    this.lastPersistAt = 0;
  }

  static normalize(addr: string): string {
    return Address.parse(addr.trim()).toString();
  }

  /** Canonical address, or null when the input is not an address. */
  static tryNormalize(addr: string): string | null {
    try {
      return this.normalize(addr);
    } catch {
      return null;
    }
  }

  static isNative(symbolOrAddress: string): boolean {
    if (isNativeTonQuery(symbolOrAddress)) return true;
    return (symbolOrAddress || '').trim() === NATIVE_TON.apiAddress;
  }

  /** Addresses that must never be offered as a swappable Jetton. */
  static excludedAddresses(): string[] {
    const out = new Set<string>();
    for (const a of [config.atfJettonAddress, config.ptonMasterAddress, NATIVE_TON.apiAddress]) {
      const n = a ? this.tryNormalize(a) : null;
      if (n) out.add(n);
    }
    return [...out];
  }

  static isAtf(masterAddress: string): boolean {
    const n = this.tryNormalize(masterAddress);
    const atf = config.atfJettonAddress ? this.tryNormalize(config.atfJettonAddress) : null;
    return !!n && !!atf && n === atf;
  }

  /* ───────────────── provider access ───────────────── */

  private static async fetchCatalog(): Promise<CatalogToken[]> {
    const norm = (a: string) => this.tryNormalize(a);
    const errors: string[] = [];

    // The full listing is ~40,000 assets, so it needs a far longer timeout than
    // a normal API call (a 12s limit was failing the first, cold request).
    for (const path of ['/v1/assets', '/assets']) {
      try {
        const payload = await this.http('GET', path, { timeoutMs: 60_000 });
        const tokens = parseProviderAssets(payload, norm);
        if (tokens.length > 0) return tokens;
        errors.push(`${path}: returned no assets`);
      } catch (err) {
        // keep EVERY attempt's error — the last one is usually just a 404 on the fallback path
        errors.push(`${path}: ${(err as Error)?.message || 'unknown error'}`);
      }
    }

    throw new Error(`Token provider unavailable (${errors.join(' | ')})`);
  }

  /** Refresh the in-memory catalog from STON.fi. Keeps the last good copy on failure. */
  static async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const tokens = await this.fetchCatalog();
        console.log(`[TokenRegistry] refresh: ${tokens.length} assets from provider`);
        this.cache = { tokens, at: Date.now() };
        void this.persist(tokens);
      } catch (err) {
        console.error('[TokenRegistry] refresh failed:', (err as Error).message);
        if (!this.cache) throw err; // never pretend an outage is "no results"
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  /**
   * Fresh cache → use it. Stale cache → use it NOW and refresh in the
   * background (users never wait on a 40k-asset download). No cache → wait.
   */
  private static async ensureCatalog(): Promise<CatalogToken[]> {
    if (!this.cache) {
      await this.refresh();
    } else if (Date.now() - this.cache.at > this.CACHE_TTL_MS) {
      void this.refresh().catch(() => undefined);
    }
    return this.cache?.tokens ?? [];
  }

  /** Start loading the catalog in the background (called when the menu opens). */
  static warmUp(): void {
    if (!this.cache && !this.inflight) void this.refresh().catch(() => undefined);
  }

  private static lastPersistAt = 0;
  private static readonly PERSIST_LIMIT = 400;
  private static readonly PERSIST_EVERY_MS = 60 * 60 * 1000;

  /**
   * Best-effort write-through cache for admin tooling. Never authoritative.
   * The provider lists ~40,000 assets; only the most popular few hundred are
   * mirrored, and at most once an hour (a full upsert on every refresh would
   * hammer MongoDB for no benefit).
   */
  private static async persist(tokens: CatalogToken[]): Promise<void> {
    if (Date.now() - this.lastPersistAt < this.PERSIST_EVERY_MS) return;
    this.lastPersistAt = Date.now();
    try {
      const top = tokens
        .filter((t) => t.kind === 'jetton' && (t.verification === 'verified' || t.verification === 'community'))
        .sort((a, b) => b.popularity - a.popularity)
        .slice(0, this.PERSIST_LIMIT);

      const ops = top.map((t) => ({
        updateOne: {
          filter: { masterAddress: t.masterAddress },
          update: {
            $set: {
              symbol: t.symbol, name: t.name, decimals: t.decimals,
              verification: t.verification, imageUrl: t.imageUrl,
              priceSource: 'ston.fi', priceUpdatedAt: new Date(), lastPriceUsd: t.priceUsd,
              isActive: true,
            },
          },
          upsert: true,
        },
      }));
      if (ops.length > 0) await SupportedToken.bulkWrite(ops as any, { ordered: false });
    } catch (err) {
      console.warn('[TokenRegistry] cache write skipped:', (err as Error).message);
    }
  }

  /** Authoritative single-asset lookup for tokens missing from the listing. */
  private static async fetchSingle(canonical: string): Promise<CatalogToken | null> {
    const norm = (a: string) => this.tryNormalize(a);
    try {
      const payload = await this.http('GET', `/v1/assets/${encodeURIComponent(canonical)}`);
      return parseProviderAssets(payload, norm).find((t) => t.masterAddress === canonical) ?? null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) return null; // provider says: not listed
      throw err; // outage ≠ "not listed"
    }
  }

  /** Provider-side name/symbol search for assets absent from the cached listing. */
  private static async providerTextSearch(query: string): Promise<CatalogToken[]> {
    const norm = (a: string) => this.tryNormalize(a);
    const attempts: Array<() => Promise<any>> = [
      () => this.http('POST', '/v1/assets/query', { data: { search_string: query } }),
      () => this.http('GET', '/v1/assets/search', { params: { search_string: query } }),
    ];
    for (const attempt of attempts) {
      try {
        const tokens = parseProviderAssets(await attempt(), norm);
        if (tokens.length > 0) return tokens;
      } catch {
        // try the next documented variant
      }
    }
    return [];
  }

  /* ───────────────── public API ───────────────── */

  /** All swappable Jettons the provider lists (popularity order). */
  static async listTradeable(): Promise<TokenRef[]> {
    const ex = { addresses: this.excludedAddresses() };
    const catalog = await this.ensureCatalog();
    return filterAndRank(
      catalog.filter((t) => isSelectableJetton(t, ex)),
      ''
    ).map(toRef);
  }

  /**
   * Search by name, symbol, or exact master address — all matches, ranked.
   * Empty query = browse popular tokens. Throws on provider outage.
   */
  static async searchAll(query: string, limit = 60): Promise<TokenRef[]> {
    const q = (query || '').trim();
    const ex = { addresses: this.excludedAddresses() };

    if (q && this.isNative(q)) return []; // native TON is not a Jetton

    // ── Exact contract address: provider is the authority ──
    const asAddress = q ? this.tryNormalize(q) : null;
    if (asAddress) {
      const catalog = await this.ensureCatalog();
      let found = catalog.find((t) => t.masterAddress === asAddress) ?? null;
      if (!found) found = await this.fetchSingle(asAddress);
      return found && isSelectableJetton(found, ex) ? [toRef(found)] : [];
    }

    // ── Name / symbol / browse ──
    const catalog = await this.ensureCatalog();
    const selectable = catalog.filter((t) => isSelectableJetton(t, ex));
    let ranked = filterAndRank(selectable, q);

    if (ranked.length === 0 && q.length >= 2) {
      const extra = (await this.providerTextSearch(q)).filter((t) => isSelectableJetton(t, ex));
      ranked = filterAndRank(extra, q);
    }

    return ranked.slice(0, limit).map(toRef);
  }

  /** Paginated search (kept for callers that page server-side). */
  static async search(
    query: string,
    page = 1,
    pageSize = 8
  ): Promise<{ items: TokenRef[]; total: number }> {
    const all = await this.searchAll(query, 500);
    const p = Math.max(1, Math.floor(page) || 1);
    return { items: all.slice((p - 1) * pageSize, p * pageSize), total: all.length };
  }

  /**
   * Resolve a master address against the PROVIDER. A local database miss never
   * makes a token unavailable. Returns null only when the provider does not
   * list it (or lists it as blacklisted/deprecated/excluded).
   */
  static async resolve(masterAddress: string): Promise<TokenRef | null> {
    const canonical = this.tryNormalize(masterAddress);
    if (!canonical) return null;

    const ex = { addresses: this.excludedAddresses() };
    const catalog = await this.ensureCatalog();
    const found =
      catalog.find((t) => t.masterAddress === canonical) ?? (await this.fetchSingle(canonical));

    return found && isSelectableJetton(found, ex) ? toRef(found) : null;
  }
}
  
