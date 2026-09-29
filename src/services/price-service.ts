import axios from 'axios';
import { PriceCache } from '../models/PriceCache';
import { config } from '../config';

export interface PriceData {
  price: number;
  currency: string;
  source: string;
  timestamp: Date;

  /**
   * Provider-supplied 24h movement where available.
   *
   * If the provider doesn't provide it, the service falls back
   * to the previous cached observation.
   */
  change24hPercent?: number | null;
}

interface ProviderResult {
  price: number;
  change24hPercent?: number | null;
}

interface Provider {
  url: string;

  extract: (
    data: any
  ) => number | string | ProviderResult | null;
}

export class PriceService {
  private static instance: PriceService;

  private cacheTtlMs =
    config.priceCacheTtlMs ||
    60000;

  private constructor() {}

  static getInstance(): PriceService {
    if (!PriceService.instance) {
      PriceService.instance =
        new PriceService();
    }

    return PriceService.instance;
  }

  private async fetchFromProvider(
    provider: Provider
  ): Promise<ProviderResult | null> {
    try {
      const response =
        await axios.get(
          provider.url,
          {
            timeout: 7000,

            headers: {
              Accept:
                'application/json',
            },
          }
        );

      const raw =
        provider.extract(
          response.data
        );

      if (
        raw === null ||
        raw === undefined
      ) {
        return null;
      }

      let price: number;

      let change24hPercent:
        | number
        | null
        | undefined;

      if (
        typeof raw ===
        'object'
      ) {
        price =
          typeof raw.price ===
          'string'
            ? parseFloat(
                raw.price
              )
            : raw.price;

        change24hPercent =
          raw.change24hPercent;
      } else {
        price =
          typeof raw ===
          'string'
            ? parseFloat(
                raw
              )
            : raw;
      }

      if (
        !Number.isFinite(
          price
        ) ||
        price <= 0
      ) {
        return null;
      }

      return {
        price,

        change24hPercent:
          Number.isFinite(
            change24hPercent as number
          )
            ? change24hPercent
            : null,
      };
    } catch (
      error: any
    ) {
      console.warn(
        `[PriceService] Provider failed ${provider.url}: ${error?.message || error}`
      );

      return null;
    }
  }

  private async fetchWithProviders(
    providers: Provider[]
  ): Promise<{
    price: number;
    source: string;
    change24hPercent:
      | number
      | null;
  }> {
    for (
      const provider of providers
    ) {
      if (!provider.url) {
        continue;
      }

      const result =
        await this.fetchFromProvider(
          provider
        );

      if (
        result &&
        result.price > 0
      ) {
        return {
          price:
            result.price,

          source:
            provider.url,

          change24hPercent:
            result.change24hPercent ??
            null,
        };
      }
    }

    throw new Error(
      'All price providers failed'
    );
  }

  private async getCachedOrFetch(
    asset: string,

    fetchFn: () => Promise<PriceData>
  ): Promise<PriceData | null> {
    const cached =
      await PriceCache.findOne({
        asset,
      }).sort({
        timestamp: -1,
      });

    /**
     * Return fresh cache immediately.
     */
    if (
      cached &&
      Date.now() -
        cached.timestamp.getTime() <
        this.cacheTtlMs
    ) {
      return {
        price:
          cached.price,

        currency:
          cached.currency,

        source:
          cached.source,

        timestamp:
          cached.timestamp,

        change24hPercent:
          null,
      };
    }

    try {
      const data =
        await fetchFn();

      if (
        !Number.isFinite(
          data.price
        ) ||
        data.price <= 0
      ) {
        throw new Error(
          `Invalid ${asset} price`
        );
      }

      /**
       * If the provider does not give 24h movement,
       * compare against the previous cached observation.
       */
      let change =
        data.change24hPercent ??
        null;

      if (
        change === null &&
        cached &&
        cached.price > 0
      ) {
        change =
          ((data.price -
            cached.price) /
            cached.price) *
          100;
      }

      await PriceCache.create({
        asset,

        price:
          data.price,

        currency:
          data.currency,

        source:
          data.source,

        timestamp:
          new Date(),
      });

      return {
        ...data,

        change24hPercent:
          change,
      };
    } catch (
      error: any
    ) {
      console.error(
        `[PriceService] Fetch error for ${asset}:`,
        error?.message ||
          error
      );

      /**
       * Cached price is the final safety net.
       */
      if (cached) {
        return {
          price:
            cached.price,

          currency:
            cached.currency,

          source:
            `${cached.source} (stale)`,

          timestamp:
            cached.timestamp,

          change24hPercent:
            null,
        };
      }

      return null;
    }
  }

  /* ─────────────────────────────────────────────
     ATF / USD
     ───────────────────────────────────────────── */

  async getAtfPriceUsd(): Promise<PriceData | null> {
    return this.getCachedOrFetch(
      'atf_usd',

      async () => {
        const address =
          config.atfJettonAddress;

        const providers:
          Provider[] = [
            {
              url:
                config.atfPriceApiUrl ||
                `https://api.ston.fi/v1/assets/${address}`,

              extract:
                (d: any) => ({
                  price:
                    d?.dex_price_usd ??
                    d?.third_party_price_usd ??
                    d?.price ??
                    d?.asset?.price ??
                    d?.asset?.dex_price_usd ??
                    d?.asset?.price_usd ??
                    d?.price_usd ??
                    d?.data?.price,

                  change24hPercent:
                    d?.price_change_24h ??
                    d?.priceChange24h ??
                    d?.change_24h ??
                    d?.asset?.price_change_24h ??
                    null,
                }),
            },

            /**
             * Backup 1:
             * Dexscreener.
             */
            {
              url:
                `https://api.dexscreener.com/latest/dex/tokens/${address}`,

              extract:
                (d: any) => {
                  const pair =
                    d?.pairs?.find(
                      (p: any) =>
                        Number.isFinite(
                          Number(
                            p?.priceUsd
                          )
                        )
                    ) ||
                    d?.pairs?.[0];

                  return {
                    price:
                      pair?.priceUsd,

                    change24hPercent:
                      pair?.priceChange
                        ?.h24 ??
                      null,
                  };
                },
            },

            /**
             * Backup 2:
             * Alternative STON endpoint.
             */
            {
              url:
                `https://api.ston.fi/v1/assets/${address}`,

              extract:
                (d: any) => ({
                  price:
                    d?.dex_price_usd ??
                    d?.third_party_price_usd ??
                    d?.price ??
                    d?.price_usd,

                  change24hPercent:
                    d?.price_change_24h ??
                    null,
                }),
            },
          ];

        const {
          price,
          source,
          change24hPercent,
        } =
          await this.fetchWithProviders(
            providers
          );

        return {
          price,

          currency:
            'USD',

          source,

          timestamp:
            new Date(),

          change24hPercent,
        };
      }
    );
  }

  /* ─────────────────────────────────────────────
     TON / USD
     ───────────────────────────────────────────── */

  async getTonPriceUsd(): Promise<PriceData | null> {
    return this.getCachedOrFetch(
      'ton_usd',

      async () => {
        const providers:
          Provider[] = [
            {
              url:
                config.tonPriceApiUrl ||
                'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd&include_24hr_change=true',

              extract:
                (d: any) => ({
                  price:
                    d?.[
                      'the-open-network'
                    ]?.usd,

                  change24hPercent:
                    d?.[
                      'the-open-network'
                    ]
                      ?.usd_24h_change ??
                    null,
                }),
            },

            {
              url:
                'https://api.binance.com/api/v3/ticker/24hr?symbol=TONUSDT',

              extract:
                (d: any) => ({
                  price:
                    d?.lastPrice ??
                    d?.price,

                  change24hPercent:
                    d?.priceChangePercent ??
                    null,
                }),
            },

            {
              url:
                'https://api.bybit.com/v5/market/tickers?category=spot&symbol=TONUSDT',

              extract:
                (d: any) => {
                  const item =
                    d?.result
                      ?.list?.[0];

                  return {
                    price:
                      item?.lastPrice,

                    change24hPercent:
                      item?.price24hPcnt
                        ? Number(
                            item.price24hPcnt
                          ) * 100
                        : null,
                  };
                },
            },

            {
              url:
                'https://www.okx.com/api/v5/market/ticker?instId=TON-USDT',

              extract:
                (d: any) => ({
                  price:
                    d?.data?.[0]
                      ?.last,

                  change24hPercent:
                    d?.data?.[0]
                      ?.sodUtc8
                      ? null
                      : null,
                }),
            },
          ];

        const {
          price,
          source,
          change24hPercent,
        } =
          await this.fetchWithProviders(
            providers
          );

        return {
          price,

          currency:
            'USD',

          source,

          timestamp:
            new Date(),

          change24hPercent,
        };
      }
    );
  }

  /* ─────────────────────────────────────────────
     USD / NGN
     ───────────────────────────────────────────── */

  async getUsdNgnRate(): Promise<PriceData | null> {
    return this.getCachedOrFetch(
      'usd_ngn',

      async () => {
        const providers:
          Provider[] = [
            {
              url:
                config.usdNgnRateApiUrl ||
                'https://api.frankfurter.dev/v2/rate/USD/NGN',

              extract:
                (d: any) =>
                  d?.rate ??
                  d?.rates?.NGN,
            },

            {
              url:
                'https://api.exchangerate-api.com/v4/latest/USD',

              extract:
                (d: any) =>
                  d?.rates?.NGN,
            },

            {
              url:
                'https://open.er-api.com/v6/latest/USD',

              extract:
                (d: any) =>
                  d?.rates?.NGN,
            },
          ];

        const {
          price,
          source,
          change24hPercent,
        } =
          await this.fetchWithProviders(
            providers
          );

        return {
          price,

          currency:
            'NGN',

          source,

          timestamp:
            new Date(),

          change24hPercent,
        };
      }
    );
  }

  async getAtfPriceNgn(): Promise<number | null> {
    const [
      atfUsd,
      usdNgn,
    ] =
      await Promise.all([
        this.getAtfPriceUsd(),
        this.getUsdNgnRate(),
      ]);

    if (
      !atfUsd ||
      !usdNgn
    ) {
      return null;
    }

    return (
      atfUsd.price *
      usdNgn.price
    );
  }

  async getTonPriceNgn(): Promise<number | null> {
    const [
      tonUsd,
      usdNgn,
    ] =
      await Promise.all([
        this.getTonPriceUsd(),
        this.getUsdNgnRate(),
      ]);

    if (
      !tonUsd ||
      !usdNgn
    ) {
      return null;
    }

    return (
      tonUsd.price *
      usdNgn.price
    );
  }

  convertCryptoToUsd(
    amount: string,
    priceUsd: number,
    _decimals: number
  ): string {
    const amt =
      parseFloat(amount);

    if (
      !Number.isFinite(
        amt
      ) ||
      !Number.isFinite(
        priceUsd
      )
    ) {
      return '0.00';
    }

    return (
      amt *
      priceUsd
    ).toFixed(2);
  }

  convertUsdToNgn(
    usdAmount: string,
    ngnRate: number
  ): string {
    const amt =
      parseFloat(
        usdAmount
      );

    if (
      !Number.isFinite(
        amt
      ) ||
      !Number.isFinite(
        ngnRate
      )
    ) {
      return '0';
    }

    return Math.round(
      amt * ngnRate
    ).toLocaleString(
      'en-NG'
    );
  }
  }
