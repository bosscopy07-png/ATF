import axios from 'axios';
import { PriceCache } from '../models/PriceCache';
import { config } from '../config';

export interface PriceData {
  price: number;
  currency: string;
  source: string;
  timestamp: Date;
  change24hPercent?: number | null;
}

interface ProviderResult {
  price: number;
  change24hPercent?: number | null;
}

interface Provider {
  url: string;
  extract: (data: any) => number | string | ProviderResult | null;
}

/** 🧹 strip the stale marker so labels/links stay clean */
const cleanSource = (p: Pick<PriceData, 'source'> | null): string =>
  (p?.source ?? '').replace(' (stale)', '');

/** ⏳ true when this quote came from the stale-cache fallback */
const isStale = (p: PriceData | null): boolean =>
  !!p?.source?.includes('(stale)');

export class PriceService {
  private static instance: PriceService;

  private cacheTtlMs = config.priceCacheTtlMs || 60_000;
  private providerTimeoutMs = 5_000;

  private constructor() {}

  static getInstance(): PriceService {
    if (!PriceService.instance) PriceService.instance = new PriceService();
    return PriceService.instance;
  }

  /* ─────────────────────────────────────────────
     🔗 Chart links (PriceData carries no URL —
     derive the canonical chart per asset)
     ───────────────────────────────────────────── */

  getChartUrl(asset: 'atf' | 'ton'): string | null {
    if (asset === 'atf') {
      if (config.atfChartUrl) return config.atfChartUrl;
      const addr = config.atfJettonAddress;
      return addr ? `https://dexscreener.com/ton/${addr}` : null;
    }
    return config.tonChartUrl || 'https://www.coingecko.com/en/coins/toncoin';
  }

  /* ─────────────────────────────────────────────
     🌐 Provider plumbing
     ───────────────────────────────────────────── */

  private async fetchFromProvider(provider: Provider): Promise<ProviderResult | null> {
    try {
      const response = await axios.get(provider.url, {
        timeout: this.providerTimeoutMs,
        headers: { Accept: 'application/json' },
      });

      const raw = provider.extract(response.data);
      if (raw === null || raw === undefined) return null;

      let price: number;
      let change24hPercent: number | null | undefined;

      if (typeof raw === 'object') {
        price = typeof raw.price === 'string' ? parseFloat(raw.price) : raw.price;
        change24hPercent = raw.change24hPercent;
      } else {
        price = typeof raw === 'string' ? parseFloat(raw) : raw;
      }

      if (!Number.isFinite(price) || price <= 0) return null;

      return {
        price,
        change24hPercent: Number.isFinite(change24hPercent as number) ? change24hPercent : null,
      };
    } catch (error: any) {
      console.warn(`[PriceService] ⚠️ Provider failed ${provider.url}: ${error?.message || error}`);
      return null;
    }
  }

  private async fetchWithProviders(providers: Provider[]): Promise<{
    price: number;
    source: string;
    change24hPercent: number | null;
  }> {
    for (const provider of providers) {
      if (!provider.url) continue;

      const result = await this.fetchFromProvider(provider);
      if (result && result.price > 0) {
        return {
          price: result.price,
          source: provider.url,
          change24hPercent: result.change24hPercent ?? null,
        };
      }
    }
    throw new Error('All price providers failed 💀');
  }

  private async getCachedOrFetch(
    asset: string,
    fetchFn: () => Promise<PriceData>,
  ): Promise<PriceData | null> {
    const cached = await PriceCache.findOne({ asset }).sort({ timestamp: -1 });

    /** ⚡ Fresh cache — now preserves the stored 24h movement. */
    if (cached && Date.now() - cached.timestamp.getTime() < this.cacheTtlMs) {
      return {
        price: cached.price,
        currency: cached.currency,
        source: cached.source,
        timestamp: cached.timestamp,
        change24hPercent: (cached as any).change24hPercent ?? null,
      };
    }

    try {
      const data = await fetchFn();
      if (!Number.isFinite(data.price) || data.price <= 0) {
        throw new Error(`Invalid ${asset} price`);
      }

      /** 📊 Provider movement, else compare against previous cached observation. */
      let change = data.change24hPercent ?? null;
      if (change === null && cached && cached.price > 0) {
        change = ((data.price - cached.price) / cached.price) * 100;
      }

      await PriceCache.create({
        asset,
        price: data.price,
        currency: data.currency,
        source: data.source,
        timestamp: new Date(),
        change24hPercent: change, // 🆕 persisted so the next cache hit keeps it
      });

      return { ...data, change24hPercent: change };
    } catch (error: any) {
      console.error(`[PriceService] ❌ Fetch error for ${asset}:`, error?.message || error);

      /** 🛟 Stale cache is the final safety net. */
      if (cached) {
        return {
          price: cached.price,
          currency: cached.currency,
          source: `${cached.source} (stale)`,
          timestamp: cached.timestamp,
          change24hPercent: null,
        };
      }
      return null;
    }
  }

  /* ─────────────────────────────────────────────
     🔷 ATF / USD
     ───────────────────────────────────────────── */

  async getAtfPriceUsd(): Promise<PriceData | null> {
    return this.getCachedOrFetch('atf_usd', async () => {
      const address = config.atfJettonAddress;

      const providers: Provider[] = [
        {
          // 1️⃣ STON.fi
          url: config.atfPriceApiUrl || `https://api.ston.fi/v1/assets/${address}`,
          extract: (d: any) => ({
            price: d?.dex_price_usd ?? d?.third_party_price_usd ?? d?.price ?? d?.asset?.price ?? d?.asset?.dex_price_usd ?? d?.asset?.price_usd ?? d?.price_usd ?? d?.data?.price,
            change24hPercent: d?.price_change_24h ?? d?.priceChange24h ?? d?.change_24h ?? d?.asset?.price_change_24h ?? null,
          }),
        },
        {
          // 2️⃣ Dexscreener (also gives us the chart link target)
          url: `https://api.dexscreener.com/latest/dex/tokens/${address}`,
          extract: (d: any) => {
            const pair = d?.pairs?.find((p: any) => Number.isFinite(Number(p?.priceUsd))) || d?.pairs?.[0];
            return {
              price: pair?.priceUsd,
              change24hPercent: pair?.priceChange?.h24 ?? null,
            };
          },
        },
        {
          // 3️⃣ CoinGecko jetton-by-contract (was a duplicate STON — now a real backup)
          url: `https://api.coingecko.com/api/v3/simple/token_price/ton?contract_addresses=${address}&vs_currencies=usd&include_24hr_change=true`,
          extract: (d: any) => {
            const row = d?.[String(address).toLowerCase()] || Object.values(d || {})[0] as any;
            return {
              price: row?.usd,
              change24hPercent: row?.usd_24h_change ?? null,
            };
          },
        },
        {
          // 4️⃣ GeckoTerminal (price only)
          url: `https://api.geckoterminal.com/api/v2/simple/networks/ton/token_price/${address}`,
          extract: (d: any) => {
            const prices = d?.data?.attributes?.token_prices;
            const key = Object.keys(prices || {})[0];
            return prices?.[key] ? { price: prices[key], change24hPercent: null } : null;
          },
        },
      ];

      const { price, source, change24hPercent } = await this.fetchWithProviders(providers);
      return { price, currency: 'USD', source, timestamp: new Date(), change24hPercent };
    });
  }

  /* ─────────────────────────────────────────────
     💎 TON / USD — reordered: keyless, reliable
     exchanges first; CoinGecko last because its
     free tier 429s constantly. ✅
     ───────────────────────────────────────────── */

  async getTonPriceUsd(): Promise<PriceData | null> {
    return this.getCachedOrFetch('ton_usd', async () => {
      const providers: Provider[] = [
        {
          // 1️⃣ Bybit — free, keyless, reliable
          url: 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=TONUSDT',
          extract: (d: any) => {
            const item = d?.result?.list?.[0];
            const chg = parseFloat(item?.price24hPcnt);
            return {
              price: item?.lastPrice,
              change24hPercent: Number.isFinite(chg) ? chg * 100 : null,
            };
          },
        },
        {
          // 2️⃣ OKX — FIXED: was `sodUtc8 ? null : null` (always null).
          // OKX ticker carries open24h → compute real 24h %.
          url: 'https://www.okx.com/api/v5/market/ticker?instId=TON-USDT',
          extract: (d: any) => {
            const t = d?.data?.[0];
            const last = parseFloat(t?.last);
            const open = parseFloat(t?.open24h);
            return {
              price: last,
              change24hPercent: Number.isFinite(last) && Number.isFinite(open) && open > 0
                ? ((last - open) / open) * 100
                : null,
            };
          },
        },
        {
          // 3️⃣ MEXC — keyless, generous limits
          url: 'https://api.mexc.com/api/v3/ticker/24hr?symbol=TONUSDT',
          extract: (d: any) => ({
            price: d?.lastPrice,
            change24hPercent: d?.priceChangePercent != null ? parseFloat(d.priceChangePercent) : null,
          }),
        },
        {
          // 4️⃣ KuCoin — changeRate is a decimal ratio (0.0123 = +1.23%)
          url: 'https://api.kucoin.com/api/v1/market/stats?symbol=TON-USDT',
          extract: (d: any) => {
            const rate = parseFloat(d?.data?.changeRate);
            return {
              price: d?.data?.last,
              change24hPercent: Number.isFinite(rate) ? rate * 100 : null,
            };
          },
        },
        {
          // 5️⃣ Binance (geo-blocked in some regions — mid-chain now)
          url: 'https://api.binance.com/api/v3/ticker/24hr?symbol=TONUSDT',
          extract: (d: any) => ({
            price: d?.lastPrice ?? d?.price,
            change24hPercent: d?.priceChangePercent != null ? parseFloat(d.priceChangePercent) : null,
          }),
        },
        {
          // 6️⃣ CoinGecko — LAST: free tier rate-limits hard (this was the old #1 = your failures)
          url: config.tonPriceApiUrl || 'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd&include_24hr_change=true',
          extract: (d: any) => ({
            price: d?.['the-open-network']?.usd,
            change24hPercent: d?.['the-open-network']?.usd_24h_change ?? null,
          }),
        },
      ];

      const { price, source, change24hPercent } = await this.fetchWithProviders(providers);
      return { price, currency: 'USD', source, timestamp: new Date(), change24hPercent };
    });
  }

  /* ─────────────────────────────────────────────
     🇳🇬 USD / NGN
     ───────────────────────────────────────────── */

  async getUsdNgnRate(): Promise<PriceData | null> {
    return this.getCachedOrFetch('usd_ngn', async () => {
      const providers: Provider[] = [
        { url: config.usdNgnRateApiUrl || 'https://api.frankfurter.dev/v2/rate/USD/NGN', extract: (d: any) => d?.rate ?? d?.rates?.NGN },
        { url: 'https://api.exchangerate-api.com/v4/latest/USD', extract: (d: any) => d?.rates?.NGN },
        { url: 'https://open.er-api.com/v6/latest/USD', extract: (d: any) => d?.rates?.NGN },
      ];

      const { price, source, change24hPercent } = await this.fetchWithProviders(providers);
      return { price, currency: 'NGN', source, timestamp: new Date(), change24hPercent };
    });
  }

  async getAtfPriceNgn(): Promise<number | null> {
    const [atfUsd, usdNgn] = await Promise.all([this.getAtfPriceUsd(), this.getUsdNgnRate()]);
    return atfUsd && usdNgn ? atfUsd.price * usdNgn.price : null;
  }

  async getTonPriceNgn(): Promise<number | null> {
    const [tonUsd, usdNgn] = await Promise.all([this.getTonPriceUsd(), this.getUsdNgnRate()]);
    return tonUsd && usdNgn ? tonUsd.price * usdNgn.price : null;
  }

  convertCryptoToUsd(amount: string, priceUsd: number, _decimals: number): string {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || !Number.isFinite(priceUsd)) return '0.00';
    return (amt * priceUsd).toFixed(2);
  }

  /**
   * 🆕 Returns a PLAIN string (no toLocaleString).
   * Localizing here caused Number("1,234") → NaN upstream.
   * Formatting belongs in the UI layer.
   */
  convertUsdToNgn(usdAmount: string, ngnRate: number): string {
    const amt = parseFloat(usdAmount);
    if (!Number.isFinite(amt) || !Number.isFinite(ngnRate)) return '0';
    return String(Math.round(amt * ngnRate));
  }
          }
    
