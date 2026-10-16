
/**
 * Main dashboard menu + session restore.
 * Imports context only — never screens or handlers (no cycles).
 */

import {
  User,
  Precision,
  TON_DECIMALS,
  ATF_DECIMALS,
  priceService,
  walletService,
  render,
  clearState,
  fmtMoney,
  movementLine,
  terminalHeader,
  assetRow,
  withTimeout,
  WALLET_BALANCE_TIMEOUT_MS,
  getActiveWallet,
  formatAddressShort,
} from '../context';

import * as keyboards from '../keyboards';

/**
 * Display the main portfolio dashboard.
 */
export async function showMainMenu(
  userId: number,
  chatId: number,
): Promise<void> {
  const [user, wallet] = await Promise.all([
    User.findOne({ telegramId: userId }),
    getActiveWallet(userId),
  ]);

  if (!user) return;

  if (user.lastAction !== 'main_menu') {
    await User.updateOne(
      { _id: user._id },
      { $set: { lastAction: 'main_menu' } },
    ).catch(() => {});
  }

  const balancePromise = wallet?.address
    ? withTimeout(
        walletService.getBalance(wallet.address),
        WALLET_BALANCE_TIMEOUT_MS,
      )
    : Promise.resolve(null);

  const [
    onChain,
    [atfPrice, tonPrice, ngnRate],
  ] = await Promise.all([
    balancePromise.catch(() => null),
    Promise.all([
      priceService.getAtfPriceUsd().catch(() => null),
      priceService.getTonPriceUsd().catch(() => null),
      priceService.getUsdNgnRate().catch(() => null),
    ]),
  ]);

  const tonBalance = onChain
    ? Precision.fromBaseUnits(onChain.ton, TON_DECIMALS)
    : null;

  const atfBalance = onChain
    ? Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS)
    : null;

  const tonUsd =
    tonBalance !== null && tonPrice
      ? priceService.convertCryptoToUsd(
          tonBalance,
          tonPrice.price,
          TON_DECIMALS,
        )
      : null;

  const atfUsd =
    atfBalance !== null && atfPrice
      ? priceService.convertCryptoToUsd(
          atfBalance,
          atfPrice.price,
          ATF_DECIMALS,
        )
      : null;

  const totalUsd =
    tonUsd !== null || atfUsd !== null
      ? (
          parseFloat(tonUsd ?? '0') +
          parseFloat(atfUsd ?? '0')
        ).toFixed(2)
      : null;

  const totalNgn =
    totalUsd !== null && ngnRate
      ? priceService.convertUsdToNgn(
          totalUsd,
          ngnRate.price,
        )
      : null;

  const totalRow =
    totalUsd !== null
      ? `💵 <code>$${fmtMoney(totalUsd)}</code>${
          totalNgn
            ? `  ·  🇳🇬 <code>₦${fmtMoney(totalNgn, 0)}</code>`
            : ''
        }`
      : '<i>⏳ unavailable</i>';

  const caption = [
    terminalHeader(
      'PORTFOLIO',
      '💼 assets · 💵 live value · 📊 24h movement',
    ),
    '',
    '◉ <b>TOTAL PORTFOLIO</b>',
    totalRow,
    '',
    ...assetRow(
      '💎',
      'TON',
      tonBalance,
      tonUsd,
      tonPrice,
    ),
    '',
    ...assetRow(
      '🔷',
      'ATF',
      atfBalance,
      atfUsd,
      atfPrice,
    ),
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '◉ <b>MARKET</b>',

    tonPrice
      ? `💎 TON  <code>$${tonPrice.price.toFixed(2)}</code> · ${movementLine(tonPrice)}`
      : '💎 TON  <i>⏳ unavailable</i>',

    atfPrice
      ? `🔷 ATF  <code>$${atfPrice.price.toFixed(6)}</code> · ${movementLine(atfPrice)}`
      : '🔷 ATF  <i>⏳ unavailable</i>',

    ngnRate
      ? `🇳🇬 USD/NGN  <code>₦${ngnRate.price.toFixed(2)}</code>`
      : '🇳🇬 USD/NGN  <i>⏳ unavailable</i>',

    '',

    wallet
      ? `◉ 🗝 <b>WALLET</b>  <code>${formatAddressShort(wallet.address)}</code>${
          wallet.walletVersion
            ? ` · <code>${wallet.walletVersion.toUpperCase()}</code>`
            : ''
        }`
      : '⚠️ <b>No active wallet</b> — tap ▣ Wallet to create or import one',
  ].join('\n');

  await render(
    userId,
    chatId,
    caption,
    keyboards.mainMenuKeyboard(
      user.isAdmin || user.isSuperAdmin,
    ),
    { withImage: true },
  );
}

/**
 * Restore the user's last screen after returning to the bot.
 */
export async function restoreLastAction(
  userId: number,
  chatId: number,
): Promise<void> {
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
      '🔙 <b>Welcome back</b>\n\nYour previous session was reset — you can continue below.',
      keyboards.mainMenuKeyboard(
        user.isAdmin || user.isSuperAdmin,
      ),
    );

    return;
  }

  switch (user.lastAction) {
    case 'swap': {
      const screen = await import('./swap-screens');
      await screen.showSwapPair(userId, chatId);
      break;
    }

    case 'deposit': {
      const screen = await import('./transfer-screens');
      await screen.showDepositMenu(userId, chatId);
      break;
    }

    case 'withdraw': {
      const screen = await import('./transfer-screens');
      await screen.showWithdrawMenu(userId, chatId);
      break;
    }

    case 'account': {
      const screen = await import('./wallet-screens');
      await screen.showAccount(userId, chatId);
      break;
    }

    case 'history': {
      const screen = await import('./info-screens');
      await screen.showHistory(userId, chatId, 1);
      break;
    }

    case 'prices': {
      const screen = await import('./info-screens');
      await screen.showPrices(userId, chatId);
      break;
    }

    case 'admin_panel': {
      const screen = await import('./admin-screens');
      await screen.showAdminPanel(userId, chatId);
      break;
    }

    case 'portfolio': {
      const screen = await import('./info-screens');
      await screen.showPortfolio(userId, chatId, 1);
      break;
    }

    case 'transfer_relay': {
      const screen = await import('./relay-screens');
      await screen.showRelayHome(userId, chatId, user);
      break;
    }

    default: {
      await showMainMenu(userId, chatId);
      break;
    }
  }
}
