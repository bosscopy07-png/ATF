import axios from 'axios';
import { Address } from '@ton/core';
import { config } from '../config';
import { SupportedToken, ISupportedToken } from '../models/SupportedToken';

export interface TokenRef {
  masterAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  verification: string;
}

/**
 * Token registry.
 *
 * - Discovery: STON.fi asset list (provider reality, not fabricated).
 * - Verification: provider flags mapped onto our 4-state lifecycle.
 *   'suspicious'/'blacklisted' tokens are NEVER returned for swap/search.
 */
export class TokenRegistry {
  private static cache: { tokens: TokenRef[]; at: number } | null = null;
  private static readonly CACHE_TTL_MS = 10 * 60 * 1000;

  static normalize(addr: string): string {
    return Address.parse(addr).toString();
  }

  static isNative(symbolOrAddress: string): boolean {
    const s = symbolOrAddress.trim().toLowerCase();
    return s === 'ton' || s === 'gram' || s === 'native';
  }

  /**
   * Refresh registry from STON.fi. Fail-soft: keeps last good cache.
   */
  static async refresh(): Promise<void> {
    try {
      const res = await axios.get(`${config.stonfiApiUrl}/assets`, {
        timeout: 10_000,
        params: { limit: 300 },
      });

      const rows: any[] = Array.isArray(res.data)
        ? res.data
        : (res.data?.asset_list ?? res.data?.assets ?? []);

      for (const raw of rows) {
        try {
          const masterAddress = raw.contract_address ?? raw.address;
          if (!masterAddress) continue;

          const normalized = this.normalize(masterAddress);

          const verification = this.mapVerification(raw.verification);
          const symbol = String(raw.symbol ?? '').toUpperCase();
          const name = String(raw.name ?? symbol);
          const decimals = Number(raw.decimals ?? 9);

          if (!symbol || !Number.isInteger(decimals)) continue;
          if (verification === 'blacklisted') {
            await SupportedToken.updateOne(
              { masterAddress: normalized },
              { $set: { isActive: false, verification: 'blacklisted' } }
            );
            continue;
          }

          await SupportedToken.updateOne(
            { masterAddress: normalized },
            {
              $set: {
                symbol,
                name,
                decimals,
                verification,
                imageUrl: raw.image_url ?? undefined,
                priceSource: 'ston.fi',
                priceUpdatedAt: new Date(),
                lastPriceUsd:
                  raw.dex_price_usd != null
                    ? String(raw.dex_price_usd)
                    : undefined,
                isActive: verification !== 'suspicious',
              },
            },
            { upsert: true }
          );
        } catch {
          // skip malformed asset rows — never crash discovery
        }
      }

      const docs = await SupportedToken.find({ isActive: true });
      this.cache = {
        tokens: docs.map((d) => ({
          masterAddress: d.masterAddress,
          symbol: d.symbol,
          name: d.name,
          decimals: d.decimals,
          verification: d.verification,
        })),
        at: Date.now(),
      };
    } catch (err) {
      console.error('[TokenRegistry] refresh failed (keeping cache):', (err as Error).message);
      if (!this.cache) throw err;
    }
  }

  private static mapVerification(
    raw: any
  ): 'verified' | 'community' | 'suspicious' | 'blacklisted' {
    const v = String(raw ?? '').toLowerCase();
    if (v === 'whitelist' || v === 'verified' || v === 'trusted') return 'verified';
    if (v === 'blacklist' || v === 'scam' || v === 'fake') return 'blacklisted';
    if (v === 'none' || v === 'unverified') return 'suspicious';
    return 'community';
  }

  static async listTradeable(): Promise<TokenRef[]> {
    if (!this.cache || Date.now() - this.cache.at > this.CACHE_TTL_MS) {
      await this.refresh();
    }
    return (this.cache?.tokens ?? []).filter(
      (t) => t.verification === 'verified' || t.verification === 'community'
    );
  }

  /**
   * Search by name, symbol, or exact master address. Paginated.
   */
  static async search(
    query: string,
    page = 1,
    pageSize = 8
  ): Promise<{ items: ISupportedToken[]; total: number }> {
    const q = query.trim();
    if (!q) return { items: [], total: 0 };

    let filter: any;

    try {
      const normalized = Address.parse(q).toString();
      filter = { masterAddress: normalized, isActive: true };
    } catch {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter = {
        isActive: true,
        verification: { $in: ['verified', 'community'] },
        $or: [{ symbol: rx }, { name: rx }],
      };
    }

    const [items, total] = await Promise.all([
      SupportedToken.find(filter)
        .sort({ verification: 1, symbol: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      SupportedToken.countDocuments(filter),
    ]);

    return { items, total };
  }

  static async resolve(
    masterAddress: string
  ): Promise<ISupportedToken | null> {
    try {
      const normalized = this.normalize(masterAddress);
      return await SupportedToken.findOne({
        masterAddress: normalized,
        isActive: true,
      });
    } catch {
      return null;
    }
  }
      }
              
