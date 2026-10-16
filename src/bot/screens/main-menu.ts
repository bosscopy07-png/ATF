/**
 * Main dashboard menu + session restore.
 * Imports context only — never screens or handlers (no cycles).
 */
import {
  TelegramBot, User, Precision, config, TON_DECIMALS, ATF_DECIMALS,
  priceService, walletService,
  render, clearState,
  fmtMoney, movementLine, terminalHeader, withTimeout,
  WALLET_BALANCE_TIMEOUT_MS, getActiveWallet, formatAddressShort,
} from '../context';
import * as keyboards from '../keyboards';

export async function showMainMenu(userId: number, chatId: number): Promise<void> {
  const [user, wallet] = await Promise.all([
    User.findOne({ telegramId: userId }),
    getActiveWallet(userId),
  ]);
  if (!user) return;

  if (user.lastAction !== 'main_menu') {
    await User.updateOne({ _id: user._id }, { $set: { lastAction: 'main_menu' } }).catch(() => {});
  }

  const balancePromise = wallet?.address
    ? withTimeout(walletService.getBalance(wallet.address), WALLET_BALANCE_TIMEOUT_MS)
    : Promise.resolve(null);

  const [onChain, [atfPrice, tonPrice, ngnRate]] = await Promise.all([
    balancePromise.catch(() => null),
    Promise.all([
      priceService.getAtfPriceUsd().catch(() => null),
      priceService.getTonPriceUsd().catch(() => null),
      priceService.getUsdNgnRate().catch(() => null),
    ]),
  ]);

  const tonBalance = onChain ? Precision.fromBaseUnits(onChain.ton, TON_DECIMALS) : null;
  const atfBalance = onChain ? Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS) : null;

  const tonUsd = tonBalance !== null && tonPrice ? priceService.convertCryptoToUsd(tonBalance, tonPrice.price, TON_DECIMALS) : null;
  const atfUsd = atfBalance !== null && atfPrice ? priceService.convertCryptoToUsd(atfBalance, atfPrice.price, ATF_DECIMALS) : null;

  const totalUsd = tonUsd !== null || atfUsd !== null
    ? (parseFloat(tonUsd ?? '0') + parseFloat(atfUsd ?? '0')).toFixed(2)
    : null;
  const totalNgn = totalUsd !== null && ngnRate ? priceService.convertUsdToNgn(totalUsd, ngnRate.price) : null;

  const assetBlock = (emoji: string, symbol: string, balance: string | null, usd: string | null, price: any): string[] => {
    if (balance === null) return [`${emoji} <b>${symbol}</b> <i>⏳ unavailable</i>`];
    return [
      `${emoji} <b>${symbol}</b> <code>${Precision.formatDisplay(balance)}</code>`,
      `   ├ 💵 <code>$${fmtMoney(usd ?? '0')}</code>`,
      `   └ 📊 ${movementLine(price)}`,
    ];
  };

  const caption = [
    terminalHeader('PORTFOLIO', '💼 your assets · 💵 live value · 📊 24h movement'),
    '',
    `💼 <b>Total Portfolio</b>`,
    totalUsd !== null
      ? `💵 <code>$${fmtMoney(totalUsd)}</code>${totalNgn ? `  🇳🇬 <code>₦${fmtMoney(totalNgn, 0)}</code>` : ''}`
      : `<i>⏳ unavailable</i>`,
    '',
    ...assetBlock('💎', 'TON', tonBalance, tonUsd, tonPrice),
    '',
    ...assetBlock('🔷', 'ATF', atfBalance, atfUsd, atfPrice),
    '',
    `━━━━━━━━━━━━━━━━━━━━`,
    `◉ <b>MARKET</b>`,
    tonPrice ? `💎 TON <code>$${tonPrice.price.toFixed(2)}</code> · ${movementLine(tonPrice)}` : `💎 TON <i>⏳ unavailable</i>`,
    atfPrice ? `🔷 ATF <code>$${atfPrice.price.toFixed(6)}</code> · ${movementLine(atfPrice)}` : `🔷 ATF <i>⏳ unavailable</i>`,
    ngnRate ? `🇳🇬 USD/NGN <code>₦${ngnRate.price.toFixed(2)}</code>` : '',
    '',
    wallet
      ? `◉ 🗝 Wallet <code>${formatAddressShort(wallet.address)}</code>${wallet.walletVersion ? ` · <code>${wallet.walletVersion.toUpperCase()}</code>` : ''}`
      : `⚠️ No active wallet — tap ▣ Wallet to create or import one`,
  ].filter(Boolean).join('\n');

  await render(userId, chatId, caption, keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin), { withImage: true });
}

export async function restoreLastAction(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) {
    await showMainMenu(userId, chatId);
    return;
  }

  if (user.state !== 'idle') {
    await clearState(userId);
    await render(
      userId,
      chatId,
      '🔙 <b>Welcome back!</b>\n\nYour previous session was reset.',
      keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin)
    );
    return;
  }

  switch (user.lastAction) {
    case 'swap': { const m = await import('./swap-screens'); await m.showSwapPair(userId, chatId); break; }
    case 'deposit': { const m = await import('./transfer-screens'); await m.showDepositMenu(userId, chatId); break; }
    case 'withdraw': { const m = await import('./transfer-screens'); await m.showWithdrawMenu(userId, chatId); break; }
    case 'account': { const m = await import('./wallet-screens'); await m.showAccount(userId, chatId); break; }
    case 'history': { const m = await import('./info-screens'); await m.showHistory(userId, chatId, 1); break; }
    case 'prices': { const m = await import('./info-screens'); await m.showPrices(userId, chatId); break; }
    case 'admin_panel': { const m = await import('./admin-screens'); await m.showAdminPanel(userId, chatId); break; }
    case 'portfolio': { const m = await import('./info-screens'); await m.showPortfolio(userId, chatId, 1); break; }
    case 'transfer_relay': { const m = await import('./relay-screens'); await m.showRelayHome(userId, chatId, user); break; }
    default: await showMainMenu(userId, chatId);
  }
}
