import { Address } from '@ton/core';
import Decimal from 'decimal.js';
import { config, TON_DECIMALS, ATF_DECIMALS } from '../config';
import { PriceService } from './price-service';
import { Precision } from '../utils/precision';
import {
  DiscoveredJetton,
  WalletAssetDiscoveryService,
} from './wallet-asset-discovery';

export type ValuationStatus = 'valued' | 'price_unavailable' | 'balance_unavailable';

export interface PortfolioLine {
  masterAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  balanceBase: string;
  balanceDisplay: string;
  priceUsd: string | null;
  priceSource: string | null;
  priceUpdatedAt: Date | null;
  valueUsd: string | null;
  valueNgn: string | null;
  valuationStatus: ValuationStatus;
}

export interface PortfolioSummary {
  ton: PortfolioLine;
  atf: PortfolioLine;
  others: PortfolioLine[];
  othersTotalUsd: string | null;
  totalUsd: string;
  totalNgn: string | null;
  ngnRate: string | null;
  priceTimestamp: Date | null;
}

type MakePortfolioLine = (
  masterAddress: string,
  symbol: string,
  name: string,
  decimals: number,
  balanceBase: bigint,
  priceUsd: string | null,
  priceSource: string | null,
  priceUpdatedAt: Date | null
) => PortfolioLine;

/**
 * Portfolio engine.
 *
 * Rules enforced:
 *  - Decimal-safe totals (bigint + Decimal), never float.
 *  - An asset with NO price is reported valueUsd=null and remains visible.
 *  - ATF/TON valuation path UNCHANGED (existing PriceService methods).
 *  - Other Jettons are discovered from the user's actual wallet.
 *  - Duplicate master addresses are deduped by canonical Address.parse form.
 */
export class PortfolioService {
  private priceService = PriceService.getInstance();
  private assetDiscovery = WalletAssetDiscoveryService.getInstance();

  async buildPortfolio(
    walletAddress: string,
    onChainTon: bigint,
    onChainAtf: bigint
  ): Promise<PortfolioSummary> {
    const [tonPrice, atfPrice, ngnRate] = await Promise.all([
      this.priceService.getTonPriceUsd().catch(() => null),
      this.priceService.getAtfPriceUsd().catch(() => null),
      this.priceService.getUsdNgnRate().catch(() => null),
    ]);

    const ngnRateStr = ngnRate ? ngnRate.price.toString() : null;

    const mkLine = (
      masterAddress: string,
      symbol: string,
      name: string,
      decimals: number,
      balanceBase: bigint,
      priceUsd: string | null,
      priceSource: string | null,
      priceUpdatedAt: Date | null
    ): PortfolioLine => {
      let valueUsd: string | null = null;
      let valueNgn: string | null = null;
      let status: ValuationStatus = 'valued';

      if (priceUsd && Number(priceUsd) > 0) {
        valueUsd = this.cryptoToUsd(balanceBase, priceUsd, decimals);

        if (ngnRateStr) {
          valueNgn = new Decimal(valueUsd).times(ngnRateStr).toFixed(2);
        }
      } else {
        status = 'price_unavailable';
      }

      return {
        masterAddress,
        symbol,
        name,
        decimals,
        balanceBase: balanceBase.toString(),
        balanceDisplay: Precision.fromBaseUnits(balanceBase, decimals),
        priceUsd,
        priceSource,
        priceUpdatedAt,
        valueUsd,
        valueNgn,
        valuationStatus: status,
      };
    };

    const tonLine = mkLine(
      config.nativeGramAddress,
      'TON',
      'Toncoin',
      TON_DECIMALS,
      onChainTon,
      tonPrice ? String(tonPrice.price) : null,
      tonPrice?.source ?? null,
      tonPrice?.timestamp ?? null
    );

    const atfLine = mkLine(
      config.atfJettonAddress,
      'ATF',
      'ATF Token',
      ATF_DECIMALS,
      onChainAtf,
      atfPrice ? String(atfPrice.price) : null,
      atfPrice?.source ?? null,
      atfPrice?.timestamp ?? null
    );

    const others = await this.discoverOtherAssets(
      walletAddress,
      mkLine
    );

    /* ── Totals: only valued assets contribute ── */
    let totalUsdD = new Decimal(tonLine.valueUsd ?? '0').plus(atfLine.valueUsd ?? '0');
    let othersTotalD: Decimal | null = null;

    for (const line of others) {
      if (line.valueUsd) {
        totalUsdD = totalUsdD.plus(line.valueUsd);
        othersTotalD = othersTotalD
          ? othersTotalD.plus(line.valueUsd)
          : new Decimal(line.valueUsd);
      }
    }

    const totalUsd = totalUsdD.toFixed(2);
    const totalNgn = ngnRateStr
      ? totalUsdD.times(ngnRateStr).toFixed(2)
      : null;

    return {
      ton: tonLine,
      atf: atfLine,
      others,
      othersTotalUsd: othersTotalD ? othersTotalD.toFixed(2) : null,
      totalUsd,
      totalNgn,
      ngnRate: ngnRateStr,
      priceTimestamp: tonPrice?.timestamp ?? atfPrice?.timestamp ?? null,
    };
  }

  /**
   * Discovers every positive Jetton balance in the user's wallet.
   *
   * ATF is excluded here because it is valued by the unchanged ATF code path
   * above. Other master addresses are deduplicated canonically.
   *
   * Price lookup concurrency is intentionally bounded so a wallet holding
   * many unpriced tokens cannot produce an unbounded burst of provider calls.
   */
  private async discoverOtherAssets(
    walletAddress: string,
    mkLine: MakePortfolioLine
  ): Promise<PortfolioLine[]> {
    const holdings = await this.assetDiscovery
      .discover(walletAddress)
      .catch((error: any) => {
        console.warn(
          '[PortfolioService] Wallet Jetton discovery failed:',
          error?.message || error
        );

        return [] as DiscoveredJetton[];
      });

    const seen = new Set<string>([
      Address.parse(config.atfJettonAddress).toString(),
    ]);

    const uniqueHoldings: DiscoveredJetton[] = [];

    for (const holding of holdings) {
      try {
        const canonical = Address.parse(
          holding.masterAddress
        ).toString();

        if (
          holding.balanceBase <= 0n ||
          seen.has(canonical)
        ) {
          continue;
        }

        seen.add(canonical);
        uniqueHoldings.push({
          ...holding,
          masterAddress: canonical,
        });
      } catch {
        // Ignore malformed indexer rows.
      }
    }

    const lines = await this.mapWithConcurrency(
      uniqueHoldings,
      3,
      async (asset) => {
        let priceUsd = this.positiveUsdPrice(asset.priceUsd);
        let priceSource = priceUsd
          ? asset.priceSource ?? 'TON Indexer'
          : null;
        let priceUpdatedAt = priceUsd
          ? asset.priceUpdatedAt ?? new Date()
          : null;

        /*
         * If the indexer did not provide a usable USD price, query the
         * fallback price-provider chain. ATF is never passed here.
         */
        if (!priceUsd) {
          const priceData = await this.priceService
            .getJettonPriceUsd(asset.masterAddress)
            .catch(() => null);

          if (
            priceData &&
            Number.isFinite(priceData.price) &&
            priceData.price > 0
          ) {
            priceUsd = String(priceData.price);
            priceSource = priceData.source;
            priceUpdatedAt = priceData.timestamp;
          }
        }

        try {
          return mkLine(
            asset.masterAddress,
            asset.symbol,
            asset.name,
            asset.decimals,
            asset.balanceBase,
            priceUsd,
            priceSource,
            priceUpdatedAt
          );
        } catch (error: any) {
          console.warn(
            `[PortfolioService] Failed to render ${asset.symbol}:`,
            error?.message || error
          );

          return null;
        }
      }
    );

    return lines.filter(
      (line): line is PortfolioLine => line !== null
    );
  }

  private positiveUsdPrice(
    value: string | null | undefined
  ): string | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) && parsed > 0
      ? String(parsed)
      : null;
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;

    const workerCount = Math.max(
      1,
      Math.min(limit, items.length)
    );

    const workers = Array.from(
      { length: workerCount },
      async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;

          results[index] = await mapper(
            items[index],
            index
          );
        }
      }
    );

    await Promise.all(workers);
    return results;
  }

  private cryptoToUsd(
    balanceBase: bigint,
    priceUsd: string,
    decimals: number
  ): string {
    return new Decimal(Precision.fromBaseUnits(balanceBase, decimals))
      .times(priceUsd)
      .toFixed(2);
  }
      }
