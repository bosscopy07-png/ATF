import axios from 'axios';
import { PriceCache } from '../models/PriceCache';
import { config } from '../config';

export interface PriceData {
  price: number;
  currency: string;
  source: string;
  timestamp: Date;
}

export class PriceService {
  private static instance: PriceService;
  private cacheTtlMs = 60000;

  private constructor() {}

  static getInstance(): PriceService {
    if (!PriceService.instance) {
      PriceService.instance = new PriceService();
    }

    return PriceService.instance;
  }

  private async fetchWithFallback(urls: string[]): Promise<any> {
    for (const url of urls) {
      if (!url) continue;

      try {
        const response = await axios.get(url, {
          timeout: 10000,
          headers: {
            Accept: 'application/json',
          },
        });

        return response.data;
      } catch {
        continue;
      }
    }

    throw new Error('All price providers failed');
  }

  private async getCachedOrFetch(
    asset: string,
    fetchFn: () => Promise<PriceData>
  ): Promise<PriceData | null> {
    const cached = await PriceCache.findOne({ asset }).sort({
      timestamp: -1,
    });

    if (
      cached &&
      Date.now() - cached.timestamp.getTime() < this.cacheTtlMs
    ) {
      return {
        price: cached.price,
        currency: cached.currency,
        source: cached.source,
        timestamp: cached.timestamp,
      };
    }

    try {
      const data = await fetchFn();

      if (!Number.isFinite(data.price)) {
        throw new Error(`Invalid ${asset} price received`);
      }

      await PriceCache.create({
        asset,
        price: data.price,
        currency: data.currency,
        source: data.source,
        timestamp: new Date(),
      });

      return data;
    } catch {
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

  /**
   * Get ATF price in USD.
   *
   * Primary source:
   * STON.fi asset API using the ATF Jetton master address.
   */
  async getAtfPriceUsd(): Promise<PriceData | null> {
    return this.getCachedOrFetch('atf_usd', async () => {
      const atfJettonAddress =
        'EQANcW45W0Tp91bzvHayaPO6-6hf1Lm4XlWZ4rN6L5ofPWdb';

      const stonfiUrl =
        config.atfPriceApiUrl ||
        `https://api.ston.fi/v1/assets/${atfJettonAddress}`;

      const data = await this.fetchWithFallback([stonfiUrl]);

      /*
       * STON.fi returns the DEX USD price as dex_price_usd.
       *
       * Keep the additional fallbacks so the service remains
       * compatible with another configured ATF price provider.
       */
      const price = parseFloat(
        data?.dex_price_usd ??
          data?.price ??
          data?.usd ??
          data?.atf?.usd ??
          data?.third_party_price_usd
      );

      if (!Number.isFinite(price)) {
        throw new Error('Invalid ATF USD price returned by provider');
      }

      return {
        price,
        currency: 'USD',
        source: stonfiUrl,
        timestamp: new Date(),
      };
    });
  }

  /**
   * Get TON price in USD.
   *
   * Uses configured provider first.
   * Falls back to CoinGecko.
   */
  async getTonPriceUsd(): Promise<PriceData | null> {
    return this.getCachedOrFetch('ton_usd', async () => {
      if (config.tonPriceApiUrl) {
        const data = await this.fetchWithFallback([
          config.tonPriceApiUrl,
        ]);

        const price = parseFloat(
          data?.price ??
            data?.usd ??
            data?.ton?.usd
        );

        if (!Number.isFinite(price)) {
          throw new Error('Invalid TON USD price returned by provider');
        }

        return {
          price,
          currency: 'USD',
          source: config.tonPriceApiUrl,
          timestamp: new Date(),
        };
      }

      const response = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
        {
          timeout: 10000,
          headers: {
            Accept: 'application/json',
          },
        }
      );

      const price = Number(
        response.data?.['the-open-network']?.usd
      );

      if (!Number.isFinite(price)) {
        throw new Error('Invalid TON price returned by CoinGecko');
      }

      return {
        price,
        currency: 'USD',
        source: 'coingecko',
        timestamp: new Date(),
      };
    });
  }

  /**
   * Get USD to NGN exchange rate.
   *
   * Uses configured provider first.
   * Falls back to ExchangeRate-API.
   */
  async getUsdNgnRate(): Promise<PriceData | null> {
    return this.getCachedOrFetch('usd_ngn', async () => {
      if (config.usdNgnRateApiUrl) {
        const data = await this.fetchWithFallback([
          config.usdNgnRateApiUrl,
        ]);

        const price = parseFloat(
          data?.rate ??
            data?.ngn ??
            data?.usd_ngn
        );

        if (!Number.isFinite(price)) {
          throw new Error(
            'Invalid USD/NGN rate returned by provider'
          );
        }

        return {
          price,
          currency: 'NGN',
          source: config.usdNgnRateApiUrl,
          timestamp: new Date(),
        };
      }

      const response = await axios.get(
        'https://api.exchangerate-api.com/v4/latest/USD',
        {
          timeout: 10000,
          headers: {
            Accept: 'application/json',
          },
        }
      );

      const price = Number(response.data?.rates?.NGN);

      if (!Number.isFinite(price)) {
        throw new Error('Invalid USD/NGN rate returned by ExchangeRate-API');
      }

      return {
        price,
        currency: 'NGN',
        source: 'exchangerate-api',
        timestamp: new Date(),
      };
    });
  }

  /**
   * Convert ATF price from USD to NGN.
   */
  async getAtfPriceNgn(): Promise<number | null> {
    const [atfUsd, usdNgn] = await Promise.all([
      this.getAtfPriceUsd(),
      this.getUsdNgnRate(),
    ]);

    if (!atfUsd || !usdNgn) {
      return null;
    }

    return atfUsd.price * usdNgn.price;
  }

  /**
   * Convert TON price from USD to NGN.
   */
  async getTonPriceNgn(): Promise<number | null> {
    const [tonUsd, usdNgn] = await Promise.all([
      this.getTonPriceUsd(),
      this.getUsdNgnRate(),
    ]);

    if (!tonUsd || !usdNgn) {
      return null;
    }

    return tonUsd.price * usdNgn.price;
  }

  /**
   * Convert crypto amount to USD.
   */
  convertCryptoToUsd(
    amount: string,
    priceUsd: number,
    decimals: number
  ): string {
    const amt = parseFloat(amount);

    if (!Number.isFinite(amt) || !Number.isFinite(priceUsd)) {
      return '0.00';
    }

    return (amt * priceUsd).toFixed(2);
  }

  /**
   * Convert USD amount to NGN.
   */
  convertUsdToNgn(
    usdAmount: string,
    ngnRate: number
  ): string {
    const amt = parseFloat(usdAmount);

    if (!Number.isFinite(amt) || !Number.isFinite(ngnRate)) {
      return '0';
    }

    return Math.round(amt * ngnRate).toLocaleString('en-NG');
  }
}
