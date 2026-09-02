import TelegramBot from 'node-telegram-bot-api';
import { User } from '../models/User';
import { Wallet } from '../models/Wallet';
import { Transaction } from '../models/Transaction';
import { AdminAction } from '../models/AdminAction';
import { Referral } from '../models/Referral';
import { TelegramMessageManager } from '../utils/telegram-message-manager';
import { SwapService } from '../services/swap-service';
import { WithdrawalService } from '../services/withdrawal-service';
import { WalletService } from '../services/wallet-service';
import { PriceService } from '../services/price-service';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS, ATF_DECIMALS } from '../config';
import {
  isValidTonAddress,
  isValidAmount,
  isValidTelegramId,
  formatAddressShort,
} from '../utils/validation';
import * as keyboards from './keyboards';

const messageManager = new TelegramMessageManager({} as TelegramBot);
const swapService = new SwapService();
const withdrawalService = new WithdrawalService();
const walletService = new WalletService();
const priceService = PriceService.getInstance();

let botInstance: TelegramBot;

export function setBot(bot: TelegramBot) {
  botInstance = bot;
  (messageManager as any).bot = bot;
}

// ─── Persistent Message Helper ───────────────────────────────────────────────
async function render(
  userId: number,
  chatId: number,
  text: string,
  keyboard: any,
  opts?: { alert?: boolean; keepKeyboard?: boolean }
): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  const msgId = user?.lastBotMessageId;

  if (msgId && !opts?.alert) {
    try {
      await botInstance.editMessageText(text, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'HTML',
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
      return;
    } catch (err: any) {
      if (err.message?.includes('message is not modified')) return;
    }
  }

  const sent = await botInstance.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
    disable_web_page_preview: true,
  });

  if (user) {
    user.lastBotMessageId = sent.message_id;
    await user.save();
  }
}

async function toast(userId: number, chatId: number, text: string, keyboard: any): Promise<void> {
  return render(userId, chatId, text, keyboard, { alert: true });
}

async function delUserMsg(chatId: number, messageId: number): Promise<void> {
  try {
    await botInstance.deleteMessage(chatId, messageId);
  } catch {
    /* ignore */
  }
}

// ─── User Lifecycle ──────────────────────────────────────────────────────────
async function getOrCreateUser(msg: TelegramBot.Message): Promise<any> {
  const telegramId = msg.from?.id;
  if (!telegramId) throw new Error('No telegram ID');

  let user = await User.findOne({ telegramId });
  if (!user) {
    const isSuper = telegramId === Number(config.superAdminTelegramId);
    user = await User.create({
      telegramId,
      username: msg.from?.username,
      firstName: msg.from?.first_name,
      lastName: msg.from?.last_name,
      isSuperAdmin: isSuper,
      isAdmin: isSuper,
      state: 'idle',
      stateData: {},
      lastAction: 'main_menu',
    });
    await walletService.createWallet(telegramId);

    // Referral tracking
    const refCode = (msg.text || '').split(' ')[1];
    if (refCode && /^\d+$/.test(refCode)) {
      const referrerId = parseInt(refCode, 10);
      if (referrerId !== telegramId) {
        await Referral.create({ referrerId, referredId: telegramId });
        await botInstance.sendMessage(
          referrerId,
          `🎉 <b>New Referral!</b>\n\nUser <code>${telegramId}</code> joined using your link.`,
          { parse_mode: 'HTML' }
        );
      }
    }
  }

  // Re-sync super-admin status if env changed
  const envSuper = Number(config.superAdminTelegramId);
  if (telegramId === envSuper && !user.isSuperAdmin) {
    user.isSuperAdmin = true;
    user.isAdmin = true;
    await user.save();
  }

  return user;
}

async function requireAdmin(userId: number): Promise<any> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || (!user.isAdmin && !user.isSuperAdmin)) throw new Error('Unauthorized');
  return user;
}

async function requireSuperAdmin(userId: number): Promise<any> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.isSuperAdmin) throw new Error('Super Admin only');
  return user;
}

// ─── Explorer Link ───────────────────────────────────────────────────────────
function explorerLink(txHash: string): string {
  if (!txHash || txHash.includes('_')) return '';
  return `https://tonscan.org/tx/${txHash}`;
}

// ─── Restore Last Action Helper ──────────────────────────────────────────────
async function restoreLastAction(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) {
    await showMainMenu(userId, chatId);
    return;
  }

  // If user was in an input state, reset to idle (context lost)
  if (user.state.includes('input') || user.state.includes('confirm')) {
    user.state = 'idle';
    user.stateData = {};
    await user.save();
    await toast(userId, chatId, '👋 <b>Welcome back!</b>\n\nYour previous session was reset.', keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
    setTimeout(() => showMainMenu(userId, chatId), 1500);
    return;
  }

  // Route based on last known menu/action
  switch (user.lastAction) {
    case 'swap': await showSwapPair(userId, chatId); break;
    case 'deposit': await showDepositMenu(userId, chatId); break;
    case 'withdraw': await showWithdrawMenu(userId, chatId); break;
    case 'account': await showAccount(userId, chatId); break;
    case 'history': await showHistory(userId, chatId, 1); break;
    case 'prices': await showPrices(userId, chatId); break;
    case 'admin_panel': await showAdminPanel(userId, chatId); break;
    default: await showMainMenu(userId, chatId);
  }
}
// ─── MAIN MENU ─────────────────────────────────────────────────────────────────
export async function showMainMenu(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  // Track last action
  user.lastAction = 'main_menu';
  await user.save();

  const wallet = await walletService.getWallet(userId);

  let tonBalance = '0';
  let atfBalance = '0';

  if (wallet?.address) {
    try {
      const onChain = await walletService.getBalance(wallet.address);
      tonBalance = Precision.fromBaseUnits(onChain.ton, TON_DECIMALS);
      atfBalance = Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS);
    } catch {
      /* fallback to zero */
    }
  }

  const [atfPrice, tonPrice, ngnRate] = await Promise.all([
    priceService.getAtfPriceUsd().catch(() => null),
    priceService.getTonPriceUsd().catch(() => null),
    priceService.getUsdNgnRate().catch(() => null),
  ]);

  const tonUsd = tonPrice
    ? priceService.convertCryptoToUsd(tonBalance, tonPrice.price, TON_DECIMALS)
    : null;

  const atfUsd = atfPrice
    ? priceService.convertCryptoToUsd(atfBalance, atfPrice.price, ATF_DECIMALS)
    : null;

  const totalUsd = (parseFloat(tonUsd || '0') + parseFloat(atfUsd || '0')).toFixed(2);
  const totalNgn = ngnRate ? priceService.convertUsdToNgn(totalUsd, ngnRate.price) : null;

  const priceLine = atfPrice && tonPrice
    ? `💎 TON <code>$${tonPrice.price.toFixed(2)}</code>  ·  🪙 ATF <code>$${atfPrice.price.toFixed(6)}</code>`
    : '';

  const caption = [
    `╔═══════════════════╗`,
    `║   ⚡ ATF SWAP ⚡   ║`,
    `╚═══════════════════╝`,
    '',
    `💎 <b>TON</b>      <code>${Precision.formatDisplay(tonBalance)}</code> TON`,
    tonUsd ? `   <i>≈ $${tonUsd}</i>` : '',
    '',
    `🪙 <b>ATF</b>      <code>${Precision.formatDisplay(atfBalance)}</code> ATF`,
    atfUsd ? `   <i>≈ $${atfUsd}</i>` : '',
    ngnRate && atfUsd ? `   <i>≈ ₦${priceService.convertUsdToNgn(atfUsd, ngnRate.price)}</i>` : '',
    '',
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    totalUsd !== '0.00' ? `💼 Portfolio  <b>$${totalUsd}</b> ${totalNgn ? `· ₦${totalNgn}` : ''}` : '',
    priceLine,
    '',
    wallet && !wallet.isImported
      ? `⚠️ <i>Tap "👤 Account" to back up your wallet</i>`
      : '',
    '',
    `<i>Select an action below 👇</i>`,
  ].filter(Boolean).join('\n');

  const isAdmin = user.isAdmin === true || user.isSuperAdmin === true;

  await render(userId, chatId, caption, keyboards.mainMenuKeyboard(isAdmin));
}

// ─── START COMMAND ─────────────────────────────────────────────────────────────
export async function handleStart(msg: TelegramBot.Message): Promise<void> {
  const user = await getOrCreateUser(msg);

  if (user.createdAt && Date.now() - new Date(user.createdAt).getTime() > 60000) {
    // Existing user (> 1 min old) → restore last action
    await restoreLastAction(user.telegramId, msg.chat.id);
  } else {
    // Brand new user
    await showMainMenu(user.telegramId, msg.chat.id);
  }
}

// ─── CALLBACK ROUTER ─────────────────────────────────────────────────────────
export async function handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
  const userId = query.from.id;
  const chatId = query.message?.chat.id;
  const data = query.data || '';

  if (!chatId) return;

  try {
    await botInstance.answerCallbackQuery(query.id);
  } catch {
    /* ignore */
  }

  const user = await getOrCreateUser({
    from: query.from,
    chat: query.message?.chat,
  } as TelegramBot.Message);

  // ─── Core Navigation ─────────────────────────────────────────────────────
  if (data === 'back_main' || data === 'refresh_main') {
    await showMainMenu(userId, chatId);
    return;
  }

  if (data === 'swap') {
    await showSwapPair(userId, chatId);
    return;
  }

  if (data === 'swap_ton_atf') {
    await startSwapInput(userId, chatId, 'ton_to_atf');
    return;
  }

  if (data === 'swap_atf_ton') {
    await startSwapInput(userId, chatId, 'atf_to_ton');
    return;
  }

  if (data === 'confirm_swap') {
    await executeSwap(userId, chatId);
    return;
  }

  if (data === 'cancel_swap') {
    await clearState(userId);
    await showMainMenu(userId, chatId);
    return;
  }

  if (data === 'deposit') {
    await showDepositMenu(userId, chatId);
    return;
  }

  if (data === 'deposit_ton') {
    await showDepositTon(userId, chatId);
    return;
  }

  if (data === 'deposit_atf') {
    await showDepositAtf(userId, chatId);
    return;
  }

  if (data === 'check_deposit_ton') {
    await checkDepositStatus(userId, chatId, 'TON');
    return;
  }

  if (data === 'check_deposit_atf') {
    await checkDepositStatus(userId, chatId, 'ATF');
    return;
  }

  if (data === 'withdraw') {
    await showWithdrawMenu(userId, chatId);
    return;
  }

  if (data === 'withdraw_ton') {
    await startWithdrawal(userId, chatId, 'TON');
    return;
  }

  if (data === 'withdraw_atf') {
    await startWithdrawal(userId, chatId, 'ATF');
    return;
  }

  if (data === 'confirm_withdrawal') {
    await executeWithdrawal(userId, chatId);
    return;
  }

  if (data === 'cancel_withdrawal') {
    await clearState(userId);
    await showMainMenu(userId, chatId);
    return;
  }

  if (data === 'account') {
    await showAccount(userId, chatId);
    return;
  }

  if (data === 'export_wallet') {
    await showExportWarning(userId, chatId);
    return;
  }

  if (data === 'export_confirm') {
    await exportWallet(userId, chatId);
    return;
  }

  if (data === 'import_wallet') {
    await startImportWallet(userId, chatId);
    return;
  }

  if (data === 'history') {
    await showHistory(userId, chatId, 1);
    return;
  }

  if (data.startsWith('history_page_')) {
    const page = parseInt(data.split('_')[2], 10);
    await showHistory(userId, chatId, page);
    return;
  }

  if (data === 'prices') {
    await showPrices(userId, chatId);
    return;
  }

  if (data === 'help') {
    await showHelp(userId, chatId);
    return;
  }

  if (data === 'settings') {
    await showSettings(userId, chatId);
    return;
  }

  if (data === 'referral') {
    await showReferral(userId, chatId);
    return;
  }

  // ─── Admin Callbacks ─────────────────────────────────────────────────────
  if (data === 'admin_panel') {
    await showAdminPanel(userId, chatId);
    return;
  }

  if (data === 'admin_management') {
    await showAdminManagement(userId, chatId);
    return;
  }

  if (data === 'admin_give') {
    await startGiveAdmin(userId, chatId);
    return;
  }

  if (data === 'admin_remove') {
    await startRemoveAdmin(userId, chatId);
    return;
  }

  if (data === 'admin_list') {
    await showAdminList(userId, chatId);
    return;
  }

  if (data === 'admin_users') {
    await showUserList(userId, chatId, 1);
    return;
  }

  if (data.startsWith('admin_users_page_')) {
    const page = parseInt(data.split('_')[3], 10);
    await showUserList(userId, chatId, page);
    return;
  }

  if (data.startsWith('admin_user_')) {
    const targetId = parseInt(data.split('_')[2], 10);
    await showUserDetail(userId, chatId, targetId);
    return;
  }

  if (data.startsWith('admin_freeze_')) {
    const parts = data.split('_');
    await toggleFreeze(userId, chatId, parseInt(parts[2], 10), parts[3]);
    return;
  }

  if (data.startsWith('admin_balance_')) {
    const targetId = parseInt(data.split('_')[2], 10);
    await showAdminUserBalance(userId, chatId, targetId);
    return;
  }

  if (data.startsWith('admin_tx_')) {
    const targetId = parseInt(data.split('_')[2], 10);
    await showAdminUserTransactions(userId, chatId, targetId);
    return;
  }

  if (data === 'admin_audit') {
    await showAuditLogs(userId, chatId);
    return;
  }

  if (data === 'admin_settings') {
    await showSystemSettings(userId, chatId);
    return;
  }

  if (data === 'admin_transactions') {
    await showAdminTransactions(userId, chatId, 1);
    return;
  }

  if (data === 'admin_deposits') {
    await showAdminDeposits(userId, chatId, 1);
    return;
  }

  if (data === 'admin_withdrawals') {
    await showAdminWithdrawals(userId, chatId, 1);
    return;
  }

  if (data === 'admin_swaps') {
    await showAdminSwaps(userId, chatId, 1);
    return;
  }

  if (data === 'admin_token') {
    await showAdminTokenConfig(userId, chatId);
    return;
  }

  if (data === 'admin_dex') {
    await showAdminDexConfig(userId, chatId);
    return;
  }

  if (data === 'admin_fees') {
    await showAdminFeeConfig(userId, chatId);
    return;
  }

  if (data === 'admin_prices') {
    await showAdminPriceProviders(userId, chatId);
    return;
  }
}

async function clearState(userId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.state = 'idle';
    user.stateData = {};
    await user.save();
  }
}
// ─── SWAP FLOW ───────────────────────────────────────────────────────────────
async function showSwapPair(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) { user.lastAction = 'swap'; await user.save(); }

  const caption = [
    '🔄 <b>INSTANT SWAP</b>',
    '',
    'Choose your trading pair:',
    '',
    '<i>Zero slippage protection enabled ✅</i>',
  ].join('\n');

  await render(userId, chatId, caption, keyboards.swapPairKeyboard());
}

async function startSwapInput(userId: number, chatId: number, direction: 'ton_to_atf' | 'atf_to_ton'): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const wallet = await walletService.getWallet(userId);
  let balance = '0';

  if (wallet?.address) {
    try {
      const onChain = await walletService.getBalance(wallet.address);
      const raw = direction === 'ton_to_atf' ? onChain.ton : onChain.atf;
      balance = Precision.fromBaseUnits(raw, direction === 'ton_to_atf' ? TON_DECIMALS : ATF_DECIMALS);
    } catch {
      /* ignore */
    }
  }

  const caption = [
    direction === 'ton_to_atf' ? '💎 <b>TON → ATF</b>' : '🪙 <b>ATF → TON</b>',
    '',
    `Enter the amount to swap.`,
    '',
    direction === 'ton_to_atf' ? `📌 Min: <b>${config.minSwapTon} TON</b>` : '',
    `💰 Balance: <code>${Precision.formatDisplay(balance)} ${direction === 'ton_to_atf' ? 'TON' : 'ATF'}</code>`,
  ].filter(Boolean).join('\n');

  user.state = `swap_input_${direction}`;
  user.stateData = {};
  await user.save();

  await render(userId, chatId, caption, keyboards.backKeyboard('swap'));
}

async function handleSwapInput(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const direction = user.state.replace('swap_input_', '') as 'ton_to_atf' | 'atf_to_ton';

  if (!isValidAmount(text)) {
    await toast(userId, chatId, '❌ Enter a valid positive number.', keyboards.backKeyboard('swap'));
    return;
  }

  try {
    const confirmation = await swapService.prepareSwap({ userId, direction, amount: text });

    user.state = `swap_confirm_${direction}`;
    user.stateData = { confirmation, inputAmount: text };
    await user.save();

    const [atfPrice, tonPrice] = await Promise.all([
      priceService.getAtfPriceUsd(),
      priceService.getTonPriceUsd(),
    ]);

    let receiveUsd = '';
    if (direction === 'ton_to_atf' && atfPrice) {
      receiveUsd = priceService.convertCryptoToUsd(confirmation.expectedOutput, atfPrice.price, ATF_DECIMALS);
    } else if (direction === 'atf_to_ton' && tonPrice) {
      receiveUsd = priceService.convertCryptoToUsd(confirmation.expectedOutput, tonPrice.price, TON_DECIMALS);
    }

    const isTonToAtf = direction === 'ton_to_atf';
    const caption = [
      '🔄 <b>SWAP QUOTE</b>',
      '',
      `<b>You Pay:</b>     <code>${Precision.formatDisplay(confirmation.inputAmount)} ${isTonToAtf ? 'TON' : 'ATF'}</code>`,
      `<b>Platform Fee:</b> <code>${Precision.formatDisplay(confirmation.platformFee)} ${isTonToAtf ? 'TON' : 'ATF'}</code>`,
      `<b>Swap Net:</b>     <code>${Precision.formatDisplay(confirmation.netSwapAmount)} ${isTonToAtf ? 'TON' : 'ATF'}</code>`,
      '',
      `<b>You Receive:</b>  <code>${Precision.formatDisplay(confirmation.expectedOutput)} ${isTonToAtf ? 'ATF' : 'TON'}</code>`,
      receiveUsd ? `   <i>≈ $${receiveUsd}</i>` : '',
      `<b>Minimum:</b>     <code>${Precision.formatDisplay(confirmation.minOutput)} ${isTonToAtf ? 'ATF' : 'TON'}</code>`,
      isTonToAtf ? `<b>Network Cost:</b> <code>${Precision.formatDisplay(confirmation.dexCosts)} TON</code>` : '',
      '',
      `<b>Rate:</b> ${confirmation.rate}`,
      `⏳ Expires in <b>${Math.max(0, Math.floor((confirmation.expiresAt.getTime() - Date.now()) / 1000))}s</b>`,
    ].filter(Boolean).join('\n');

    await render(userId, chatId, caption, keyboards.confirmSwapKeyboard());
  } catch (error: any) {
    const msg = error.message?.includes('Minimum')
      ? `❌ Minimum swap is <b>${config.minSwapTon} TON</b>`
      : error.message?.includes('gas treasury')
      ? `⏳ ${error.message}`
      : `❌ ${error.message}`;
    await toast(userId, chatId, msg, keyboards.backKeyboard('swap'));
  }
}

async function executeSwap(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('swap_confirm_')) {
    await showMainMenu(userId, chatId);
    return;
  }

  const direction = user.state.replace('swap_confirm_', '') as 'ton_to_atf' | 'atf_to_ton';
  const { confirmation } = user.stateData;

  if (!confirmation || new Date() > new Date(confirmation.expiresAt)) {
    await clearState(userId);
    await toast(userId, chatId, '❌ Quote expired. Start again.', keyboards.backKeyboard('swap'));
    return;
  }

  await render(userId, chatId, '⏳ <b>Executing Swap…</b>\n\nBroadcasting to TON blockchain ⛓️', {
    inline_keyboard: [],
  });

  try {
    const txId = await swapService.executeSwap(userId, confirmation, direction);
    const txRecord = await Transaction.findById(txId);
    const txHash = txRecord?.txHash || '';
    const link = explorerLink(txHash);

    const isTonToAtf = direction === 'ton_to_atf';
    const caption = [
      '✅ <b>Swap Executed</b>',
      '',
      `<b>Sent:</b>     ${Precision.formatDisplay(confirmation.inputAmount)} ${isTonToAtf ? 'TON' : 'ATF'}`,
      `<b>Receive:</b>  ${Precision.formatDisplay(confirmation.expectedOutput)} ${isTonToAtf ? 'ATF' : 'TON'}`,
      `<b>Speed:</b>    ~3–6s`,
      `<b>Asset:</b>    ${isTonToAtf ? 'ATF' : 'TON'}`,
      link ? `🔗 <a href="${link}">View on Explorer</a>` : '',
      '',
      '<i>Funds will be credited once the blockchain confirms.</i>',
    ].filter(Boolean).join('\n');

    await clearState(userId);
    await render(userId, chatId, caption, keyboards.backKeyboard('back_main'));
  } catch (error: any) {
    await toast(userId, chatId, `❌ <b>Swap Failed</b>\n\n${error.message}`, keyboards.backKeyboard('swap'));
  }
}

// ─── DEPOSIT FLOW ──────────────────────────────────────────────────────────
async function showDepositMenu(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) { user.lastAction = 'deposit'; await user.save(); }

  const caption = [
    '💰 <b>DEPOSIT</b>',
    '',
    'Select asset to deposit:',
    '',
    '<i>All deposits are auto-credited ✅</i>',
  ].join('\n');

  await render(userId, chatId, caption, keyboards.depositKeyboard());
}

async function showDepositTon(userId: number, chatId: number): Promise<void> {
  const wallet = await walletService.getWallet(userId);
  if (!wallet) {
    await toast(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('deposit'));
    return;
  }

  const caption = [
    '💎 <b>DEPOSIT TON</b>',
    '',
    `Send TON to your custodial address:`,
    '',
    `<code>${wallet.address}</code>`,
    '',
    '⚠️ <i>Only send native TON to this address.</i>',
    '',
    '⏱ Deposits are credited automatically in ~3s.',
  ].join('\n');

  await render(userId, chatId, caption, keyboards.depositTonScreen(wallet.address));
}

async function showDepositAtf(userId: number, chatId: number): Promise<void> {
  const wallet = await walletService.getWallet(userId);
  if (!wallet) {
    await toast(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('deposit'));
    return;
  }

  const caption = [
    '🪙 <b>DEPOSIT ATF</b>',
    '',
    `Send ATF Jetton to:`,
    '',
    `<code>${wallet.address}</code>`,
    '',
    `Token: <b>ATF</b>`,
    '⚠️ <i>Only send the official ATF Jetton.</i>',
    '',
    '⏱ Deposits are credited automatically in ~3s.',
  ].join('\n');

  await render(userId, chatId, caption, keyboards.depositAtfScreen());
}

async function checkDepositStatus(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  const wallet = await walletService.getWallet(userId);
  if (!wallet?.address) {
    await toast(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('deposit'));
    return;
  }

  await render(userId, chatId, `🔄 <b>Checking ${asset} Deposits…</b>\n\nScanning blockchain 🔍`, {
    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `deposit_${asset.toLowerCase()}` }]],
  });

  try {
    // Force balance refresh
    const onChain = await walletService.getBalance(wallet.address);
    const balance = asset === 'TON'
      ? Precision.fromBaseUnits(onChain.ton, TON_DECIMALS)
      : Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS);

    await toast(
      userId,
      chatId,
      `✅ <b>${asset} Balance Updated</b>\n\nCurrent: <code>${Precision.formatDisplay(balance)} ${asset}</code>`,
      keyboards.backKeyboard('deposit')
    );
  } catch (error: any) {
    await toast(userId, chatId, `❌ Check failed: ${error.message}`, keyboards.backKeyboard('deposit'));
  }
}

// ─── WITHDRAWAL FLOW ─────────────────────────────────────────────────────────
async function showWithdrawMenu(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) { user.lastAction = 'withdraw'; await user.save(); }

  const caption = [
    '💸 <b>WITHDRAW</b>',
    '',
    'Select asset to withdraw:',
    '',
    '<i>Double-check your destination address!</i>',
  ].join('\n');

  await render(userId, chatId, caption, keyboards.withdrawAssetKeyboard());
}

async function startWithdrawal(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.state = `withdraw_address_${asset}`;
  user.stateData = {};
  await user.save();

  const caption = [
    `💸 <b>WITHDRAW ${asset}</b>`,
    '',
    'Enter the destination TON address.',
    '',
    '<i>Example: EQD... or UQD...</i>',
  ].join('\n');

  await render(userId, chatId, caption, keyboards.cancelKeyboard('withdraw'));
}

async function handleWithdrawAddress(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('withdraw_address_')) return;

  const asset = user.state.replace('withdraw_address_', '') as 'TON' | 'ATF';

  if (!isValidTonAddress(text)) {
    await toast(userId, chatId, '❌ Invalid TON address. Try again.', keyboards.cancelKeyboard('withdraw'));
    return;
  }

  user.state = `withdraw_amount_${asset}`;
  user.stateData = { address: text };
  await user.save();

  const caption = [
    `💸 <b>WITHDRAW ${asset}</b>`,
    '',
    `Destination: <code>${formatAddressShort(text)}</code>`,
    '',
    `Enter ${asset} amount:`,
  ].join('\n');

  await render(userId, chatId, caption, keyboards.cancelKeyboard('withdraw'));
}

async function handleWithdrawAmount(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('withdraw_amount_')) return;

  const asset = user.state.replace('withdraw_amount_', '') as 'TON' | 'ATF';

  if (!isValidAmount(text)) {
    await toast(userId, chatId, '❌ Invalid amount.', keyboards.cancelKeyboard('withdraw'));
    return;
  }

  try {
    const prep = await withdrawalService.prepareWithdrawal({
      userId,
      asset,
      amount: text,
      toAddress: user.stateData.address,
    });

    user.state = `withdraw_confirm_${asset}`;
    user.stateData = { ...user.stateData, amount: text, prep };
    await user.save();

    const caption = [
      '💸 <b>CONFIRM WITHDRAWAL</b>',
      '',
      `<b>Asset:</b>      ${asset}`,
      `<b>To:</b>         <code>${formatAddressShort(prep.toAddress)}</code>`,
      `<b>Amount:</b>     ${Precision.formatDisplay(prep.amount)} ${asset}`,
      `<b>Network Fee:</b> ≈ ${prep.networkCost} TON`,
      `<b>Receive:</b>    ${Precision.formatDisplay(prep.receiveAmount)} ${asset}`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.confirmWithdrawalKeyboard());
  } catch (error: any) {
    await toast(userId, chatId, `❌ ${error.message}`, keyboards.cancelKeyboard('withdraw'));
  }
}

async function executeWithdrawal(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('withdraw_confirm_')) {
    await showMainMenu(userId, chatId);
    return;
  }

  const asset = user.state.replace('withdraw_confirm_', '') as 'TON' | 'ATF';
  const { address, amount } = user.stateData;

  await render(userId, chatId, '⏳ <b>Broadcasting Withdrawal…</b>\n\nPlease wait ⛓️', { inline_keyboard: [] });

  try {
    const txId = await withdrawalService.executeWithdrawal({
      userId,
      asset,
      amount,
      toAddress: address,
    });

    const txRecord = await Transaction.findById(txId);
    const txHash = txRecord?.txHash || '';
    const link = explorerLink(txHash);

    const caption = [
      '✅ <b>Withdrawal Sent</b>',
      '',
      `<b>Amount:</b>  ${amount} ${asset}`,
      `<b>Speed:</b>   ~3s`,
      `<b>Asset:</b>   ${asset}`,
      link ? `🔗 <a href="${link}">View on Explorer</a>` : '',
      '',
      '<i>Track status in History 📊</i>',
    ].filter(Boolean).join('\n');

    await clearState(userId);
    await render(userId, chatId, caption, keyboards.backKeyboard('back_main'));
  } catch (error: any) {
    await toast(userId, chatId, `❌ <b>Withdrawal Failed</b>\n\n${error.message}`, keyboards.cancelKeyboard('withdraw'));
  }
      }
                 // ─── ACCOUNT / DASHBOARD ─────────────────────────────────────────────────────
async function showAccount(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.lastAction = 'account';
  await user.save();

  const wallet = await walletService.getWallet(userId);

  let tonBalance = '0';
  let atfBalance = '0';

  if (wallet?.address) {
    try {
      const onChain = await walletService.getBalance(wallet.address);
      tonBalance = Precision.fromBaseUnits(onChain.ton, TON_DECIMALS);
      atfBalance = Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS);
    } catch {
      /* ignore */
    }
  }

  const [tonPrice, atfPrice, ngnRate] = await Promise.all([
    priceService.getTonPriceUsd().catch(() => null),
    priceService.getAtfPriceUsd().catch(() => null),
    priceService.getUsdNgnRate().catch(() => null),
  ]);

  const tonUsd = tonPrice ? priceService.convertCryptoToUsd(tonBalance, tonPrice.price, TON_DECIMALS) : null;
  const atfUsd = atfPrice ? priceService.convertCryptoToUsd(atfBalance, atfPrice.price, ATF_DECIMALS) : null;
  const totalUsd = (parseFloat(tonUsd || '0') + parseFloat(atfUsd || '0')).toFixed(2);
  const totalNgn = ngnRate ? priceService.convertUsdToNgn(totalUsd, ngnRate.price) : null;

  const caption = [
    '👤 <b>MY DASHBOARD</b>',
    '',
    `💎 TON      <code>${Precision.formatDisplay(tonBalance)}</code>`,
    tonUsd ? `   <i>≈ $${tonUsd}</i>` : '',
    '',
    `🪙 ATF      <code>${Precision.formatDisplay(atfBalance)}</code>`,
    atfUsd ? `   <i>≈ $${atfUsd}</i>` : '',
    ngnRate && atfUsd ? `   <i>≈ ₦${priceService.convertUsdToNgn(atfUsd, ngnRate.price)}</i>` : '',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━',
    totalUsd !== '0.00' ? `💼 Total  <b>$${totalUsd}</b> ${totalNgn ? `· ₦${totalNgn}` : ''}` : '',
    '',
    atfPrice ? `📈 ATF <code>$${atfPrice.price.toFixed(6)}</code>` : '',
    '',
    wallet ? `🔑 Wallet: <code>${formatAddressShort(wallet.address)}</code>` : '',
    wallet?.isImported ? '✅ <i>Backed up</i>' : '⚠️ <i>Not backed up — Export below</i>',
  ].filter(Boolean).join('\n');

  await render(userId, chatId, caption, keyboards.accountKeyboard());
}

async function showExportWarning(userId: number, chatId: number): Promise<void> {
  const caption = [
    '⚠️ <b>SECURITY WARNING</b>',
    '',
    'Your recovery phrase grants <b>full control</b> over this wallet.',
    'Never share it. ATFSwap support will <b>never</b> ask for it.',
    '',
    'Tap <b>Continue</b> to reveal your phrase.',
  ].join('\n');

  await render(userId, chatId, caption, keyboards.exportWarningKeyboard());
}

async function exportWallet(userId: number, chatId: number): Promise<void> {
  try {
    const wallet = await walletService.getWallet(userId);
    if (!wallet) {
      await toast(userId, chatId, '❌ No wallet found.', keyboards.backKeyboard('account'));
      return;
    }

    const { decrypt } = await import('../utils/encryption');
    const phrase = decrypt(wallet.encryptedMnemonic, wallet.iv, wallet.tag);

    const caption = [
      '🔐 <b>WALLET BACKUP</b>',
      '',
      `<code>${phrase}</code>`,
      '',
      '⚠️ <i>Delete this message immediately after saving offline.</i>',
    ].join('\n');

    await toast(userId, chatId, caption, keyboards.backKeyboard('account'));

    await AdminAction.create({
      adminId: userId,
      action: 'WALLET_EXPORTED',
      target: userId.toString(),
      result: 'success',
    });
  } catch (error: any) {
    await toast(userId, chatId, `❌ Export failed: ${error.message}`, keyboards.backKeyboard('account'));
  }
}

// ─── IMPORT WALLET ───────────────────────────────────────────────────────────
async function startImportWallet(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.state = 'import_mnemonic_input';
  await user.save();

  const caption = [
    '🔐 <b>IMPORT WALLET</b>',
    '',
    'Paste your 24-word recovery phrase below.',
    '',
    '<i>Your current wallet will be replaced.</i>',
  ].join('\n');

  await render(userId, chatId, caption, keyboards.cancelKeyboard('account'));
}

async function handleImportMnemonic(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || user.state !== 'import_mnemonic_input') return;

  const words = text.trim().split(/\s+/);
  if (words.length !== 24) {
    await toast(userId, chatId, '❌ Invalid phrase. Must be exactly 24 words.', keyboards.cancelKeyboard('account'));
    return;
  }

  try {
    await walletService.importWallet(userId, text.trim());
    await clearState(userId);
    await toast(userId, chatId, '✅ <b>Wallet Imported</b>\n\nYour balances have been linked.', keyboards.backKeyboard('account'));
  } catch (error: any) {
    await toast(userId, chatId, `❌ Import failed: ${error.message}`, keyboards.cancelKeyboard('account'));
  }
}

// ─── HISTORY ─────────────────────────────────────────────────────────────────
async function showHistory(userId: number, chatId: number, page: number): Promise<void> {
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

  const lines = display.map(tx => {
    const icon = tx.type === 'deposit' ? '🟢' : tx.type === 'withdrawal' ? '🔴' : '🔄';
    const amt = Precision.fromBaseUnits(BigInt(tx.amount), tx.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
    const shortHash = tx.txHash && !tx.txHash.includes('-')
      ? `<a href="${explorerLink(tx.txHash)}">${tx.txHash.slice(0, 6)}…${tx.txHash.slice(-4)}</a>`
      : '…';
    return `${icon} <b>${tx.type.toUpperCase()}</b>  <code>${Precision.formatDisplay(amt)} ${tx.asset}</code>\n   Status: ${tx.status}  ·  ${shortHash}`;
  });

  const caption = [
    '📊 <b>TRANSACTION HISTORY</b>',
    '',
    ...(lines.length ? lines : ['<i>No transactions yet.</i>']),
    '',
    `Page ${page}`,
  ].filter(Boolean).join('\n');

  await render(userId, chatId, caption, keyboards.historyPaginationKeyboard(page, hasMore));
}

// ─── PRICES ────────────────────────────────────────────────────────────────────
async function showPrices(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) { user.lastAction = 'prices'; await user.save(); }

  const [atfPrice, tonPrice, ngnRate] = await Promise.all([
    priceService.getAtfPriceUsd().catch(() => null),
    priceService.getTonPriceUsd().catch(() => null),
    priceService.getUsdNgnRate().catch(() => null),
  ]);

  const caption = [
    '💵 <b>LIVE MARKET PRICES</b>',
    '',
    atfPrice
      ? `🪙 <b>ATF</b>    $${atfPrice.price.toFixed(6)}\n${ngnRate ? `   🇳🇬 ₦${(atfPrice.price * ngnRate.price).toFixed(2)}` : ''}`
      : '⚠️ ATF price unavailable',
    '',
    tonPrice
      ? `💎 <b>TON</b>    $${tonPrice.price.toFixed(2)}\n${ngnRate ? `   🇳🇬 ₦${(tonPrice.price * ngnRate.price).toFixed(2)}` : ''}`
      : '⚠️ TON price unavailable',
    '',
    ngnRate
      ? `💱 <b>USD/NGN</b>    ₦${ngnRate.price.toFixed(2)}`
      : '⚠️ NGN rate unavailable',
  ].filter(Boolean).join('\n');

  await render(userId, chatId, caption, keyboards.pricesKeyboard());
}

// ─── HELP ──────────────────────────────────────────────────────────────────────
async function showHelp(userId: number, chatId: number): Promise<void> {
  const caption = [
    'ℹ️ <b>ATF SWAP HELP</b>',
    '',
    '<b>What is this?</b>',
    'A custodial TON ↔ ATF exchange inside Telegram.',
    '',
    '<b>Quick Start</b>',
    '1. Deposit TON or ATF 💰',
    '2. Swap instantly 🔄',
    '3. Withdraw to any TON address 💸',
    '',
    '<b>Commands</b>',
    '/start — Open menu',
    '/help  — Show this message',
    '',
    '<b>Fees</b>',
    `• Swap: ${config.platformSwapFeePercent}% platform fee`,
    '• Withdrawal: network gas only',
    '',
    '<b>Support</b>',
    'Contact admin if a transaction stalls for >5 minutes.',
  ].join('\n');

  await render(userId, chatId, caption, keyboards.helpKeyboard());
}

// ─── SETTINGS ──────────────────────────────────────────────────────────────────
async function showSettings(userId: number, chatId: number): Promise<void> {
  const caption = [
    '⚙️ <b>SETTINGS</b>',
    '',
    'Manage your preferences:',
  ].join('\n');

  await render(userId, chatId, caption, keyboards.settingsKeyboard());
}

// ─── REFERRAL ──────────────────────────────────────────────────────────────────
async function showReferral(userId: number, chatId: number): Promise<void> {
  const count = await Referral.countDocuments({ referrerId: userId });
  const link = `https://t.me/${config.botUsername}?start=${userId}`;

  const caption = [
    '🎁 <b>REFERRAL PROGRAM</b>',
    '',
    `Invite friends and earn rewards!`,
    '',
    `👥 Referred: <b>${count}</b> user${count !== 1 ? 's' : ''}`,
    '',
    `Your link:`,
    `<code>${link}</code>`,
    '',
    '<i>Share your link. When they trade, you earn.</i>',
  ].join('\n');

  await render(userId, chatId, caption, keyboards.backKeyboard('back_main'));
}
// ─── TEXT INPUT HANDLER ────────────────────────────────────────────────────────
export async function handleText(msg: TelegramBot.Message): Promise<void> {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (!userId) return;

  await delUserMsg(chatId, msg.message_id);

  const user = await getOrCreateUser(msg);

  if (user.state.startsWith('swap_input_')) {
    await handleSwapInput(userId, chatId, text);
    return;
  }

  if (user.state.startsWith('withdraw_address_')) {
    await handleWithdrawAddress(userId, chatId, text);
    return;
  }

  if (user.state.startsWith('withdraw_amount_')) {
    await handleWithdrawAmount(userId, chatId, text);
    return;
  }

  if (user.state === 'import_mnemonic_input') {
    await handleImportMnemonic(userId, chatId, text);
    return;
  }

  if (user.state === 'admin_give_input') {
    await handleGiveAdmin(userId, chatId, text);
    return;
  }

  if (user.state === 'admin_remove_input') {
    await handleRemoveAdmin(userId, chatId, text);
    return;
  }

  // Fallback
  await showMainMenu(userId, chatId);
}

// ─── ADMIN PANEL ─────────────────────────────────────────────────────────────
async function showAdminPanel(userId: number, chatId: number): Promise<void> {
  try {
    const user = await requireAdmin(userId);
    user.lastAction = 'admin_panel';
    await user.save();

    const caption = [
      '⚙️ <b>ADMIN PANEL</b>',
      '',
      `Welcome, ${user.firstName || 'Admin'} 👋`,
      '',
      'Select a section:',
    ].join('\n');

    await render(userId, chatId, caption, keyboards.adminPanelKeyboard(user.isSuperAdmin));
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showAdminManagement(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    await render(userId, chatId, '👑 <b>ADMIN MANAGEMENT</b>', keyboards.adminManagementKeyboard());
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

async function startGiveAdmin(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    user.state = 'admin_give_input';
    await user.save();

    await render(userId, chatId, '👑 <b>GIVE ADMIN</b>\n\nEnter Telegram ID:', keyboards.cancelKeyboard('admin_management'));
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

async function handleGiveAdmin(userId: number, chatId: number, text: string): Promise<void> {
  try {
    await requireSuperAdmin(userId);
  } catch {
    await showMainMenu(userId, chatId);
    return;
  }

  if (!isValidTelegramId(text)) {
    await toast(userId, chatId, '❌ Invalid Telegram ID.', keyboards.cancelKeyboard('admin_management'));
    return;
  }

  const targetId = parseInt(text, 10);
  const target = await User.findOne({ telegramId: targetId });

  if (!target) {
    await toast(userId, chatId, '❌ User not found. They must start the bot first.', keyboards.cancelKeyboard('admin_management'));
    return;
  }

  if (target.isAdmin) {
    await toast(userId, chatId, 'ℹ️ Already an admin.', keyboards.cancelKeyboard('admin_management'));
    return;
  }

  target.isAdmin = true;
  await target.save();

  await AdminAction.create({
    adminId: userId,
    action: 'ADMIN_CREATED',
    target: targetId.toString(),
    oldValue: 'false',
    newValue: 'true',
    result: 'success',
  });

  await clearState(userId);
  await toast(userId, chatId, `✅ <b>Admin Granted</b>\n\n<code>${targetId}</code> is now an administrator.`, keyboards.backKeyboard('admin_management'));
}

async function startRemoveAdmin(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    user.state = 'admin_remove_input';
    await user.save();

    await render(userId, chatId, '👑 <b>REMOVE ADMIN</b>\n\nEnter Telegram ID:', keyboards.cancelKeyboard('admin_management'));
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

async function handleRemoveAdmin(userId: number, chatId: number, text: string): Promise<void> {
  try {
    await requireSuperAdmin(userId);
  } catch {
    await showMainMenu(userId, chatId);
    return;
  }

  if (!isValidTelegramId(text)) {
    await toast(userId, chatId, '❌ Invalid Telegram ID.', keyboards.cancelKeyboard('admin_management'));
    return;
  }

  const targetId = parseInt(text, 10);

  if (targetId === Number(config.superAdminTelegramId)) {
    await toast(userId, chatId, '❌ Cannot remove Super Admin.', keyboards.cancelKeyboard('admin_management'));
    return;
  }

  const target = await User.findOne({ telegramId: targetId });
  if (!target || !target.isAdmin) {
    await toast(userId, chatId, '❌ User is not an admin.', keyboards.cancelKeyboard('admin_management'));
    return;
  }

  target.isAdmin = false;
  await target.save();

  await AdminAction.create({
    adminId: userId,
    action: 'ADMIN_REMOVED',
    target: targetId.toString(),
    oldValue: 'true',
    newValue: 'false',
    result: 'success',
  });

  await clearState(userId);
  await toast(userId, chatId, `✅ <b>Admin Removed</b>\n\n<code>${targetId}</code> is no longer an administrator.`, keyboards.backKeyboard('admin_management'));
}

async function showAdminList(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    const admins = await User.find({ isAdmin: true }).select('telegramId firstName username');
    const lines = admins.map(a => `• <code>${a.telegramId}</code> ${a.firstName || ''} ${a.username ? `(@${a.username})` : ''}`);

    await render(userId, chatId, ['👥 <b>ADMIN LIST</b>', '', ...lines].join('\n'), keyboards.backKeyboard('admin_management'));
  } catch {
    await showAdminPanel(userId, chatId);
  }
}
