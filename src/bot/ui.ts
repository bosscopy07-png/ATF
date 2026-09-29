import {
  TON_DECIMALS,
  ATF_DECIMALS,
} from '../config';

import { Precision } from '../utils/precision';
import { PriceService, PriceData } from '../services/price-service';

const priceService =
  PriceService.getInstance();

/**
 * Change this ONE value if you later decide on another brand name.
 */
export const UI_BRAND = 'ATF NEXUS';

export const UI_TAGLINE =
  'Digital Asset Terminal';

export interface PortfolioViewData {
  tonBalance: string;
  atfBalance: string;

  tonPrice: PriceData | null;
  atfPrice: PriceData | null;
  ngnRate: PriceData | null;

  tonUsd: string | null;
  atfUsd: string | null;

  totalUsd: string;
  totalNgn: string | null;
}

export function movementText(
  change?: number | null
): string {
  if (
    change === undefined ||
    change === null ||
    !Number.isFinite(change)
  ) {
    return '—';
  }

  const sign =
    change > 0
      ? '+'
      : '';

  return `${sign}${change.toFixed(2)}%`;
}

export function movementIcon(
  change?: number | null
): string {
  if (
    change === undefined ||
    change === null ||
    !Number.isFinite(change)
  ) {
    return '•';
  }

  if (change > 0) {
    return '▲';
  }

  if (change < 0) {
    return '▼';
  }

  return '•';
}

export function movementLine(
  change?: number | null
): string {
  if (
    change === undefined ||
    change === null ||
    !Number.isFinite(change)
  ) {
    return `<i>Movement unavailable</i>`;
  }

  return `<b>${movementIcon(
    change
  )} ${movementText(change)}</b>`;
}

export function formatUsd(
  value: string | null
): string {
  if (!value) {
    return '—';
  }

  return `$${value}`;
}

export function formatNgn(
  value: string | null
): string {
  if (!value) {
    return '—';
  }

  return `₦${value}`;
}

export function formatPrice(
  value: number,
  decimals = 6
): string {
  if (
    !Number.isFinite(value)
  ) {
    return '—';
  }

  if (value >= 1000) {
    return value.toLocaleString(
      'en-US',
      {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }
    );
  }

  return value.toFixed(
    decimals
  );
}

export async function getPortfolioData(
  tonBalance: string,
  atfBalance: string
): Promise<PortfolioViewData> {
  const [
    atfPrice,
    tonPrice,
    ngnRate,
  ] = await Promise.all([
    priceService
      .getAtfPriceUsd()
      .catch(() => null),

    priceService
      .getTonPriceUsd()
      .catch(() => null),

    priceService
      .getUsdNgnRate()
      .catch(() => null),
  ]);

  const tonUsd =
    tonPrice
      ? priceService.convertCryptoToUsd(
          tonBalance,
          tonPrice.price,
          TON_DECIMALS
        )
      : null;

  const atfUsd =
    atfPrice
      ? priceService.convertCryptoToUsd(
          atfBalance,
          atfPrice.price,
          ATF_DECIMALS
        )
      : null;

  const totalUsd =
    (
      parseFloat(
        tonUsd || '0'
      ) +
      parseFloat(
        atfUsd || '0'
      )
    ).toFixed(2);

  const totalNgn =
    ngnRate
      ? priceService.convertUsdToNgn(
          totalUsd,
          ngnRate.price
        )
      : null;

  return {
    tonBalance,
    atfBalance,

    tonPrice,
    atfPrice,
    ngnRate,

    tonUsd,
    atfUsd,

    totalUsd,
    totalNgn,
  };
}

/* ─────────────────────────────────────────────
   MAIN DASHBOARD
   ───────────────────────────────────────────── */

export function buildMainDashboard(
  data: PortfolioViewData,
  walletAddress?: string,
  walletType?: string
): string {
  const {
    tonBalance,
    atfBalance,
    tonPrice,
    atfPrice,
    ngnRate,
    tonUsd,
    atfUsd,
    totalUsd,
    totalNgn,
  } = data;

  const tonNgn =
    ngnRate && tonUsd
      ? priceService.convertUsdToNgn(
          tonUsd,
          ngnRate.price
        )
      : null;

  const atfNgn =
    ngnRate && atfUsd
      ? priceService.convertUsdToNgn(
          atfUsd,
          ngnRate.price
        )
      : null;

  const wallet =
    walletAddress
      ? `<code>${shortAddress(
          walletAddress
        )}</code>`
      : 'Not connected';

  return [
    `✦ <b>${UI_BRAND}</b>`,
    `<i>${UI_TAGLINE}</i>`,
    ``,

    `╭━━━ <b>PORTFOLIO</b> ━━━╮`,
    `│`,
    `│  <b>$${totalUsd}</b>`,
    totalNgn
      ? `│  <i>≈ ₦${totalNgn}</i>`
      : `│  <i>NGN value unavailable</i>`,
    `│`,
    `╰━━━━━━━━━━━━━━━━━━━━╯`,
    ``,

    `💎 <b>TON</b>`,
    `   <code>${Precision.formatDisplay(
      tonBalance
    )}</code> TON`,
    `   ${formatUsd(
      tonUsd
    )}${tonNgn ? `  ·  ≈ ₦${tonNgn}` : ''}`,
    tonPrice
      ? `   ${movementLine(
          tonPrice.change24hPercent
        )} <i>24h</i>`
      : `   <i>Price unavailable</i>`,
    ``,

    `🔷 <b>ATF</b>`,
    `   <code>${Precision.formatDisplay(
      atfBalance
    )}</code> ATF`,
    `   ${formatUsd(
      atfUsd
    )}${atfNgn ? `  ·  ≈ ₦${atfNgn}` : ''}`,
    atfPrice
      ? `   ${movementLine(
          atfPrice.change24hPercent
        )} <i>24h</i>`
      : `   <i>Price unavailable</i>`,
    ``,

    `━━━━━━━━━━━━━━━━━━━━`,
    `📈 <b>MARKET</b>`,

    tonPrice
      ? `TON  <code>$${formatPrice(
          tonPrice.price,
          2
        )}</code>  ${movementText(
          tonPrice.change24hPercent
        )}`
      : `TON  <i>offline</i>`,

    atfPrice
      ? `ATF  <code>$${formatPrice(
          atfPrice.price,
          6
        )}</code>  ${movementText(
          atfPrice.change24hPercent
        )}`
      : `ATF  <i>offline</i>`,

    ``,
    `👛 ${wallet}`,
    walletType
      ? `   <i>${walletType}</i>`
      : '',
    ``,

    `<i>Prices update automatically when available.</i>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/* ─────────────────────────────────────────────
   ACCOUNT
   ───────────────────────────────────────────── */

export function buildAccountScreen(
  data: PortfolioViewData,
  walletAddress?: string,
  walletVersion?: string,
  isImported?: boolean
): string {
  return [
    `✦ <b>${UI_BRAND}</b>`,
    `<b>WALLET OVERVIEW</b>`,
    ``,

    `💼 <b>Portfolio</b>`,
    `<code>$${data.totalUsd}</code>`,
    data.totalNgn
      ? `<i>≈ ₦${data.totalNgn}</i>`
      : '',
    ``,

    `💎 <b>TON</b>`,
    `<code>${Precision.formatDisplay(
      data.tonBalance
    )}</code> TON`,
    data.tonUsd
      ? `≈ $${data.tonUsd}`
      : '',
    data.tonPrice
      ? `${movementLine(
          data.tonPrice.change24hPercent
        )} <i>24h</i>`
      : '',
    ``,

    `🔷 <b>ATF</b>`,
    `<code>${Precision.formatDisplay(
      data.atfBalance
    )}</code> ATF`,
    data.atfUsd
      ? `≈ $${data.atfUsd}`
      : '',
    data.atfPrice
      ? `${movementLine(
          data.atfPrice.change24hPercent
        )} <i>24h</i>`
      : '',
    ``,

    `━━━━━━━━━━━━━━━━━━━━`,
    `👛 <b>ACTIVE WALLET</b>`,
    walletAddress
      ? `<code>${walletAddress}</code>`
      : `<i>No wallet connected</i>`,
    ``,

    walletVersion
      ? `⚙️ Network wallet: <b>${walletVersion.toUpperCase()}</b>`
      : '',

    isImported
      ? `🔐 Imported wallet`
      : `🆕 Platform-created wallet`,
  ]
    .filter(Boolean)
    .join('\n');
}

/* ─────────────────────────────────────────────
   SWAP SELECTOR
   ───────────────────────────────────────────── */

export function buildSwapScreen(
  tonBalance: string,
  atfBalance: string,
  tonPrice?: PriceData | null,
  atfPrice?: PriceData | null
): string {
  return [
    `✦ <b>${UI_BRAND}</b>`,
    `<b>SWAP TERMINAL</b>`,
    ``,

    `Trade directly from your connected TON wallet.`,
    ``,

    `💎 TON`,
    `<code>${Precision.formatDisplay(
      tonBalance
    )}</code>`,
    tonPrice
      ? `$${formatPrice(
          tonPrice.price,
          2
        )}  ${movementText(
          tonPrice.change24hPercent
        )}`
      : '',
    ``,

    `🔷 ATF`,
    `<code>${Precision.formatDisplay(
      atfBalance
    )}</code>`,
    atfPrice
      ? `$${formatPrice(
          atfPrice.price,
          6
        )}  ${movementText(
          atfPrice.change24hPercent
        )}`
      : '',
    ``,

    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>Select the direction below.</i>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/* ─────────────────────────────────────────────
   WITHDRAW
   ───────────────────────────────────────────── */

export function buildWithdrawScreen(
  tonBalance: string,
  atfBalance: string
): string {
  return [
    `✦ <b>${UI_BRAND}</b>`,
    `<b>WITHDRAWAL CENTER</b>`,
    ``,

    `Choose the asset you want to send.`,
    ``,

    `💎 TON`,
    `<code>${Precision.formatDisplay(
      tonBalance
    )}</code> available`,
    ``,

    `🔷 ATF`,
    `<code>${Precision.formatDisplay(
      atfBalance
    )}</code> available`,
    ``,

    `━━━━━━━━━━━━━━━━━━━━`,
    `🛡️ <i>Every withdrawal is checked against your live on-chain balance.</i>`,
  ].join('\n');
}

/* ─────────────────────────────────────────────
   DEPOSIT
   ───────────────────────────────────────────── */

export function buildDepositScreen(
  walletAddress: string
): string {
  return [
    `✦ <b>${UI_BRAND}</b>`,
    `<b>FUND YOUR WALLET</b>`,
    ``,

    `Send TON or ATF to your active wallet.`,
    ``,

    `👛 <b>YOUR ADDRESS</b>`,
    `<code>${walletAddress}</code>`,
    ``,

    `💎 TON`,
    `Send TON directly to this address.`,
    ``,

    `🔷 ATF`,
    `Send ATF to this wallet using the supported token.`,
    ``,

    `━━━━━━━━━━━━━━━━━━━━`,
    `⚠️ <i>Only send supported assets to this address.</i>`,
  ].join('\n');
}

/* ─────────────────────────────────────────────
   MARKET
   ───────────────────────────────────────────── */

export function buildMarketScreen(
  tonPrice: PriceData | null,
  atfPrice: PriceData | null,
  ngnRate: PriceData | null
): string {
  return [
    `✦ <b>${UI_BRAND}</b>`,
    `<b>LIVE MARKET</b>`,
    ``,

    tonPrice
      ? [
          `💎 <b>TON</b>`,
          `$${formatPrice(
            tonPrice.price,
            2
          )}`,
          `${movementLine(
            tonPrice.change24hPercent
          )} <i>24h</i>`,
          tonPrice.source.includes(
            'stale'
          )
            ? `⚠️ <i>cached price</i>`
            : `🟢 <i>live provider</i>`,
        ].join('\n')
      : `💎 <b>TON</b>\n❌ Price unavailable`,

    ``,

    atfPrice
      ? [
          `🔷 <b>ATF</b>`,
          `$${formatPrice(
            atfPrice.price,
            6
          )}`,
          `${movementLine(
            atfPrice.change24hPercent
          )} <i>24h</i>`,
          atfPrice.source.includes(
            'stale'
          )
            ? `⚠️ <i>cached price</i>`
            : `🟢 <i>live provider</i>`,
        ].join('\n')
      : `🔷 <b>ATF</b>\n❌ Price unavailable`,

    ``,

    ngnRate
      ? `💱 <b>USD/NGN</b>\n₦${formatPrice(
          ngnRate.price,
          2
        )}`
      : `💱 <b>USD/NGN</b>\n❌ Rate unavailable`,

    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>Market data uses multiple providers with cached fallback protection.</i>`,
  ].join('\n');
}

/* ─────────────────────────────────────────────
   ADDRESS
   ───────────────────────────────────────────── */

function shortAddress(
  address: string
): string {
  if (
    !address ||
    address.length < 14
  ) {
    return address;
  }

  return `${address.slice(
    0,
    7
  )}…${address.slice(-7)}`;
    }
