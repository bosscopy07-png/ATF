import axios from 'axios';
import { PriceCache } from '../models/PriceCache';
import { config } from '../config';

export interface PriceData {
  price: number;
  currency: string;
  source: string;
  timestamp: Date;
}

interface Provider {
  url: string;
  extract: (data: any) => any;
}

export class PriceService {
  private static instance: PriceService;
  private cacheTtlMs = config.priceCacheTtlMs || 60000;

  private constructor() {}

  static getInstance(): PriceService {
    if (!PriceService.instance) {
      PriceService.instance = new PriceService();
    }
    return PriceService.instance;
  }

  // ─── Low-level fetch ───────────────────────────────────────────────────────
  private async fetchFromProvider(provider: Provider): Promise<number | null> {
    try {
      const response = await axios.get(provider.url, {
        timeout: 10000,
        headers: { Accept: 'application/json' },
      });
      console.log(`[PriceService] Raw response from ${provider.url}:`, JSON.stringify(response.data).slice(0, 800));
      const raw = provider.extract(response.data);
      console.log(`[PriceService] Extracted from ${provider.url}: raw=${raw}, type=${typeof raw}`);
      const price = typeof raw === 'string' ? parseFloat(raw) : raw;

      if (Number.isFinite(price) && price > 0) {
        console.log(`[PriceService] Valid price from ${provider.url}: ${price}`);
        return price;
      }
      console.warn(`[PriceService] Invalid price from ${provider.url}: ${price}`);
    } catch (err: any) {
      console.warn(`[PriceService] Failed ${provider.url}: ${err.message}`);
    }
    return null;
  }

  private async fetchWithProviders(
    providers: Provider[]
  ): Promise<{ price: number; source: string }> {
    for (const provider of providers) {
      if (!provider.url) continue;
      const price = await this.fetchFromProvider(provider);
      if (price !== null) {
        return { price, source: provider.url };
      }
    }
    throw new Error('All price providers failed');
  }

  // ─── Cache wrapper ─────────────────────────────────────────────────────────
  private async getCachedOrFetch(
    asset: string,
    fetchFn: () => Promise<PriceData>
  ): Promise<PriceData | null> {
    const cached = await PriceCache.findOne({ asset }).sort({ timestamp: -1 });

    if (cached && Date.now() - cached.timestamp.getTime() < this.cacheTtlMs) {
      return {
        price: cached.price,
        currency: cached.currency,
        source: cached.source,
        timestamp: cached.timestamp,
      };
    }

    try {
      const data = await fetchFn();
      if (!Number.isFinite(data.price) || data.price <= 0) {
        throw new Error(`Invalid ${asset} price: ${data.price}`);
      }

      await PriceCache.create({
        asset,
        price: data.price,
        currency: data.currency,
        source: data.source,
        timestamp: new Date(),
      });

      return data;
    } catch (err: any) {
      console.error(`[PriceService] Fetch error for ${asset}:`, err.message);
      if (cached) {
        return {
          price: cached.price,
          currency: cached.currency,
          source: `${cached.source} (stale)`,
          timestamp: cached.timestamp,
        };
      }
      return null;
    }
  }

  // ─── ATF / USD ─────────────────────────────────────────────────────────────
  async getAtfPriceUsd(): Promise<PriceData | null> {
    return this.getCachedOrFetch('atf_usd', async () => {
      const atfAddress = config.atfJettonAddress;
      const primaryUrl =
        config.atfPriceApiUrl ||
        `https://api.ston.fi/v1/assets/${atfAddress}`;

      const providers: Provider[] = [
        {
          url: primaryUrl,
          extract: (d: any) =>
            d?.dex_price_usd ??
            d?.third_party_price_usd ??
            d?.price ??
            d?.asset?.price ??
            d?.asset?.dex_price_usd ??
            d?.asset?.third_party_price_usd ??
            d?.asset?.price_usd ??
            d?.asset?.market_price ??
            d?.asset?.pool_price_usd ??
            d?.price_usd ??
            d?.market_price_usd ??
            d?.pool_price_usd ??
            d?.last_price ??
            d?.current_price ??
            d?.data?.price ??
            d?.data?.dex_price_usd ??
            d?.data?.asset?.price ??
            d?.result?.price ??
            d?.result?.dex_price_usd ??
            d?.token?.price ??
            d?.token?.price_usd ??
            d?.usd ??
            d?.value ??
            d?.rate ??
            d?.price_24h?.usd ??
            d?.prices?.usd ??
            d?.current_price?.usd ??
            d?.priceUsd ??
            d?.price_usd,
        },
        {
          url: `https://api.ston.fi/v1/assets/${atfAddress}`,
          extract: (d: any) =>
            d?.dex_price_usd ??
            d?.third_party_price_usd ??
            d?.price ??
            d?.asset?.price ??
            d?.asset?.dex_price_usd ??
            d?.asset?.third_party_price_usd ??
            d?.asset?.price_usd ??
            d?.asset?.market_price ??
            d?.asset?.pool_price_usd ??
            d?.price_usd ??
            d?.market_price_usd ??
            d?.pool_price_usd ??
            d?.last_price ??
            d?.current_price ??
            d?.data?.price ??
            d?.data?.dex_price_usd ??
            d?.data?.asset?.price ??
            d?.result?.price ??
            d?.result?.dex_price_usd ??
            d?.token?.price ??
            d?.token?.price_usd ??
            d?.usd ??
            d?.value ??
            d?.rate ??
            d?.price_24h?.usd ??
            d?.prices?.usd ??
            d?.current_price?.usd ??
            d?.priceUsd ??
            d?.price_usd,
        },
      ];

      const { price, source } = await this.fetchWithProviders(providers);

      return {
        price,
        currency: 'USD',
        source,
        timestamp: new Date(),
      };
    });
  }

  // ─── TON / USD ─────────────────────────────────────────────────────────────
  async getTonPriceUsd(): Promise<PriceData | null> {
    return this.getCachedOrFetch('ton_usd', async () => {
      const providers: Provider[] = [
        {
          url:
            config.tonPriceApiUrl ||
            'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
          extract: (d: any) =>
            d?.['the-open-network']?.usd ?? d?.price ?? d?.usd,
        },
        {
          url: 'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
          extract: (d: any) => d?.['the-open-network']?.usd,
        },
        {
          url: 'https://api.binance.com/api/v3/ticker/price?symbol=TONUSDT',
          extract: (d: any) => d?.price,
        },
        {
          url: 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=TONUSDT',
          extract: (d: any) => d?.result?.list?.[0]?.lastPrice,
        },
        {
          url: 'https://www.okx.com/api/v5/market/ticker?instId=TON-USDT',
          extract: (d: any) => d?.data?.[0]?.last,
        },
      ];

      const { price, source } = await this.fetchWithProviders(providers);

      return {
        price,
        currency: 'USD',
        source,
        timestamp: new Date(),
      };
    });
  }

  // ─── USD / NGN ─────────────────────────────────────────────────────────────
  async getUsdNgnRate(): Promise<PriceData | null> {
    return this.getCachedOrFetch('usd_ngn', async () => {
      const providers: Provider[] = [
        {
          url:
            config.usdNgnRateApiUrl ||
            'https://api.frankfurter.dev/v2/rate/USD/NGN',
          extract: (d: any) => d?.rate ?? d?.rates?.NGN,
        },
        {
          url: 'https://api.frankfurter.dev/v2/rate/USD/NGN',
          extract: (d: any) => d?.rate ?? d?.rates?.NGN,
        },
        {
          url: 'https://api.exchangerate-api.com/v4/latest/USD',
          extract: (d: any) => d?.rates?.NGN,
        },
        {
          url: 'https://open.er-api.com/v6/latest/USD',
          extract: (d: any) => d?.rates?.NGN,
        },
      ];

      const { price, source } = await this.fetchWithProviders(providers);

      return {
        price,
        currency: 'NGN',
        source,
        timestamp: new Date(),
      };
    });
  }

  // ─── Derived: ATF → NGN ────────────────────────────────────────────────────
  async getAtfPriceNgn(): Promise<number | null> {
    const [atfUsd, usdNgn] = await Promise.all([
      this.getAtfPriceUsd(),
      this.getUsdNgnRate(),
    ]);
    if (!atfUsd || !usdNgn) return null;
    return atfUsd.price * usdNgn.price;
  }

  // ─── Derived: TON → NGN ────────────────────────────────────────────────────
  async getTonPriceNgn(): Promise<number | null> {
    const [tonUsd, usdNgn] = await Promise.all([
      this.getTonPriceUsd(),
      this.getUsdNgnRate(),
    ]);
    if (!tonUsd || !usdNgn) return null;
    return tonUsd.price * usdNgn.price;
  }

  // ─── Converters ────────────────────────────────────────────────────────────
  convertCryptoToUsd(amount: string, priceUsd: number, decimals: number): string {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || !Number.isFinite(priceUsd)) {
      return '0.00';
    }
    return (amt * priceUsd).toFixed(2);
  }

  convertUsdToNgn(usdAmount: string, ngnRate: number): string {
    const amt = parseFloat(usdAmount);
    if (!Number.isFinite(amt) || !Number.isFinite(ngnRate)) {
      return '0';
    }
    return Math.round(amt * ngnRate).toLocaleString('en-NG');
  }
}
