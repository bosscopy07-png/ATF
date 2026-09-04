import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';

export function mainMenuKeyboard(isAdmin: boolean): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[][] = [
    [{ text: '🔄 Swap', callback_data: 'swap' }],
    [
      { text: '💰 Deposit', callback_data: 'deposit' },
      { text: '💸 Withdraw', callback_data: 'withdraw' },
    ],
    [
      { text: '👤 Account', callback_data: 'account' },
      { text: '📊 History', callback_data: 'history' },
    ],
    [
      { text: '💵 Prices', callback_data: 'prices' },
      { text: 'ℹ️ Help', callback_data: 'help' },
    ],
    [{ text: '🎁 Referral', callback_data: 'referral' }],
    [{ text: '🔄 Refresh', callback_data: 'refresh_main' }],
  ];

  if (isAdmin) {
    buttons.push([{ text: '🔧 Admin Panel', callback_data: 'admin_panel' }]);
  }

  return { inline_keyboard: buttons };
}

export function swapPairKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '💎 TON → 🪙 ATF', callback_data: 'swap_ton_atf' }],
      [{ text: '🪙 ATF → 💎 TON', callback_data: 'swap_atf_ton' }],
      [{ text: '⬅️ Back', callback_data: 'back_main' }],
    ],
  };
}

export function confirmSwapKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '✅ CONFIRM SWAP', callback_data: 'confirm_swap' }],
      [{ text: '❌ CANCEL', callback_data: 'cancel_swap' }],
    ],
  };
}

export function depositKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '💎 Deposit TON', callback_data: 'deposit_ton' }],
      [{ text: '🪙 Deposit ATF', callback_data: 'deposit_atf' }],
      [{ text: '⬅️ Back', callback_data: 'back_main' }],
    ],
  };
}

export function depositTonScreen(address: string): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '📋 Copy Address', callback_data: 'copy_addr_ton' }],
      [{ text: '🔄 Check Deposit', callback_data: 'check_deposit_ton' }],
      [{ text: '⬅️ Back', callback_data: 'deposit' }],
    ],
  };
}

export function depositAtfScreen(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔄 Check Deposit', callback_data: 'check_deposit_atf' }],
      [{ text: '⬅️ Back', callback_data: 'deposit' }],
    ],
  };
}

export function withdrawAssetKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '💎 TON', callback_data: 'withdraw_ton' }],
      [{ text: '🪙 ATF', callback_data: 'withdraw_atf' }],
      [{ text: '⬅️ Back', callback_data: 'back_main' }],
    ],
  };
}

export function confirmWithdrawalKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '✅ CONFIRM', callback_data: 'confirm_withdrawal' }],
      [{ text: '❌ CANCEL', callback_data: 'cancel_withdrawal' }],
    ],
  };
}

export function backKeyboard(callback: string): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: '⬅️ Back', callback_data: callback }]],
  };
}

export function cancelKeyboard(callback: string): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: '❌ Cancel', callback_data: callback }]],
  };
}

export function pricesKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔄 Refresh', callback_data: 'prices' }],
      [{ text: '⬅️ Back', callback_data: 'back_main' }],
    ],
  };
}

export function helpKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '📢 Support Channel', url: config.supportChannelUrl }],
      [{ text: '⬅️ Back', callback_data: 'back_main' }],
    ],
  };
}

export function accountKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔐 Export Wallet', callback_data: 'export_wallet' }],
      [{ text: '🔑 Import Wallet', callback_data: 'import_wallet' }],
      [{ text: '💼 My Wallets', callback_data: 'my_wallets' }],
      [{ text: '⬅️ Back', callback_data: 'back_main' }],
    ],
  };
}

export function exportWarningKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔐 Reveal Phrase', callback_data: 'export_confirm' }],
      [{ text: '❌ Cancel', callback_data: 'account' }],
    ],
  };
}

/**
 * Choose how the imported mnemonic should be derived.
 *
 * Auto Detect:
 * - Checks V4R2 and W5R1
 * - If only one has activity, selects it
 * - If both have activity, asks the user to choose explicitly
 * - If neither has activity, defaults to W5R1
 */
export function importWalletVersionKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔍 Auto Detect', callback_data: 'import_version_auto' }],
      [{ text: '🟦 TON V4R2', callback_data: 'import_version_v4' }],
      [{ text: '🟪 TON W5R1', callback_data: 'import_version_v5' }],
      [{ text: '❌ Cancel', callback_data: 'account' }],
    ],
  };
}

export function walletListKeyboard(
  wallets: any[],
  activeId: string
): TelegramBot.InlineKeyboardMarkup {
  const rows = wallets.map((w, idx) => {
    const version =
      w.walletVersion === 'v5r1'
        ? 'W5'
        : w.walletVersion === 'v4r2'
          ? 'V4'
          : '?';

    return [
      {
        text:
          `${w._id.toString() === activeId ? '✅' : '🔘'} ` +
          `Wallet ${idx + 1} ` +
          `${w.isImported ? '(Imported)' : '(Created)'} ` +
          `[${version}]`,
        callback_data: `switch_wallet_${w._id.toString()}`,
      },
    ];
  }) as TelegramBot.InlineKeyboardButton[][];

  rows.push([
    {
      text: '➕ Create New Wallet',
      callback_data: 'create_wallet',
    },
  ]);

  rows.push([
    {
      text: '⬅️ Back',
      callback_data: 'account',
    },
  ]);

  return { inline_keyboard: rows };
}

export function historyPaginationKeyboard(
  page: number,
  hasMore: boolean
): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[] = [];

  if (page > 1) {
    buttons.push({
      text: '◀️ Prev',
      callback_data: `history_page_${page - 1}`,
    });
  }

  if (hasMore) {
    buttons.push({
      text: '▶️ Next',
      callback_data: `history_page_${page + 1}`,
    });
  }

  return {
    inline_keyboard: [
      buttons,
      [{ text: '🔄 Refresh', callback_data: 'history' }],
      [{ text: '⬅️ Back', callback_data: 'back_main' }],
    ],
  };
}

export function adminPanelKeyboard(
  isSuperAdmin: boolean
): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[][] = [
    [{ text: '👥 Users', callback_data: 'admin_users' }],
    [{ text: '📊 Transactions', callback_data: 'admin_transactions' }],
    [{ text: '💰 Deposits', callback_data: 'admin_deposits' }],
    [{ text: '💸 Withdrawals', callback_data: 'admin_withdrawals' }],
    [{ text: '🔄 Swaps', callback_data: 'admin_swaps' }],
    [{ text: '📈 Stats', callback_data: 'admin_stats' }],
    [{ text: '🪙 Token Config', callback_data: 'admin_token' }],
    [{ text: '⚙️ DEX Config', callback_data: 'admin_dex' }],
    [{ text: '💵 Fee Config', callback_data: 'admin_fees' }],
    [{ text: '💹 Price Providers', callback_data: 'admin_prices' }],
    [{ text: '📋 Audit Logs', callback_data: 'admin_audit' }],
    [{ text: '🚨 Sweep Wallet', callback_data: 'admin_sweep' }],
    [{ text: '🔧 System Settings', callback_data: 'admin_settings' }],
  ];

  if (isSuperAdmin) {
    buttons.push([{ text: '👑 Admin Management', callback_data: 'admin_management' }]);
    buttons.push([{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }]);
  }

  buttons.push([{ text: '⬅️ Back', callback_data: 'back_main' }]);

  return { inline_keyboard: buttons };
}

export function adminManagementKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '➕ Give Admin', callback_data: 'admin_give' }],
      [{ text: '➖ Remove Admin', callback_data: 'admin_remove' }],
      [{ text: '👥 Admin List', callback_data: 'admin_list' }],
      [{ text: '⬅️ Back', callback_data: 'admin_panel' }],
    ],
  };
}

export function adminPaginationKeyboard(
  prefix: string,
  page: number,
  hasMore: boolean
): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[] = [];

  if (page > 1) {
    buttons.push({
      text: '◀️ Prev',
      callback_data: `${prefix}_page_${page - 1}`,
    });
  }

  if (hasMore) {
    buttons.push({
      text: '▶️ Next',
      callback_data: `${prefix}_page_${page + 1}`,
    });
  }

  return {
    inline_keyboard: [
      buttons,
      [{ text: '⬅️ Back', callback_data: 'admin_panel' }],
    ],
  };
}

export function userListKeyboard(
  users: any[],
  page: number,
  hasMore: boolean
): TelegramBot.InlineKeyboardMarkup {
  const rows = users.map(u => [
    {
      text: `${u.isFrozen ? '🔒' : '🟢'} ${u.firstName || 'User'} (${u.telegramId})`,
      callback_data: `admin_user_${u.telegramId}`,
    },
  ]) as TelegramBot.InlineKeyboardButton[][];

  const nav: TelegramBot.InlineKeyboardButton[] = [];

  if (page > 1) {
    nav.push({
      text: '◀️',
      callback_data: `admin_users_page_${page - 1}`,
    });
  }

  nav.push({
    text: '⬅️ Back',
    callback_data: 'admin_panel',
  });

  if (hasMore) {
    nav.push({
      text: '▶️',
      callback_data: `admin_users_page_${page + 1}`,
    });
  }

  rows.push(nav);

  return { inline_keyboard: rows };
}

export function userActionKeyboard(
  telegramId: number,
  isFrozen: boolean
): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: isFrozen ? '🔓 Unfreeze' : '🔒 Freeze',
          callback_data: `admin_freeze_${telegramId}_${isFrozen ? 'unfreeze' : 'freeze'}`,
        },
      ],
      [{ text: '💰 View Balance', callback_data: `admin_balance_${telegramId}` }],
      [{ text: '📊 View Transactions', callback_data: `admin_tx_${telegramId}` }],
      [{ text: '⬅️ Back', callback_data: 'admin_users' }],
    ],
  };
       }
