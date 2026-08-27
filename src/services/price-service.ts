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
        const response = await axios.get(url, { timeout: 10000 });
        return response.data;
      } catch {
        continue;
      }
    }
    throw new Error('All price providers failed');
  }

  private async getCachedOrFetch(asset: string, fetchFn: () => Promise<PriceData>): Promise<PriceData | null> {
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
      await PriceCache.create({
        asset,
        price: data.price,
        currency: data.currency,
        source: data.source,
        timestamp: new Date(),
      });
      return data;
    } catch (error) {
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

  async getAtfPriceUsd(): Promise<PriceData | null> {
    return this.getCachedOrFetch('atf_usd', async () => {
      if (config.atfPriceApiUrl) {
        const data = await this.fetchWithFallback([config.atfPriceApiUrl]);
        return {
          price: parseFloat(data.price || data.usd || data.aft?.usd),
          currency: 'USD',
          source: config.atfPriceApiUrl,
          timestamp: new Date(),
        };
      }
      throw new Error('No ATF price provider configured');
    });
  }

  async getTonPriceUsd(): Promise<PriceData | null> {
    return this.getCachedOrFetch('ton_usd', async () => {
      if (config.tonPriceApiUrl) {
        const data = await this.fetchWithFallback([config.tonPriceApiUrl]);
        return {
          price: parseFloat(data.price || data.usd || data.ton?.usd),
          currency: 'USD',
          source: config.tonPriceApiUrl,
          timestamp: new Date(),
        };
      }
      const data = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
        { timeout: 10000 }
      );
      return {
        price: data.data['the-open-network'].usd,
        currency: 'USD',
        source: 'coingecko',
        timestamp: new Date(),
      };
    });
  }

  async getUsdNgnRate(): Promise<PriceData | null> {
    return this.getCachedOrFetch('usd_ngn', async () => {
      if (config.usdNgnRateApiUrl) {
        const data = await this.fetchWithFallback([config.usdNgnRateApiUrl]);
        return {
          price: parseFloat(data.rate || data.ngn || data.usd_ngn),
          currency: 'NGN',
          source: config.usdNgnRateApiUrl,
          timestamp: new Date(),
        };
      }
      const data = await axios.get(
        'https://api.exchangerate-api.com/v4/latest/USD',
        { timeout: 10000 }
      );
      return {
        price: data.data.rates.NGN,
        currency: 'NGN',
        source: 'exchangerate-api',
        timestamp: new Date(),
      };
    });
  }

  async getAtfPriceNgn(): Promise<number | null> {
    const [aftUsd, usdNgn] = await Promise.all([
      this.getAtfPriceUsd(),
      this.getUsdNgnRate(),
    ]);
    if (!aftUsd || !usdNgn) return null;
    return aftUsd.price * usdNgn.price;
  }

  async getTonPriceNgn(): Promise<number | null> {
    const [tonUsd, usdNgn] = await Promise.all([
      this.getTonPriceUsd(),
      this.getUsdNgnRate(),
    ]);
    if (!tonUsd || !usdNgn) return null;
    return tonUsd.price * usdNgn.price;
  }

  convertCryptoToUsd(amount: string, priceUsd: number, decimals: number): string {
    const amt = parseFloat(amount);
    return (amt * priceUsd).toFixed(2);
  }

  convertUsdToNgn(usdAmount: string, ngnRate: number): string {
    const amt = parseFloat(usdAmount);
    return Math.round(amt * ngnRate).toLocaleString('en-NG');
  }
          }
  
