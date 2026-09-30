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
  name: string;
  url: string;
  headers?: Record<string, string>;
  extract: (data: any) => number | string | ProviderResult | null;
}

/* ─────────────────────────────────────────────
   🔐 TONAPI
   NOTE:
   Keep this key out of logs and user-facing output.
   Rotate the credential previously pasted into chat.
   ───────────────────────────────────────────── */

const TONAPI_KEY = 'AF7REGDCFASR4BQAAAADDBL2HHXD67ZQPQDXXACJULJ2DUORN5ZVHJ3WSRQ3O2M2MBNPGAI';

/* ─────────────────────────────────────────────
   🧭 Shared helpers
   ───────────────────────────────────────────── */

export const cleanSource = (
  p: Pick<PriceData, 'source'> | null,
): string =>
  (p?.source ?? '').replace(' (stale)', '');

export const isStale = (
  p: PriceData | null,
): boolean =>
  !!p?.source?.includes('(stale)');

/* ─────────────────────────────────────────────
   💹 Price Service
   ───────────────────────────────────────────── */

export class PriceService {
  private static instance: PriceService;

  private readonly cacheTtlMs =
    config.priceCacheTtlMs || 60_000;

  private readonly providerTimeoutMs = 5_000;

  private constructor() {}

  static getInstance(): PriceService {
    if (!PriceService.instance) {
      PriceService.instance = new PriceService();
    }

    return PriceService.instance;
  }

  /* ─────────────────────────────────────────────
     🔗 Chart URLs
     ───────────────────────────────────────────── */

  getChartUrl(
    asset: 'atf' | 'ton',
  ): string | null {
    if (asset === 'atf') {
      const address = config.atfJettonAddress;

      return address
        ? `https://dexscreener.com/ton/${address}`
        : null;
    }

    return 'https://www.coingecko.com/en/coins/toncoin';
  }

  /* ─────────────────────────────────────────────
     🌐 Generic provider request
     ───────────────────────────────────────────── */

  private async fetchFromProvider(
    provider: Provider,
  ): Promise<ProviderResult | null> {
    try {
      const response = await axios.get(
        provider.url,
        {
          timeout: this.providerTimeoutMs,
          headers: {
            Accept: 'application/json',
            ...(provider.headers || {}),
          },
          validateStatus: (status) =>
            status >= 200 && status < 300,
        },
      );

      const raw = provider.extract(response.data);

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
        typeof raw === 'object' &&
        raw !== null
      ) {
        price =
          typeof raw.price === 'string'
            ? parseFloat(raw.price)
            : Number(raw.price);

        change24hPercent =
          raw.change24hPercent != null
            ? Number(raw.change24hPercent)
            : null;
      } else {
        price =
          typeof raw === 'string'
            ? parseFloat(raw)
            : Number(raw);
      }

      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return null;
      }

      const normalizedChange =
        change24hPercent != null &&
        Number.isFinite(
          Number(change24hPercent),
        )
          ? Number(change24hPercent)
          : null;

      return {
        price,
        change24hPercent:
          normalizedChange,
      };
    } catch (error: any) {
      /*
       * Never log API credentials or Authorization
       * headers.
       */
      console.warn(
        `[PriceService] Provider failed: ${provider.name} — ${
          error?.message || error
        }`,
      );

      return null;
    }
  }

  /* ─────────────────────────────────────────────
     🔄 Provider chain
     ───────────────────────────────────────────── */

  private async fetchWithProviders(
    providers: Provider[],
  ): Promise<{
    price: number;
    source: string;
    change24hPercent: number | null;
  }> {
    for (const provider of providers) {
      if (!provider.url) {
        continue;
      }

      const result =
        await this.fetchFromProvider(provider);

      if (
        result &&
        Number.isFinite(result.price) &&
        result.price > 0
      ) {
        return {
          price: result.price,
          source: provider.name,
          change24hPercent:
            result.change24hPercent ?? null,
        };
      }
    }

    throw new Error(
      'All price providers failed',
    );
  }

  /* ─────────────────────────────────────────────
     💾 Cache + stale fallback
     ───────────────────────────────────────────── */

  private async getCachedOrFetch(
    asset: string,
    fetchFn: () => Promise<PriceData>,
  ): Promise<PriceData | null> {
    const cached =
      await PriceCache.findOne({
        asset,
      }).sort({
        timestamp: -1,
      });

    /*
     * Fresh cache.
     */
    if (
      cached &&
      Date.now() -
        cached.timestamp.getTime() <
        this.cacheTtlMs
    ) {
      return {
        price: cached.price,
        currency: cached.currency,
        source: cached.source,
        timestamp: cached.timestamp,
        change24hPercent:
          cached.change24hPercent ?? null,
      };
    }

    try {
      const data =
        await fetchFn();

      if (
        !Number.isFinite(data.price) ||
        data.price <= 0
      ) {
        throw new Error(
          `Invalid ${asset} price`,
        );
      }

      /*
       * If provider doesn't provide 24h movement,
       * calculate an observation-based change.
       */
      let change =
        data.change24hPercent ?? null;

      if (
        change === null &&
        cached &&
        cached.price > 0
      ) {
        change =
          ((data.price - cached.price) /
            cached.price) *
          100;
      }

      await PriceCache.create({
        asset,
        price: data.price,
        currency: data.currency,
        source: data.source,
        timestamp: new Date(),
        change24hPercent: change,
      });

      return {
        ...data,
        change24hPercent: change,
      };
    } catch (error: any) {
      console.error(
        `[PriceService] Fetch error for ${asset}:`,
        error?.message || error,
      );

      /*
       * Final safety net.
       */
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

  async getAtfPriceUsd():
    Promise<PriceData | null> {
    return this.getCachedOrFetch(
      'atf_usd',
      async () => {
        const address =
          config.atfJettonAddress;

        if (!address) {
          throw new Error(
            'ATF jetton address is not configured',
          );
        }

        const providers: Provider[] = [
          {
            name: 'STON.fi',
            url:
              config.atfPriceApiUrl ||
              `https://api.ston.fi/v1/assets/${address}`,
            extract: (d: any) => ({
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

          {
            name: 'DexScreener',
            url:
              `https://api.dexscreener.com/latest/dex/tokens/${address}`,

            extract: (d: any) => {
              const pairs =
                Array.isArray(d?.pairs)
                  ? d.pairs
                  : [];

              const pair =
                pairs.find(
                  (p: any) =>
                    Number.isFinite(
                      Number(
                        p?.priceUsd,
                      ),
                    ),
                ) ||
                pairs[0];

              return {
                price: pair?.priceUsd,
                change24hPercent:
                  pair?.priceChange?.h24 ??
                  null,
              };
            },
          },

          {
            name: 'CoinGecko',
            url:
              `https://api.coingecko.com/api/v3/simple/token_price/ton?contract_addresses=${address}&vs_currencies=usd&include_24hr_change=true`,

            extract: (d: any) => {
              const row =
                d?.[
                  String(address).toLowerCase()
                ] ||
                (Object.values(
                  d || {},
                )[0] as any);

              return {
                price: row?.usd,
                change24hPercent:
                  row?.usd_24h_change ??
                  null,
              };
            },
          },

          {
            name: 'GeckoTerminal',
            url:
              `https://api.geckoterminal.com/api/v2/simple/networks/ton/token_price/${address}`,

            extract: (d: any) => {
              const prices =
                d?.data?.attributes
                  ?.token_prices;

              const key =
                Object.keys(
                  prices || {},
                )[0];

              return prices?.[key]
                ? {
                    price:
                      prices[key],
                    change24hPercent:
                      null,
                  }
                : null;
            },
          },
        ];

        const {
          price,
          source,
          change24hPercent,
        } =
          await this.fetchWithProviders(
            providers,
          );

        return {
          price,
          currency: 'USD',
          source,
          timestamp: new Date(),
          change24hPercent,
        };
      },
    );
  }

  /* ─────────────────────────────────────────────
     💎 TON / USD
     ───────────────────────────────────────────── */

  async getTonPriceUsd():
    Promise<PriceData | null> {
    return this.getCachedOrFetch(
      'ton_usd',
      async () => {
        const providers: Provider[] = [
          /* ─────────────────────────────
             1️⃣ Bybit
             ───────────────────────────── */

          {
            name: 'Bybit',
            url:
              'https://api.bybit.com/v5/market/tickers?category=spot&symbol=TONUSDT',

            extract: (d: any) => {
              const item =
                d?.result?.list?.[0];

              const price =
                parseFloat(
                  item?.lastPrice,
                );

              const chg =
                parseFloat(
                  item?.price24hPcnt,
                );

              return {
                price,
                change24hPercent:
                  Number.isFinite(chg)
                    ? chg * 100
                    : null,
              };
            },
          },

          /* ─────────────────────────────
             2️⃣ OKX
             ───────────────────────────── */

          {
            name: 'OKX',
            url:
              'https://www.okx.com/api/v5/market/ticker?instId=TON-USDT',

            extract: (d: any) => {
              const item =
                d?.data?.[0];

              const last =
                parseFloat(item?.last);

              const open =
                parseFloat(item?.open24h);

              return {
                price: last,

                change24hPercent:
                  Number.isFinite(last) &&
                  Number.isFinite(open) &&
                  open > 0
                    ? ((last - open) /
                        open) *
                      100
                    : null,
              };
            },
          },

          /* ─────────────────────────────
             3️⃣ MEXC
             ───────────────────────────── */

          {
            name: 'MEXC',
            url:
              'https://api.mexc.com/api/v3/ticker/24hr?symbol=TONUSDT',

            extract: (d: any) => ({
              price:
                parseFloat(
                  d?.lastPrice,
                ),

              change24hPercent:
                d?.priceChangePercent !=
                null
                  ? parseFloat(
                      d.priceChangePercent,
                    )
                  : null,
            }),
          },

          /* ─────────────────────────────
             4️⃣ KuCoin
             ───────────────────────────── */

          {
            name: 'KuCoin',
            url:
              'https://api.kucoin.com/api/v1/market/stats?symbol=TON-USDT',

            extract: (d: any) => {
              const price =
                parseFloat(
                  d?.data?.last,
                );

              const rate =
                parseFloat(
                  d?.data?.changeRate,
                );

              return {
                price,

                change24hPercent:
                  Number.isFinite(rate)
                    ? rate * 100
                    : null,
              };
            },
          },

          /* ─────────────────────────────
             5️⃣ Binance
             ───────────────────────────── */

          {
            name: 'Binance',
            url:
              'https://api.binance.com/api/v3/ticker/24hr?symbol=TONUSDT',

            extract: (d: any) => ({
              price:
                parseFloat(
                  d?.lastPrice ??
                    d?.price,
                ),

              change24hPercent:
                d?.priceChangePercent !=
                null
                  ? parseFloat(
                      d.priceChangePercent,
                    )
                  : null,
            }),
          },

          /* ─────────────────────────────
             6️⃣ TONAPI
             ─────────────────────────────
             
             TONAPI calculates TON-chain
             rates from indexed liquidity
             pools and TON ecosystem data.

             The endpoint returns rates for
             requested token/currency pairs.
             ───────────────────────────── */

          {
            name: 'TONAPI',
            url:
              'https://tonapi.io/v2/rates?tokens=TON&currencies=USD',

            headers:
              TONAPI_KEY &&
              !TONAPI_KEY.includes(
                'PASTE_YOUR',
              )
                ? {
                    Authorization:
                      `Bearer ${TONAPI_KEY}`,
                  }
                : {},

            extract: (d: any) => {
              /*
               * TONAPI response compatibility.
               *
               * Depending on API version,
               * rate data can be represented
               * under rates.TON or rates.ton.
               */

              const rates =
                d?.rates ||
                d?.data?.rates ||
                d;

              const ton =
                rates?.TON ||
                rates?.ton ||
                rates?.['TON'];

              if (!ton) {
                return null;
              }

              let price: number;

              if (
                typeof ton ===
                'number'
              ) {
                price = ton;
              } else {
                price =
                  Number(
                    ton?.prices?.USD ??
                      ton?.USD ??
                      ton?.usd ??
                      ton?.price ??
                      ton?.rate,
                  );
              }

              return {
                price,
                change24hPercent:
                  null,
              };
            },
          },

          /* ─────────────────────────────
             7️⃣ CoinCap
             ───────────────────────────── */

          {
            name: 'CoinCap',
            url:
              'https://api.coincap.io/v2/assets/toncoin',

            extract: (d: any) => ({
              price:
                parseFloat(
                  d?.data?.priceUsd,
                ),

              change24hPercent:
                d?.data
                  ?.changePercent24Hr !=
                null
                  ? parseFloat(
                      d.data
                        .changePercent24Hr,
                    )
                  : null,
            }),
          },

          /* ─────────────────────────────
             8️⃣ CoinPaprika
             ───────────────────────────── */

          {
            name: 'CoinPaprika',
            url:
              'https://api.coinpaprika.com/v1/tickers/ton-toncoin',

            extract: (d: any) => ({
              price:
                d?.quotes?.USD?.price,

              change24hPercent:
                d?.quotes?.USD
                  ?.percent_change_24h ??
                null,
            }),
          },

          /* ─────────────────────────────
             9️⃣ CryptoCompare
             ───────────────────────────── */

          {
            name: 'CryptoCompare',
            url:
              'https://min-api.cryptocompare.com/data/price?fsym=TON&tsyms=USD',

            extract: (d: any) => ({
              price: d?.USD,
              change24hPercent:
                null,
            }),
          },

          /* ─────────────────────────────
             🔟 CoinGecko
             Last because of possible
             rate limits.
             ───────────────────────────── */

          {
            name: 'CoinGecko',
            url:
              config.tonPriceApiUrl ||
              'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd&include_24hr_change=true',

            extract: (d: any) => ({
              price:
                d?.['the-open-network']
                  ?.usd,

              change24hPercent:
                d?.['the-open-network']
                  ?.usd_24h_change ??
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
            providers,
          );

        return {
          price,
          currency: 'USD',
          source,
          timestamp: new Date(),
          change24hPercent,
        };
      },
    );
  }

  /* ─────────────────────────────────────────────
     🇳🇬 USD / NGN
     ───────────────────────────────────────────── */

  async getUsdNgnRate():
    Promise<PriceData | null> {
    return this.getCachedOrFetch(
      'usd_ngn',
      async () => {
        const providers: Provider[] = [
          {
            name: 'Frankfurter',
            url:
              config.usdNgnRateApiUrl ||
              'https://api.frankfurter.dev/v2/rate/USD/NGN',

            extract: (d: any) => ({
              price:
                d?.rate ??
                d?.rates?.NGN,
              change24hPercent:
                null,
            }),
          },

          {
            name: 'ExchangeRate API',
            url:
              'https://api.exchangerate-api.com/v4/latest/USD',

            extract: (d: any) => ({
              price:
                d?.rates?.NGN,
              change24hPercent:
                null,
            }),
          },

          {
            name: 'Open ER API',
            url:
              'https://open.er-api.com/v6/latest/USD',

            extract: (d: any) => ({
              price:
                d?.rates?.NGN,
              change24hPercent:
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
            providers,
          );

        return {
          price,
          currency: 'NGN',
          source,
          timestamp: new Date(),
          change24hPercent,
        };
      },
    );
  }

  /* ─────────────────────────────────────────────
     🇳🇬 ATF / NGN
     ───────────────────────────────────────────── */

  async getAtfPriceNgn():
    Promise<number | null> {
    const [
      atfUsd,
      usdNgn,
    ] = await Promise.all([
      this.getAtfPriceUsd(),
      this.getUsdNgnRate(),
    ]);

    return atfUsd &&
      usdNgn
      ? atfUsd.price *
          usdNgn.price
      : null;
  }

  /* ─────────────────────────────────────────────
     🇳🇬 TON / NGN
     ───────────────────────────────────────────── */

  async getTonPriceNgn():
    Promise<number | null> {
    const [
      tonUsd,
      usdNgn,
    ] = await Promise.all([
      this.getTonPriceUsd(),
      this.getUsdNgnRate(),
    ]);

    return tonUsd &&
      usdNgn
      ? tonUsd.price *
          usdNgn.price
      : null;
  }

  /* ─────────────────────────────────────────────
     💱 Crypto → USD
     ───────────────────────────────────────────── */

  convertCryptoToUsd(
    amount: string,
    priceUsd: number,
    _decimals: number,
  ): string {
    const amt =
      parseFloat(amount);

    if (
      !Number.isFinite(amt) ||
      !Number.isFinite(priceUsd)
    ) {
      return '0.00';
    }

    return (
      amt * priceUsd
    ).toFixed(2);
  }

  /* ─────────────────────────────────────────────
     💱 USD → NGN
     ───────────────────────────────────────────── */
convertUsdToNgn(
    usdAmount: string,
    ngnRate: number,
  ): string {
    const amt =
      parseFloat(usdAmount);

    if (
      !Number.isFinite(amt) ||
      !Number.isFinite(ngnRate)
    ) {
      return '0';
    }

    return String(
      Math.round(
        amt * ngnRate,
      ),
    );
  }
}
