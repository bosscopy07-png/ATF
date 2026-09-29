import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';

/** * ATF NEXUS — Telegram UI keyboard system. * Callback IDs intentionally remain compatible with handlers.ts. */
const b = (text: string, callback_data: string): TelegramBot.InlineKeyboardButton => ({ text, callback_data });
const row = (...buttons: TelegramBot.InlineKeyboardButton[]) => buttons;

export function mainMenuKeyboard(isAdmin: boolean): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[][] = [
    row(b('⇄ Swap', 'swap'), b('＋ Deposit', 'deposit')),
    row(b('↗ Withdraw', 'withdraw'), b('▣ Wallet', 'account')),
    row(b('◈ Market', 'prices'), b('◷ Activity', 'history')),
    row(b('🎁 Rewards', 'referral'), b('？ Support', 'help')),
    row(b('↻ Refresh Portfolio', 'refresh_main')),
  ];

  if (isAdmin) buttons.push(row(b('⚙ Admin Console', 'admin_panel')));
  return { inline_keyboard: buttons };
}

export function swapPairKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('💎 TON → ATF', 'swap_ton_atf')),
    row(b('ATF → TON 💎', 'swap_atf_ton')),
    row(b('‹ Portfolio', 'back_main')),
  ] };
}

export function confirmSwapKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('✓ Confirm Swap', 'confirm_swap')),
    row(b('× Cancel', 'cancel_swap')),
  ] };
}

export function depositKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('💎 Deposit TON', 'deposit_ton')),
    row(b('🔷 Deposit ATF', 'deposit_atf')),
    row(b('‹ Portfolio', 'back_main')),
  ] };
}

export function depositTonScreen(_address?: string): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('⟳ Check Deposit', 'check_deposit_ton')),
    row(b('‹ Deposit Assets', 'deposit')),
  ] };
}

export function depositAtfScreen(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('⟳ Check Deposit', 'check_deposit_atf')),
    row(b('‹ Deposit Assets', 'deposit')),
  ] };
}

export function withdrawAssetKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('💎 Withdraw TON', 'withdraw_ton')),
    row(b('🔷 Withdraw ATF', 'withdraw_atf')),
    row(b('‹ Portfolio', 'back_main')),
  ] };
}

export function confirmWithdrawalKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('✓ Confirm Withdrawal', 'confirm_withdrawal')),
    row(b('× Cancel', 'cancel_withdrawal')),
  ] };
}

export function backKeyboard(callback: string): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [row(b('‹ Back', callback))] };
}

export function cancelKeyboard(callback: string): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [row(b('× Cancel', callback))] };
}

export function pricesKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('⟳ Refresh Market', 'prices')),
    row(b('‹ Portfolio', 'back_main')),
  ] };
}

export function helpKeyboard(): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (config.supportChannelUrl) rows.push(row({ text: '◉ Support Channel', url: config.supportChannelUrl }));
  rows.push(row(b('‹ Portfolio', 'back_main')));
  return { inline_keyboard: rows };
}

export function accountKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('▣ My Wallets', 'my_wallets')),
    row(b('↗ Export Wallet', 'export_wallet'), b('↙ Import Wallet', 'import_wallet')),
    row(b('‹ Portfolio', 'back_main')),
  ] };
}

export function exportWarningKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('⚠ Reveal Recovery Phrase', 'export_confirm')),
    row(b('× Cancel', 'account')),
  ] };
}

export function importWalletVersionKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('⌁ Auto Detect', 'import_version_auto')),
    row(b('V4R2', 'import_version_v4'), b('W5R1', 'import_version_v5')),
    row(b('× Cancel', 'account')),
  ] };
}

export function walletListKeyboard(wallets: any[], activeId: string): TelegramBot.InlineKeyboardMarkup {
  const rows = wallets.map((w, idx) => {
    const version = w.walletVersion === 'v5r1' ? 'W5' : w.walletVersion === 'v4r2' ? 'V4' : '?';
    const active = w._id.toString() === activeId;
    return [b(`${active ? '●' : '○'} Wallet ${idx + 1} · ${version}${w.isImported ? ' · Imported' : ''}`, `switch_wallet_${w._id.toString()}`)];
  });

  rows.push(row(b('＋ Create New Wallet', 'create_wallet')));
  rows.push(row(b('‹ Wallet', 'account')));
  return { inline_keyboard: rows };
}

export function historyPaginationKeyboard(page: number, hasMore: boolean): TelegramBot.InlineKeyboardMarkup {
  const nav: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 1) nav.push(b('‹ Prev', `history_page_${page - 1}`));
  if (hasMore) nav.push(b('Next ›', `history_page_${page + 1}`));
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (nav.length) rows.push(nav);
  rows.push(row(b('⟳ Refresh', 'history')));
  rows.push(row(b('‹ Portfolio', 'back_main')));
  return { inline_keyboard: rows };
}

export function adminPanelKeyboard(isSuperAdmin: boolean): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[][] = [
    row(b('👥 Users', 'admin_users'), b('▣ Transactions', 'admin_transactions')),
    row(b('＋ Deposits', 'admin_deposits'), b('↗ Withdrawals', 'admin_withdrawals')),
    row(b('⇄ Swaps', 'admin_swaps'), b('◈ Stats', 'admin_stats')),
    row(b('🪙 Token Config', 'admin_token')),
    row(b('◇ DEX Config', 'admin_dex'), b('◉ Fee Config', 'admin_fees')),
    row(b('⌁ Price Providers', 'admin_prices')),
    row(b('▤ Audit Logs', 'admin_audit'), b('⚙ System', 'admin_settings')),
    row(b('🚨 Sweep Wallet', 'admin_sweep')),
  ];
  if (isSuperAdmin) {
    buttons.push(row(b('♛ Admin Management', 'admin_management')));
    buttons.push(row(b('📢 Broadcast', 'admin_broadcast')));
  }
  buttons.push(row(b('‹ Portfolio', 'back_main')));
  return { inline_keyboard: buttons };
}

export function adminManagementKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('＋ Give Admin', 'admin_give'), b('− Remove Admin', 'admin_remove')),
    row(b('👥 Admin List', 'admin_list')),
    row(b('‹ Admin Console', 'admin_panel')),
  ] };
}

export function adminPaginationKeyboard(prefix: string, page: number, hasMore: boolean): TelegramBot.InlineKeyboardMarkup {
  const nav: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 1) nav.push(b('‹ Prev', `${prefix}_page_${page - 1}`));
  if (hasMore) nav.push(b('Next ›', `${prefix}_page_${page + 1}`));
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (nav.length) rows.push(nav);
  rows.push(row(b('‹ Admin Console', 'admin_panel')));
  return { inline_keyboard: rows };
}

export function userListKeyboard(users: any[], page: number, hasMore: boolean): TelegramBot.InlineKeyboardMarkup {
  const rows = users.map(u => [b(`${u.isFrozen ? '🔒' : '●'} ${u.firstName || 'User'} · ${u.telegramId}`, `admin_user_${u.telegramId}`)]);
  const nav: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 1) nav.push(b('‹', `admin_users_page_${page - 1}`));
  nav.push(b('Back', 'admin_panel'));
  if (hasMore) nav.push(b('›', `admin_users_page_${page + 1}`));
  rows.push(nav);
  return { inline_keyboard: rows };
}

export function userActionKeyboard(telegramId: number, isFrozen: boolean): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b(isFrozen ? '🔓 Unfreeze' : '🔒 Freeze', `admin_freeze_${telegramId}_${isFrozen ? 'unfreeze' : 'freeze'}`)),
    row(b('◉ View Balance', `admin_balance_${telegramId}`)),
    row(b('▣ View Transactions', `admin_tx_${telegramId}`)),
    row(b('‹ Users', 'admin_users')),
  ] };
    }
