/**
 * Info screens — transaction history, market prices, help, referral,
 * and the PHASE 1 full-portfolio screen.
 * Imports context only (no main-menu) → zero cycle risk.
 */
import {
  TelegramBot, User, Transaction, Referral, Precision, config, TON_DECIMALS, ATF_DECIMALS,
  priceService, portfolioService, walletService,
  render, toast,
  terminalHeader, movementLine, sourceBadge, explorerLink,
  formatAddressShort,
} from '../context';
import * as keyboards from '../keyboards';

/** Support desk — surfaced as a button, never as visible URL text. */
const SUPPORT_URL = 'https://orbit-talk-pro.lovable.app/atfswap';

/* ───────────────────────────────────────────────────────────────────────────
   📜 TRANSACTION HISTORY
   ─────────────────────────────────────────────────────────────────────────── */

export async function showHistory(userId: number, chatId: number, page: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.lastAction = 'history';
  await user.save();

  const limit = 5;
  const skip = (page - 1) * limit;

  const txs = await Transaction.find({ userId: user._id })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit + 1);

  const hasMore = txs.length > limit;
  const display = hasMore ? txs.slice(0, limit) : txs;

  const lines = display.map((tx: any) => {
    const icon = tx.type === 'deposit' ? '📥' : tx.type === 'withdrawal' ? '📤' : '🔄';
    const amt = Precision.fromBaseUnits(BigInt(tx.amount), tx.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
    const shortHash = tx.txHash && !tx.txHash.includes('-')
      ? `<a href="${explorerLink(tx.txHash)}">${tx.txHash.slice(0, 6)}…${tx.txHash.slice(-4)}</a>`
      : '···';
    const statusIcon = tx.status === 'completed' ? '✅' : tx.status === 'pending' ? '⏳' : '❌';
    return `${icon} <b>${tx.type.toUpperCase()}</b>  <code>${Precision.formatDisplay(amt)} ${tx.asset}</code>\n   ${statusIcon} ${tx.status} · ${shortHash}`;
  });

  const caption = [
    terminalHeader('ACTIVITY', `page ${page}`),
    '',
    ...(lines.length ? lines : ['<i>No transactions yet — deposit to get started 📥</i>']),
  ].filter(Boolean).join('\n');

  await render(userId, chatId, caption, keyboards.historyPaginationKeyboard(page, hasMore), { withImage: true });
}

/* ───────────────────────────────────────────────────────────────────────────
   ⚖️ MARKET PRICES
   ─────────────────────────────────────────────────────────────────────────── */

export async function showPrices(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.lastAction = 'prices';
    await user.save();
  }

  const [tonPrice, atfPrice, ngnRate] = await Promise.all([
    priceService.getTonPriceUsd().catch(() => null),
    priceService.getAtfPriceUsd().catch(() => null),
    priceService.getUsdNgnRate().catch(() => null),
  ]);

  const caption = [
    terminalHeader('MARKET', 'live prices · 24h movement · source'),
    '',
    tonPrice
      ? `💎 <b>TON</b>  <code>$${tonPrice.price.toFixed(2)}</code> · ${movementLine(tonPrice)}\n   ${sourceBadge(tonPrice)}`
      : `💎 <b>TON</b>  <i>⏳ unavailable</i>`,
    '',
    atfPrice
      ? `🔷 <b>ATF</b>  <code>$${atfPrice.price.toFixed(6)}</code> · ${movementLine(atfPrice)}\n   ${sourceBadge(atfPrice)}`
      : `🔷 <b>ATF</b>  <i>⏳ unavailable</i>`,
    '',
    ngnRate
      ? `🇳🇬 <b>USD/NGN</b>  <code>₦${ngnRate.price.toFixed(2)}</code>\n   ${sourceBadge(ngnRate)}`
      : `🇳🇬 <b>USD/NGN</b>  <i>⏳ unavailable</i>`,
  ].join('\n');

  await render(userId, chatId, caption, keyboards.pricesKeyboard(), { withImage: true });
}

/* ───────────────────────────────────────────────────────────────────────────
   ❓ HELP
   ─────────────────────────────────────────────────────────────────────────── */

export async function showHelp(userId: number, chatId: number): Promise<void> {
  // Clone the keyboard so the support row is appended per-render, never accumulated.
  const base = keyboards.helpKeyboard();
  const keyboard = { inline_keyboard: [...(base?.inline_keyboard ?? [])] };
  keyboard.inline_keyboard.push([{ text: '💬 Contact Support', url: SUPPORT_URL }]);

  await render(userId, chatId, [
    terminalHeader('SUPPORT', 'help · guides · assistance'),
    '',
    `A custodial TON ↔ ATF exchange inside Telegram.`,
    '',
    `▸ <b>QUICK START</b>`,
    `1️⃣ Deposit TON or ATF 📥`,
    `2️⃣ Swap instantly 🔄`,
    `3️⃣ Withdraw to any TON address 📤`,
    '',
    `▸ <b>COMMANDS</b>`,
    `<code>/start</code> — open menu`,
    `<code>/help</code> — this message`,
    '',
    `▸ <b>FEES</b>`,
    `├ swap  <code>${config.platformSwapFeePercent}%</code> platform fee`,
    `└ withdraw  network gas only`,
    '',
    `💬 Tap the button below to reach support.`,
  ].join('\n'), keyboard, { withImage: true });
}

/* ───────────────────────────────────────────────────────────────────────────
   🤝 REFERRAL PROGRAM
   ─────────────────────────────────────────────────────────────────────────── */

export async function showReferral(userId: number, chatId: number): Promise<void> {
  const count = await Referral.countDocuments({ referrerId: userId });
  const link = `https://t.me/${config.botUsername}?start=${userId}`;

  await render(userId, chatId, [
    terminalHeader('REWARDS', 'invite friends · earn together'),
    '',
    `👥 referred  <b>${count}</b> user${count !== 1 ? 's' : ''}`,
    '',
    `Your link:`,
    `<code>${link}</code>`,
    '',
    `<i>Share it — when they trade, you earn.</i>`,
  ].join('\n'), keyboards.backKeyboard('back_main'), { withImage: true });
}

/* ═══════════════════════════════════════════════════════════
   PHASE 1 — FULL PORTFOLIO SCREEN
   ═══════════════════════════════════════════════════════════ */

export async function showPortfolio(userId: number, chatId: number, page: number): Promise<void> {
  if (!config.features.portfolioScreen) {
    const user = await User.findOne({ telegramId: userId });
    await toast(userId, chatId, '⏳ <i>coming soon</i>', keyboards.mainMenuKeyboard(user?.isAdmin || user?.isSuperAdmin || false));
    return;
  }

  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const walletAddress = await walletService.getAddress(userId);
  if (!walletAddress) {
    await toast(userId, chatId, `${terminalHeader('PORTFOLIO')}\n<i>No wallet connected.</i>`, keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
    return;
  }

  let summary: any;
  try {
    const { ton, atf } = await walletService.getBalance(walletAddress);
    summary = await portfolioService.buildPortfolio(walletAddress, ton, atf);
  } catch {
    await toast(userId, chatId, `${terminalHeader('PORTFOLIO')}\n⚠️ <i>Could not load portfolio — try again.</i>`, keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
    return;
  }

  if (user.lastAction !== 'portfolio') {
    await User.updateOne({ _id: user._id }, { $set: { lastAction: 'portfolio' } }).catch(() => {});
  }

  const PAGE_SIZE = 5;
  const lines: string[] = [];

  for (const line of [summary.ton, summary.atf, ...summary.others]) {
    const statusTag =
      line.valuationStatus === 'price_unavailable'
        ? `\n   ⚠️ <i>price unavailable — excluded from total</i>`
        : '';
    const priceLine = line.priceUsd
      ? `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(Number(line.priceUsd))}`
      : '—';
    lines.push(
      `🪙 <b>${line.symbol}</b> · ${line.name}\n` +
      `   <code>${line.balanceDisplay}</code>\n` +
      `   ${priceLine} · ${line.valueUsd ? `$${line.valueUsd}` : 'unvalued'}` +
      (line.valueNgn ? ` · ≈ ₦${line.valueNgn}` : '') +
      statusTag
    );
  }

  const start = (page - 1) * PAGE_SIZE;
  const slice = lines.slice(start, start + PAGE_SIZE);
  const hasMore = start + PAGE_SIZE < lines.length;

  const text = [
    terminalHeader('FULL PORTFOLIO', `page ${page}`),
    `👛 <code>${formatAddressShort(walletAddress)}</code>`,
    '',
    `▸ <b>TOTAL VALUE</b>`,
    `💰 <code>$${summary.totalUsd}</code>${summary.totalNgn ? `  <i>≈ ₦${summary.totalNgn}</i>` : ''}`,
    summary.othersTotalUsd ? `├ other assets  <code>$${summary.othersTotalUsd}</code>` : '',
    '',
    ...slice,
    '',
    `<i>Assets with unavailable prices are excluded from the total.</i>`,
  ].filter(Boolean).join('\n');

  await toast(userId, chatId, text, keyboards.portfolioKeyboard(page, hasMore));
}
