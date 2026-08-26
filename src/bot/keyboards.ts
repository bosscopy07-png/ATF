import TelegramBot from 'node-telegram-bot-api';

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
    [{ text: '🔄 Refresh', callback_data: 'refresh_main' }],
  ];

  if (isAdmin) {
    buttons.push([{ text: '⚙️ Admin Panel', callback_data: 'admin_panel' }]);
  }

  return { inline_keyboard: buttons };
}

export function swapPairKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '💎 TON → 🪙 AFT', callback_data: 'swap_ton_aft' }],
      [{ text: '🪙 AFT → 💎 TON', callback_data: 'swap_aft_ton' }],
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
      [{ text: '🪙 Deposit AFT', callback_data: 'deposit_aft' }],
      [{ text: '⬅️ Back', callback_data: 'back_main' }],
    ],
  };
}

export function depositTonScreen(address: string): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔄 Check Deposit', callback_data: 'check_deposit_ton' }],
      [{ text: '⬅️ Back', callback_data: 'deposit' }],
    ],
  };
}

export function depositAftScreen(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔄 Check Deposit', callback_data: 'check_deposit_aft' }],
      [{ text: '⬅️ Back', callback_data: 'deposit' }],
    ],
  };
}

export function withdrawAssetKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '💎 TON', callback_data: 'withdraw_ton' }],
      [{ text: '🪙 AFT', callback_data: 'withdraw_aft' }],
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

export function adminPanelKeyboard(isSuperAdmin: boolean): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[][] = [
    [{ text: '👥 Users', callback_data: 'admin_users' }],
    [{ text: '📊 Transactions', callback_data: 'admin_transactions' }],
    [{ text: '💰 Deposits', callback_data: 'admin_deposits' }],
    [{ text: '💸 Withdrawals', callback_data: 'admin_withdrawals' }],
    [{ text: '🔄 Swaps', callback_data: 'admin_swaps' }],
    [{ text: '🪙 Token Config', callback_data: 'admin_token' }],
    [{ text: '⚙️ DEX Config', callback_data: 'admin_dex' }],
    [{ text: '💵 Fee Config', callback_data: 'admin_fees' }],
    [{ text: '💵 Price Providers', callback_data: 'admin_prices' }],
    [{ text: '📋 Audit Logs', callback_data: 'admin_audit' }],
    [{ text: '🔧 System Settings', callback_data: 'admin_settings' }],
  ];

  if (isSuperAdmin) {
    buttons.push([{ text: '👑 Admin Management', callback_data: 'admin_management' }]);
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

export function historyPaginationKeyboard(page: number, hasMore: boolean): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 1) buttons.push({ text: '◀️ Prev', callback_data: `history_page_${page - 1}` });
  if (hasMore) buttons.push({ text: '▶️ Next', callback_data: `history_page_${page + 1}` });

  return {
    inline_keyboard: [
      buttons,
      [{ text: '⬅️ Back', callback_data: 'back_main' }],
    ],
  };
}

export function accountKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔐 Export Wallet', callback_data: 'export_wallet' }],
      [{ text: '⬅️ Back', callback_data: 'back_main' }],
    ],
  };
}

export function exportWarningKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔐 Continue', callback_data: 'export_confirm' }],
      [{ text: '❌ Cancel', callback_data: 'account' }],
    ],
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
      [{ text: '⬅️ Back', callback_data: 'back_main' }],
    ],
  };
}

export function userListKeyboard(users: any[], page: number): TelegramBot.InlineKeyboardMarkup {
  const rows = users.map(u => [
    { text: `${u.firstName || 'User'} (${u.telegramId})`, callback_data: `admin_user_${u.telegramId}` },
  ]);

  const nav: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 1) nav.push({ text: '◀️', callback_data: `admin_users_page_${page - 1}` });
  nav.push({ text: '⬅️ Back', callback_data: 'admin_panel' });
  if (users.length === 10) nav.push({ text: '▶️', callback_data: `admin_users_page_${page + 1}` });

  rows.push(nav);
  return { inline_keyboard: rows };
}

export function userActionKeyboard(telegramId: number, isFrozen: boolean): TelegramBot.InlineKeyboardMarkup {
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
