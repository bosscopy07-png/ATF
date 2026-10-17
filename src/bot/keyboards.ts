import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';

/**
 * ATF NEXUS — Telegram UI keyboard system.
 * Callback IDs intentionally remain compatible with handlers.ts.
 */
const b = (text: string, callback_data: string): TelegramBot.InlineKeyboardButton => ({ text, callback_data });
const row = (...buttons: TelegramBot.InlineKeyboardButton[]) => buttons;

/** Standard "back to dashboard" row — label always matches the main menu. */
const mainRow = () => row(b('🏠 Main Menu', 'back_main'));

export function mainMenuKeyboard(isAdmin: boolean): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[][] = [
    row(b('⇄ Swap', 'swap'), b('＋ Deposit', 'deposit')),
    row(b('↗ Withdraw', 'withdraw'), b('▣ Wallet', 'account')),
    row(b('⚖️ Market', 'prices'), b('◷ Activity', 'history')),
    row(b('🎁 Rewards', 'referral'), b('❓ Support', 'help')),
    // ── PHASE 1/4 addition: new menu entries (existing rows untouched) ──
    row(b('📊 Portfolio', 'portfolio'), b('🚀 Transfer Relay', 'transfer_relay')),
    row(b('⟳ Refresh', 'refresh_main')),
  ];

  if (isAdmin) buttons.push(row(b('⚙ Admin Console', 'admin_panel')));
  return { inline_keyboard: buttons };
}

export function swapPairKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('💎 TON → ATF 🔷', 'swap_ton_atf')),
    row(b('🔷 ATF → TON 💎', 'swap_atf_ton')),
    // ── PHASE 2 addition ──
    row(b('🪙 Swap Other Tokens', 'token_search')),
    mainRow(),
  ] };
}

export function confirmSwapKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('✅ Confirm Swap', 'confirm_swap')),
    row(b('❌ Cancel', 'cancel_swap')),
  ] };
}

export function depositKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('💎 Deposit TON', 'deposit_ton')),
    row(b('🔷 Deposit ATF', 'deposit_atf')),
    mainRow(),
  ] };
}

export function depositTonScreen(_address?: string): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('⟳ Check Deposit', 'check_deposit_ton')),
    row(b('‹ Assets', 'deposit')),
  ] };
}

export function depositAtfScreen(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('⟳ Check Deposit', 'check_deposit_atf')),
    row(b('‹ Assets', 'deposit')),
  ] };
}

export function withdrawAssetKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('💎 Withdraw TON', 'withdraw_ton')),
    row(b('🔷 Withdraw ATF', 'withdraw_atf')),
    mainRow(),
  ] };
}

export function confirmWithdrawalKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('✅ Confirm & Send', 'confirm_withdrawal')),
    row(b('❌ Cancel', 'cancel_withdrawal')),
  ] };
}

export function backKeyboard(callback: string): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [row(b('‹ Back', callback))] };
}

export function cancelKeyboard(callback: string): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [row(b('❌ Cancel', callback))] };
}

export function pricesKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('⟳ Refresh Market', 'prices')),
    mainRow(),
  ] };
}

export function helpKeyboard(): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (config.supportChannelUrl) rows.push(row({ text: '◉ Support Channel', url: config.supportChannelUrl }));
  rows.push(mainRow());
  return { inline_keyboard: rows };
}

export function accountKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('▣ My Wallets', 'my_wallets')),
    row(b('↗ Export', 'export_wallet'), b('↙ Import', 'import_wallet')),
    mainRow(),
  ] };
}

export function exportWarningKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('⚠️ Reveal Recovery Phrase', 'export_confirm')),
    row(b('❌ Cancel', 'account')),
  ] };
}

export function importWalletVersionKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('⌁ Auto Detect', 'import_version_auto')),
    row(b('V4R2', 'import_version_v4'), b('W5R1', 'import_version_v5')),
    row(b('❌ Cancel', 'account')),
  ] };
}

export function walletListKeyboard(wallets: any[], activeId: string): TelegramBot.InlineKeyboardMarkup {
  const rows = wallets.map((w, idx) => {
    const version = w.walletVersion === 'v5r1' ? 'W5' : w.walletVersion === 'v4r2' ? 'V4' : '?';
    const active = w._id.toString() === activeId;
    return [b(`${active ? '🟢' : '⚪'} Wallet ${idx + 1} · ${version}${w.isImported ? ' · Imported' : ''}`, `switch_wallet_${w._id.toString()}`)];
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
  rows.push(mainRow());
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
    // ── PHASE 5 addition ──
    row(b('🚀 Relay Dashboard', 'admin_relay')),
  ];
  if (isSuperAdmin) {
    buttons.push(row(b('♛ Admin Management', 'admin_management')));
    buttons.push(row(b('📢 Broadcast', 'admin_broadcast')));
  }
  buttons.push(mainRow());
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
  rows.unshift([b('🔍 Search by ID or Address', 'admin_search')]);
  return { inline_keyboard: rows };
}

export function userActionKeyboard(telegramId: number, isFrozen: boolean): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b(isFrozen ? '🔓 Unfreeze' : '🔒 Freeze', `admin_freeze_${telegramId}_${isFrozen ? 'unfreeze' : 'freeze'}`)),
    row(b('✉️ Message User', `admin_msg_${telegramId}`)),
    row(b('◉ View Balance', `admin_balance_${telegramId}`)),
    row(b('▣ View Transactions', `admin_tx_${telegramId}`)),
    row(b('‹ Users', 'admin_users')),
  ] };
}

/* ═══════════════════════════════════════════════════════════
   PHASE 1 — PORTFOLIO
   ═══════════════════════════════════════════════════════════ */

export function portfolioKeyboard(page: number, hasMore: boolean): TelegramBot.InlineKeyboardMarkup {
  const nav: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 1) nav.push(b('‹ Prev', `portfolio_page_${page - 1}`));
  if (hasMore) nav.push(b('Next ›', `portfolio_page_${page + 1}`));
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (nav.length) rows.push(nav);
  rows.push(row(b('⟳ Refresh', 'portfolio')));
  rows.push(mainRow());
  return { inline_keyboard: rows };
}

/* ═══════════════════════════════════════════════════════════
   PHASE 2 — MULTI-TOKEN SWAP
   ═══════════════════════════════════════════════════════════ */

export function tokenSearchKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('🔍 Search Token', 'token_search')),
    row(b('‹ Back', 'swap')),
  ] };
}

export function tokenListKeyboard(
  tokens: Array<{ masterAddress: string; symbol: string }>,
  page: number,
  hasMore: boolean,
  direction: string
): TelegramBot.InlineKeyboardMarkup {
  const rows = tokens.map((t) => [
    b(`🪙 ${t.symbol}`, `tokpick_${direction}_${t.masterAddress}`),
  ]);
  const nav: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 1) nav.push(b('‹', `tokpage_${direction}_${page - 1}`));
  if (hasMore) nav.push(b('›', `tokpage_${direction}_${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push(row(b('🔍 Search', 'token_search')));
  rows.push(row(b('‹ Back', 'swap')));
  return { inline_keyboard: rows };
}

/* ═══════════════════════════════════════════════════════════
   PHASE 4 — TRANSFER RELAY
   ═══════════════════════════════════════════════════════════ */

export function relayMenuKeyboard(hasAddresses: boolean): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (hasAddresses) rows.push(row(b('📋 My Relay Addresses', 'relay_addresses')));
  rows.push(row(b('🧾 Relay History', 'relay_history')));
  rows.push(row(b('♻️ Reclaim TON', 'relay_reclaim')));
  rows.push(mainRow());
  return { inline_keyboard: rows };
}

export function relayConfirmKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [
    row(b('✅ Confirm Transfer', 'relay_confirm')),
    row(b('❌ Cancel', 'transfer_relay')),
  ] };
}
