
/**
 * ATF NEXUS — Telegram update router.
 * All screen logic lives in ./screens/*; this file only routes updates
 * and re-exports the public API expected by bot/index.ts and app.ts.
 */
import { TelegramBot, config, getOrCreateUser, setBot, clearState } from './context';
import { showMainMenu, restoreLastAction } from './screens/main-menu';
import * as swapScreens from './screens/swap-screens';
import * as transferScreens from './screens/transfer-screens';
import * as walletScreens from './screens/wallet-screens';
import * as infoScreens from './screens/info-screens';
import * as relayScreens from './screens/relay-screens';
import * as adminScreens from './screens/admin-screens';

export { setBot, showMainMenu };

/* ───────────────────────────────────────────────────────────────────────────
   🚀 START HANDLER
   ─────────────────────────────────────────────────────────────────────────── */

export async function handleStart(msg: TelegramBot.Message): Promise<void> {
  const user = await getOrCreateUser(msg);
  await showMainMenu(user.telegramId, msg.chat.id);
}

/* ───────────────────────────────────────────────────────────────────────────
   🎯 CALLBACK ROUTER
   ─────────────────────────────────────────────────────────────────────────── */

export async function handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
  const userId = query.from.id;
  const chatId = query.message?.chat.id;
  const data = query.data || '';
  if (!chatId) return;

  const { getBot } = await import('./context');
  try {
    await getBot().answerCallbackQuery(query.id);
  } catch { /* ignore */ }

  const user = await getOrCreateUser({
    from: query.from,
    chat: query.message?.chat,
  } as TelegramBot.Message);

  /* ── Core Navigation ── */
  if (data === 'back_main' || data === 'refresh_main') {
    await showMainMenu(userId, chatId);
    return;
  }

  /* ── Swap (TON↔ATF) ── */
  if (data === 'swap') { await swapScreens.showSwapPair(userId, chatId); return; }
  if (data === 'swap_ton_atf') { await swapScreens.startSwapInput(userId, chatId, 'ton_to_atf'); return; }
  if (data === 'swap_atf_ton') { await swapScreens.startSwapInput(userId, chatId, 'atf_to_ton'); return; }
  if (data === 'cancel_swap') { await clearState(userId); await swapScreens.showSwapPair(userId, chatId); return; }
  if (data === 'confirm_swap') { await swapScreens.executeSwap(userId, chatId); return; }

  /* ── PHASE 2: Multi-token swap ── */
  if (data === 'token_search') { await swapScreens.onTokenSearch(userId, chatId, user); return; }
  if (data.startsWith('tokpage_')) {
    const parts = data.split('_');
    await swapScreens.showTokenList(userId, chatId, parts[1], parseInt(parts[2], 10));
    return;
  }
  if (data.startsWith('tokpick_')) {
    const parts = data.split('_');
    await swapScreens.startTokenSwapInput(userId, chatId, parts[1], parts.slice(2).join('_'));
    return;
  }
  if (data === 'confirm_token_swap') {
    if (user.state !== 'swap_token_confirm') { await showMainMenu(userId, chatId); return; }
    await swapScreens.executeTokenSwap(userId, chatId, user);
    return;
  }

  /* ── PHASE 1: Portfolio ── */
  if (data === 'portfolio') { await infoScreens.showPortfolio(userId, chatId, 1); return; }
  if (data.startsWith('portfolio_page_')) {
    await infoScreens.showPortfolio(userId, chatId, parseInt(data.replace('portfolio_page_', ''), 10));
    return;
  }

  /* ── PHASE 4: Transfer Relay (user) ── */
  if (data === 'transfer_relay') { await relayScreens.showRelayHome(userId, chatId, user); return; }
  if (data === 'relay_addresses') { await relayScreens.showRelayAddresses(userId, chatId, user); return; }
  if (data.startsWith('relay_sel_')) {
    await relayScreens.startRelayAmount(userId, chatId, user, data.replace('relay_sel_', ''));
    return;
  }
  if (data === 'relay_fundgo') {
    if (user.state !== 'relay_fundconfirm') { await showMainMenu(userId, chatId); return; }
    await relayScreens.fundRelayFromWallet(userId, chatId, user);
    return;
  }
  if (data === 'relay_confirm') {
    if (user.state !== 'relay_confirm') { await showMainMenu(userId, chatId); return; }
    await relayScreens.executeRelayTransfer(userId, chatId, user);
    return;
  }
  if (data === 'relay_history') { await relayScreens.showRelayHistory(userId, chatId, user); return; }

  /* ── Deposit ── */
  if (data === 'deposit') { await transferScreens.showDepositMenu(userId, chatId); return; }
  if (data === 'deposit_ton') { await transferScreens.showDepositTon(userId, chatId); return; }
  if (data === 'deposit_atf') { await transferScreens.showDepositAtf(userId, chatId); return; }
  if (data === 'check_deposit_ton') { await transferScreens.checkDepositStatus(userId, chatId, 'TON'); return; }
  if (data === 'check_deposit_atf') { await transferScreens.checkDepositStatus(userId, chatId, 'ATF'); return; }

  /* ── Withdraw ── */
  if (data === 'withdraw') { await transferScreens.showWithdrawMenu(userId, chatId); return; }
  if (data === 'withdraw_ton') { await transferScreens.startWithdrawal(userId, chatId, 'TON'); return; }
  if (data === 'withdraw_atf') { await transferScreens.startWithdrawal(userId, chatId, 'ATF'); return; }
  if (data === 'cancel_withdrawal') { await clearState(userId); await transferScreens.showWithdrawMenu(userId, chatId); return; }
  if (data === 'confirm_withdrawal') { await transferScreens.executeWithdrawal(userId, chatId); return; }

  /* ── Account & Wallets ── */
  if (data === 'account') { await walletScreens.showAccount(userId, chatId); return; }
  if (data === 'my_wallets') { await walletScreens.showMyWallets(userId, chatId); return; }
  if (data === 'create_wallet') { await walletScreens.createNewWallet(userId, chatId); return; }
  if (data.startsWith('switch_wallet_')) {
    await walletScreens.switchWallet(userId, chatId, data.replace('switch_wallet_', ''));
    return;
  }
  if (data === 'export_wallet') { await walletScreens.showExportWarning(userId, chatId); return; }
  if (data === 'export_confirm') { await walletScreens.exportWallet(userId, chatId); return; }
  if (data === 'import_wallet') { await walletScreens.startImportWallet(userId, chatId); return; }
  if (data === 'import_version_auto') { await walletScreens.handleImportVersionSelect(userId, chatId, 'auto'); return; }
  if (data === 'import_version_v4') {
    if (user.state === 'import_version_confirm') await walletScreens.handleImportVersionConfirm(userId, chatId, 'v4r2');
    else await walletScreens.handleImportVersionSelect(userId, chatId, 'v4r2');
    return;
  }
  if (data === 'import_version_v5') {
    if (user.state === 'import_version_confirm') await walletScreens.handleImportVersionConfirm(userId, chatId, 'v5r1');
    else await walletScreens.handleImportVersionSelect(userId, chatId, 'v5r1');
    return;
  }

  /* ── Activity / Market / Help / Referral ── */
  if (data === 'history') { await infoScreens.showHistory(userId, chatId, 1); return; }
  if (data.startsWith('history_page_')) {
    await infoScreens.showHistory(userId, chatId, parseInt(data.replace('history_page_', ''), 10));
    return;
  }
  if (data === 'prices') { await infoScreens.showPrices(userId, chatId); return; }
  if (data === 'help') { await infoScreens.showHelp(userId, chatId); return; }
  if (data === 'referral') { await infoScreens.showReferral(userId, chatId); return; }

  /* ── Admin Panel ── */
  if (data === 'admin_panel') { await adminScreens.showAdminPanel(userId, chatId); return; }
  if (data === 'admin_management') { await adminScreens.showAdminManagement(userId, chatId); return; }
  if (data === 'admin_give') { await adminScreens.startGiveAdmin(userId, chatId); return; }
  if (data === 'admin_remove') { await adminScreens.startRemoveAdmin(userId, chatId); return; }
  if (data === 'admin_list') { await adminScreens.showAdminList(userId, chatId); return; }
  if (data === 'admin_search') { await adminScreens.startUserSearch(userId, chatId); return; }
  if (data.startsWith('admin_msg_')) {
    await adminScreens.startAdminMessage(userId, chatId, parseInt(data.replace('admin_msg_', ''), 10));
    return;
  }
  if (data === 'admin_users') { await adminScreens.showUserList(userId, chatId, 1); return; }
  if (data.startsWith('admin_users_page_')) {
    await adminScreens.showUserList(userId, chatId, parseInt(data.replace('admin_users_page_', ''), 10));
    return;
  }
  if (data.startsWith('admin_user_')) {
    await adminScreens.showUserDetail(userId, chatId, parseInt(data.replace('admin_user_', ''), 10));
    return;
  }
  if (data.startsWith('admin_balance_')) {
    await adminScreens.showAdminUserBalance(userId, chatId, parseInt(data.replace('admin_balance_', ''), 10));
    return;
  }
  if (data.startsWith('admin_tx_')) {
    await adminScreens.showAdminUserTransactions(userId, chatId, parseInt(data.replace('admin_tx_', ''), 10));
    return;
  }
  if (data.startsWith('admin_freeze_')) {
    const parts = data.split('_');
    await adminScreens.toggleFreeze(userId, chatId, parseInt(parts[2], 10), parts[3] as 'freeze' | 'unfreeze');
    return;
  }
  if (data === 'admin_transactions') { await adminScreens.showAdminTransactions(userId, chatId, 1); return; }
  if (data.startsWith('admin_transactions_page_')) {
    await adminScreens.showAdminTransactions(userId, chatId, parseInt(data.replace('admin_transactions_page_', ''), 10));
    return;
  }
  if (data === 'admin_deposits') { await adminScreens.showAdminDeposits(userId, chatId, 1); return; }
  if (data.startsWith('admin_deposits_page_')) {
    await adminScreens.showAdminDeposits(userId, chatId, parseInt(data.replace('admin_deposits_page_', ''), 10));
    return;
  }
  if (data === 'admin_withdrawals') { await adminScreens.showAdminWithdrawals(userId, chatId, 1); return; }
  if (data.startsWith('admin_withdrawals_page_')) {
    await adminScreens.showAdminWithdrawals(userId, chatId, parseInt(data.replace('admin_withdrawals_page_', ''), 10));
    return;
  }
  if (data === 'admin_swaps') { await adminScreens.showAdminSwaps(userId, chatId, 1); return; }
  if (data.startsWith('admin_swaps_page_')) {
    await adminScreens.showAdminSwaps(userId, chatId, parseInt(data.replace('admin_swaps_page_', ''), 10));
    return;
  }
  if (data === 'admin_stats') { await adminScreens.handleStats(userId, chatId); return; }
  if (data === 'admin_token') { await adminScreens.showAdminTokenConfig(userId, chatId); return; }
  if (data === 'admin_dex') { await adminScreens.showAdminDexConfig(userId, chatId); return; }
  if (data === 'admin_fees') { await adminScreens.showAdminFeeConfig(userId, chatId); return; }
  if (data === 'admin_prices') { await adminScreens.showAdminPriceProviders(userId, chatId); return; }
  if (data === 'admin_audit') { await adminScreens.showAuditLogs(userId, chatId); return; }
  if (data === 'admin_settings') { await adminScreens.showSystemSettings(userId, chatId); return; }
  if (data === 'admin_sweep') { await adminScreens.startSweepByAddress(userId, chatId); return; }
  if (data === 'admin_broadcast') { await adminScreens.startBroadcast(userId, chatId); return; }
  if (data === 'sweep_asset_ton') { await adminScreens.handleSweepAssetSelect(userId, chatId, 'TON'); return; }
  if (data === 'sweep_asset_atf') { await adminScreens.handleSweepAssetSelect(userId, chatId, 'ATF'); return; }

  /* ── PHASE 5: Admin Relay Dashboard ── */
  if (data === 'admin_relay_addrs') { await relayScreens.showAdminRelayAddresses(userId, chatId, 1); return; }
  if (data.startsWith('admin_relay_addrs_page_')) {
    await relayScreens.showAdminRelayAddresses(userId, chatId, parseInt(data.replace('admin_relay_addrs_page_', ''), 10));
    return;
  }
  if (data.startsWith('radm_addr_')) {
    await relayScreens.showAdminRelayAddressDetail(userId, chatId, data.replace('radm_addr_', ''));
    return;
  }
  if (data.startsWith('radm_sweepyes_')) {
    await relayScreens.executeRelayAddressSweep(userId, chatId, data.replace('radm_sweepyes_', ''));
    return;
  }
  if (data.startsWith('radm_sweep_')) {
    await relayScreens.confirmRelayAddressSweep(userId, chatId, data.replace('radm_sweep_', ''));
    return;
  }
  if (data === 'admin_relay') { await relayScreens.showAdminRelay(userId, chatId); return; }

  await showMainMenu(userId, chatId);
}

/* ───────────────────────────────────────────────────────────────────────────
   ⌨️ TEXT MESSAGE ROUTER
   ─────────────────────────────────────────────────────────────────────────── */

export async function handleText(msg: TelegramBot.Message): Promise<void> {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (!userId) return;

  const user = await getOrCreateUser(msg);

  // Admin input states
  if (user.state === 'admin_give_input') { await adminScreens.handleGiveAdmin(userId, chatId, text); return; }
  if (user.state === 'admin_remove_input') { await adminScreens.handleRemoveAdmin(userId, chatId, text); return; }
  if (user.state === 'broadcast_input') { await adminScreens.handleBroadcast(userId, chatId, text); return; }
  if (user.state === 'admin_user_search') { await adminScreens.handleUserSearch(userId, chatId, text); return; }
  if (user.state === 'admin_msg_input') { await adminScreens.handleAdminMessage(userId, chatId, user, text); return; }
  if (user.state === 'sweep_address_input') { await adminScreens.handleSweepAddressInput(userId, chatId, text); return; }
  if (user.state === 'sweep_amount_input') { await adminScreens.handleSweepAmountInput(userId, chatId, text); return; }

  // PHASE 2: token search / swap amount
  if (user.state === 'token_search') { await swapScreens.handleTokenSearchInput(userId, chatId, user, text); return; }
  if (user.state === 'swap_token_amount') { await swapScreens.handleTokenSwapAmount(userId, chatId, user, text); return; }

  // PHASE 4: relay input states
  if (user.state === 'relay_amount') { await relayScreens.handleRelayAmount(userId, chatId, user, text); return; }
  if (user.state === 'relay_address') { await relayScreens.handleRelayAddress(userId, chatId, user, text); return; }

  // Swap input states
  if (user.state.startsWith('swap_input_')) { await swapScreens.handleSwapInput(userId, chatId, text); return; }

  // Withdrawal input states
  if (user.state.startsWith('withdraw_address_')) { await transferScreens.handleWithdrawAddress(userId, chatId, text); return; }
  if (user.state.startsWith('withdraw_amount_')) { await transferScreens.handleWithdrawAmount(userId, chatId, text); return; }

  // Wallet import
  if (user.state === 'import_mnemonic_input') { await walletScreens.handleImportMnemonic(userId, chatId, text); return; }

  await showMainMenu(userId, chatId);
}

/* ───────────────────────────────────────────────────────────────────────────
   🧹 USER MESSAGE CLEANUP
─────────────────────────────────────────────────────────────────────────── */

export async function delUserMsg(msg: TelegramBot.Message): Promise<void> {
  const { getBot } = await import('./context');
  try {
    await getBot().deleteMessage(msg.chat.id, msg.message_id);
  } catch { /* ignore */ }
                                                                    }
    
