import { TonClient, Address, JettonMaster, JettonWallet } from '@ton/ton';
import { config, TON_DECIMALS, ATF_DECIMALS } from '../config';
import { TokenRegistry } from './token-registry';
import { PriceService } from './price-service';
import { Precision } from '../utils/precision';
import { SupportedToken } from '../models/SupportedToken';

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
  /** One aggregated "Other Assets" value for the main dashboard. */
  othersTotalUsd: string | null;
  totalUsd: string;
  totalNgn: string | null;
  ngnRate: string | null;
  priceTimestamp: Date | null;
}

/**
 * Portfolio engine.
 *
 * Rules enforced:
 *  - Decimal-safe totals (bigint + Decimal), never float.
 *  - An asset with NO price is reported with valueUsd=null and
 *    valuationStatus='price_unavailable' — it NEVER contributes
 *    to totals (not counted as zero, excluded and clearly identified).
 *  - ATF/TON valuation path is UNCHANGED (existing PriceService).
 *  - Duplicate master addresses deduped by canonical Address.parse form.
 */
export class PortfolioService {
  private tonClient: TonClient;
  private priceService = PriceService.getInstance();

  constructor() {
    this.tonClient = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });
  }

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
        valueUsd = new Precision.constructor === undefined
          ? this.cryptoToUsd(balanceBase, priceUsd, decimals)
          : this.cryptoToUsd(balanceBase, priceUsd, decimals);

        if (ngnRateStr) {
          valueNgn = new (require('decimal.js').default || require('decimal.js'))(valueUsd)
            .times(ngnRateStr)
            .toFixed(2);
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

    /* ── Other assets: discover holdings, dedupe, price-check ── */
    const registryTokens = await TokenRegistry.listTradeable().catch(() => []);
    const seen = new Set<string>([
      Address.parse(config.atfJettonAddress).toString(),
    ]);

    const others: PortfolioLine[] = [];

    for (const token of registryTokens) {
      let canonical: string;
      try {
        canonical = Address.parse(token.masterAddress).toString();
      } catch {
        continue; // invalid record excluded
      }
      if (seen.has(canonical)) continue; // dedupe
      seen.add(canonical);

      const balanceBase = await this.readJettonBalance(
        walletAddress,
        canonical
      ).catch(() => null);

      if (balanceBase === null || balanceBase <= 0n) continue; // not held

      const doc = await SupportedToken.findOne({ masterAddress: canonical });

      others.push(
        mkLine(
          canonical,
          token.symbol,
          token.name,
          token.decimals,
          balanceBase,
          doc?.lastPriceUsd ?? null,
          doc?.priceSource ?? null,
          doc?.priceUpdatedAt ?? null
        )
      );
    }

    /* ── Totals: only valued assets contribute ── */
    const D = require('decimal.js');
    let totalUsdD = new D(tonLine.valueUsd ?? '0').plus(atfLine.valueUsd ?? '0');
    let othersTotalD: InstanceType<typeof D> | null = null;

    for (const line of others) {
      if (line.valueUsd) {
        totalUsdD = totalUsdD.plus(line.valueUsd);
        othersTotalD = othersTotalD ? othersTotalD.plus(line.valueUsd) : new D(line.valueUsd);
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

  private cryptoToUsd(
    balanceBase: bigint,
    priceUsd: string,
    decimals: number
  ): string {
    const D = require('decimal.js');
    return new D(Precision.fromBaseUnits(balanceBase, decimals))
      .times(priceUsd)
      .toFixed(2);
  }

  private async readJettonBalance(
    ownerAddress: string,
    masterAddress: string
  ): Promise<bigint> {
    const master = this.tonClient.open(
      JettonMaster.create(Address.parse(masterAddress))
    );
    const jettonWalletAddress = await master.getWalletAddress(
      Address.parse(ownerAddress)
    );
    const jettonWallet = this.tonClient.open(
      JettonWallet.create(jettonWalletAddress)
    );
    return await jettonWallet.getBalance();
  }
}
