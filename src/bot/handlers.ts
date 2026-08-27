import TelegramBot from 'node-telegram-bot-api';
import { User } from '../models/User';
import { Wallet } from '../models/Wallet';
import { Transaction } from '../models/Transaction';
import { AdminAction } from '../models/AdminAction';
import { TelegramMessageManager } from '../utils/telegram-message-manager';
import { SwapService } from '../services/swap-service';
import { WithdrawalService } from '../services/withdrawal-service';
import { WalletService } from '../services/wallet-service';
import { PriceService } from '../services/price-service';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS, ATF_DECIMALS } from '../config';
import { isValidTonAddress, isValidAmount, isValidTelegramId, formatAddressShort } from '../utils/validation';
import * as keyboards from './keyboards';

const messageManager = new TelegramMessageManager({} as TelegramBot); // Will be injected
const swapService = new SwapService();
const withdrawalService = new WithdrawalService();
const walletService = new WalletService();
const priceService = PriceService.getInstance();

let botInstance: TelegramBot;

export function setBot(bot: TelegramBot) {
  botInstance = bot;
  (messageManager as any).bot = bot;
}

async function getOrCreateUser(msg: TelegramBot.Message): Promise<any> {
  const telegramId = msg.from?.id;
  if (!telegramId) throw new Error('No telegram ID');

  let user = await User.findOne({ telegramId });
  if (!user) {
    user = await User.create({
      telegramId,
      username: msg.from?.username,
      firstName: msg.from?.first_name,
      lastName: msg.from?.last_name,
      isSuperAdmin: telegramId === config.superAdminTelegramId,
    });

    // Create custodial wallet for new user
    await walletService.createWallet(telegramId);
  }

  // Auto-promote super admin if env changed
  if (telegramId === config.superAdminTelegramId && !user.isSuperAdmin) {
    user.isSuperAdmin = true;
    user.isAdmin = true;
    await user.save();
  }

  return user;
}

async function requireAdmin(userId: number): Promise<any> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || (!user.isAdmin && !user.isSuperAdmin)) {
    throw new Error('Unauthorized');
  }
  return user;
}

async function requireSuperAdmin(userId: number): Promise<any> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.isSuperAdmin) {
    throw new Error('Super Admin only');
  }
  return user;
}

// ─── MAIN MENU ───────────────────────────────────────────────────────────────

export async function showMainMenu(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const tonBalance = Precision.fromBaseUnits(BigInt(user.tonBalance), TON_DECIMALS);
  const atfBalance = Precision.fromBaseUnits(BigInt(user.atfBalance), ATF_DECIMALS);

  const [atfPrice, tonPrice] = await Promise.all([
    priceService.getAtfPriceUsd(),
    priceService.getTonPriceUsd(),
  ]);

  const atfUsd = atfPrice ? priceService.convertCryptoToUsd(atfBalance, atfPrice.price, ATF_DECIMALS) : '—';
  const tonUsd = tonPrice ? priceService.convertCryptoToUsd(tonBalance, tonPrice.price, TON_DECIMALS) : '—';

  const caption = [
    '🏠 <b>ATFSWAP</b>',
    '',
    `💎 <b>TON</b>`,
    `${Precision.formatDisplay(tonBalance)} TON`,
    atfPrice ? `≈ $${tonUsd}` : '',
    '',
    `🪙 <b>ATF</b>`,
    `${Precision.formatDisplay(atfBalance)} ATF`,
    atfPrice ? `≈ $${atfUsd}` : '',
    '',
    '━━━━━━━━━━━━',
    atfPrice ? `📈 ATF <code>$${atfPrice.price.toFixed(6)}</code>` : '',
    '',
    'Choose an action:',
  ].filter(Boolean).join('\n');

  await messageManager.showScreen(
    userId,
    chatId,
    caption,
    keyboards.mainMenuKeyboard(user?.isAdmin || false)
  );
}

// ─── START COMMAND ─────────────────────────────────────────────────────────────

export async function handleStart(msg: TelegramBot.Message): Promise<void> {
  const user = await getOrCreateUser(msg);
  await showMainMenu(user.telegramId, msg.chat.id);
}

// ─── CALLBACK QUERIES ──────────────────────────────────────────────────────────

export async function handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
  const userId = query.from.id;
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const data = query.data || '';

  if (!chatId) return;

  // Answer callback to remove loading state
  try {
    await botInstance.answerCallbackQuery(query.id);
  } catch {
    // ignore
  }

  const user = await getOrCreateUser({
    from: query.from,
    chat: query.message?.chat,
  } as TelegramBot.Message);

  // Route by callback data
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
    user.state = 'idle';
    user.stateData = {};
    await user.save();
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
    user.state = 'idle';
    user.stateData = {};
    await user.save();
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

  // ─── ADMIN CALLBACKS ───────────────────────────────────────────────────────

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
    const targetId = parseInt(parts[2], 10);
    const action = parts[3]; // freeze or unfreeze
    await toggleFreeze(userId, chatId, targetId, action);
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
}

// ─── SWAP FLOW ─────────────────────────────────────────────────────────────────

async function showSwapPair(userId: number, chatId: number): Promise<void> {
  const caption = [
    '🔄 <b>SWAP</b>',
    '',
    'Choose a pair:',
  ].join('\n');

  await messageManager.showScreen(userId, chatId, caption, keyboards.swapPairKeyboard());
}

async function startSwapInput(userId: number, chatId: number, direction: 'ton_to_atf' | 'atf_to_ton'): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const balanceKey = direction === 'ton_to_atf' ? 'tonBalance' : 'atfBalance';
  const balance = Precision.fromBaseUnits(BigInt(user[balanceKey]), direction === 'ton_to_atf' ? TON_DECIMALS : ATF_DECIMALS);

  const caption = [
    direction === 'ton_to_atf' ? '💎 <b>TON → 🪙 ATF</b>' : '🪙 <b>ATF → 💎 TON</b>',
    '',
    `Enter ${direction === 'ton_to_atf' ? 'TON' : 'ATF'} amount.`,
    '',
    direction === 'ton_to_atf' ? `Minimum: <b>${config.minSwapTon} TON</b>` : '',
    `Your balance: <b>${Precision.formatDisplay(balance)} ${direction === 'ton_to_atf' ? 'TON' : 'ATF'}</b>`,
  ].filter(Boolean).join('\n');

  user.state = `swap_input_${direction}`;
  user.stateData = {};
  await user.save();

  await messageManager.showScreen(userId, chatId, caption, keyboards.backKeyboard('swap'));
}

async function handleSwapInput(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const direction = user.state.replace('swap_input_', '') as 'ton_to_atf' | 'atf_to_ton';

  if (!isValidAmount(text)) {
    await messageManager.showText(
      userId,
      chatId,
      '❌ <b>Invalid amount</b>\n\nPlease enter a valid positive number.',
      keyboards.backKeyboard('swap')
    );
    return;
  }

  try {
    const confirmation = await swapService.prepareSwap({
      userId,
      direction,
      amount: text,
    });

    // Store confirmation in user state
    user.state = `swap_confirm_${direction}`;
    user.stateData = { confirmation, inputAmount: text };
    await user.save();

    const [atfPrice, tonPrice] = await Promise.all([
      priceService.getAtfPriceUsd(),
      priceService.getTonPriceUsd(),
    ]);

    // Calculate USD value of expected output
    let receiveUsd: string | null = null;
    if (direction === 'ton_to_atf' && atfPrice) {
      receiveUsd = priceService.convertCryptoToUsd(
        confirmation.expectedOutput,
        atfPrice.price,
        ATF_DECIMALS
      );
    } else if (direction === 'atf_to_ton' && tonPrice) {
      receiveUsd = priceService.convertCryptoToUsd(
        confirmation.expectedOutput,
        tonPrice.price,
        TON_DECIMALS
      );
    }

    let caption: string;

    if (direction === 'ton_to_atf') {
      // ─── TON → ATF: Full transparent breakdown ───────────────────────────
      caption = [
        '🔄 <b>SWAP QUOTE</b>',
        '',
        '<b>You Pay:</b>',
        `${Precision.formatDisplay(confirmation.inputAmount)} TON`,
        '',
        '<b>Platform Fee:</b>',
        `${Precision.formatDisplay(confirmation.platformFee)} TON (${config.platformSwapFeePercent}%)`,
        '',
        '<b>Swap Amount:</b>',
        `${Precision.formatDisplay(confirmation.netSwapAmount)} TON`,
        '',
        '<b>Estimated Receive:</b>',
        `${Precision.formatDisplay(confirmation.expectedOutput)} ATF`,
        receiveUsd ? `≈ $${receiveUsd}` : '',
        '',
        '<b>Minimum Received:</b>',
        `${Precision.formatDisplay(confirmation.minOutput)} ATF`,
        '',
        '<b>Network/DEX Cost:</b>',
        `≈ ${Precision.formatDisplay(confirmation.dexCosts)} TON`,
        '',
        `<b>Rate:</b> ${confirmation.rate}`,
        '',
        `Quote expires in <b>${Math.max(0, Math.floor((confirmation.expiresAt.getTime() - Date.now()) / 1000))}s</b>`,
      ].filter(Boolean).join('\n');
    } else {
      // ─── ATF → TON: SEAMLESS — no gas/network costs shown to user ───────
      // User only sees: input ATF → fee (1%) → net swap → receive TON
      // The gas TON cost is silently handled by the platform admin wallet
      caption = [
        '🔄 <b>SWAP QUOTE</b>',
        '',
        '<b>You Pay:</b>',
        `${Precision.formatDisplay(confirmation.inputAmount)} ATF`,
        '',
        '<b>Platform Fee:</b>',
        `${Precision.formatDisplay(confirmation.platformFee)} ATF (${config.platformSwapFeePercent}%)`,
        '',
        '<b>Swap Amount:</b>',
        `${Precision.formatDisplay(confirmation.netSwapAmount)} ATF`,
        '',
        '<b>Estimated Receive:</b>',
        `${Precision.formatDisplay(confirmation.expectedOutput)} TON`,
        receiveUsd ? `≈ $${receiveUsd}` : '',
        '',
        '<b>Minimum Received:</b>',
        `${Precision.formatDisplay(confirmation.minOutput)} TON`,
        '',
        `<b>Rate:</b> ${confirmation.rate}`,
        '',
        `Quote expires in <b>${Math.max(0, Math.floor((confirmation.expiresAt.getTime() - Date.now()) / 1000))}s</b>`,
      ].filter(Boolean).join('\n');
    }

    await messageManager.showScreen(userId, chatId, caption, keyboards.confirmSwapKeyboard());
  } catch (error: any) {
    const isMinError = error.message?.includes('Minimum swap amount');
    const isGasError = error.message?.includes('gas treasury temporarily low');
    await messageManager.showText(
      userId,
      chatId,
      isMinError
        ? `❌ <b>INVALID AMOUNT</b>\n\nMinimum swap amount is:\n<b>${config.minSwapTon} TON</b>\n\nPlease enter a larger amount.`
        : isGasError
        ? `⏳ <b>Platform Gas Treasury Low</b>\n\n${error.message}\n\nPlease try again shortly.`
        : `❌ <b>Error</b>\n\n${error.message}`,
      keyboards.backKeyboard('swap')
    );
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

  if (!confirmation) {
    await messageManager.showText(userId, chatId, '❌ Quote expired. Please start again.', keyboards.backKeyboard('swap'));
    return;
  }

  // Check quote expiry
  if (new Date() > new Date(confirmation.expiresAt)) {
    user.state = 'idle';
    user.stateData = {};
    await user.save();
    await messageManager.showText(userId, chatId, '❌ Quote expired. Requesting new quote...', keyboards.backKeyboard('swap'));
    return;
  }

  try {
    await messageManager.showText(
      userId,
      chatId,
      '⏳ <b>Processing Swap...</b>\n\nPlease wait while we execute your swap.',
      { inline_keyboard: [] }
    );

    const txId = await swapService.executeSwap(userId, confirmation, direction);

    user.state = 'idle';
    user.stateData = {};
    await user.save();

    await messageManager.showText(
      userId,
      chatId,
      `✅ <b>Swap Submitted</b>\n\nTransaction ID: <code>${txId}</code>\n\nYou will be notified once confirmed.`,
      keyboards.backKeyboard('back_main')
    );
  } catch (error: any) {
    await messageManager.showText(
      userId,
      chatId,
      `❌ <b>Swap Failed</b>\n\n${error.message}`,
      keyboards.backKeyboard('swap')
    );
  }
}

// ─── DEPOSIT FLOW ──────────────────────────────────────────────────────────────

async function showDepositMenu(userId: number, chatId: number): Promise<void> {
  const caption = [
    '💰 <b>DEPOSIT</b>',
    '',
    'Choose asset:',
  ].join('\n');

  await messageManager.showScreen(userId, chatId, caption, keyboards.depositKeyboard());
}

async function showDepositTon(userId: number, chatId: number): Promise<void> {
  const wallet = await walletService.getWallet(userId);
  if (!wallet) {
    await messageManager.showText(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('deposit'));
    return;
  }

  const caption = [
    '💎 <b>DEPOSIT TON</b>',
    '',
    'Send TON to:',
    `<code>${wallet.address}</code>`,
    '',
    'Minimum: <b>None</b>',
    '',
    '⚠️ <i>Only send TON to this address.</i>',
  ].join('\n');

  await messageManager.showScreen(userId, chatId, caption, keyboards.depositTonScreen(wallet.address));
}

async function showDepositAtf(userId: number, chatId: number): Promise<void> {
  const wallet = await walletService.getWallet(userId);
  if (!wallet) {
    await messageManager.showText(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('deposit'));
    return;
  }

  const caption = [
    '🪙 <b>DEPOSIT ATF</b>',
    '',
    'Send ATF to:',
    `<code>${wallet.address}</code>`,
    '',
    `Token: <b>ATF</b>`,
    'Minimum: <b>None</b>',
    '',
    '⚠️ <i>Only send the configured ATF Jetton.</i>',
  ].join('\n');

  await messageManager.showScreen(userId, chatId, caption, keyboards.depositAtfScreen());
}

// ─── WITHDRAWAL FLOW ───────────────────────────────────────────────────────────

async function showWithdrawMenu(userId: number, chatId: number): Promise<void> {
  const caption = [
    '💸 <b>WITHDRAW</b>',
    '',
    'Choose asset:',
  ].join('\n');

  await messageManager.showScreen(userId, chatId, caption, keyboards.withdrawAssetKeyboard());
}

async function startWithdrawal(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.state = `withdraw_address_${asset}`;
  user.stateData = {};
  await user.save();

  const caption = [
    `💎 <b>WITHDRAW ${asset}</b>`,
    '',
    'Send the destination TON address.',
  ].join('\n');

  await messageManager.showScreen(userId, chatId, caption, keyboards.cancelKeyboard('withdraw'));
}

async function handleWithdrawAddress(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('withdraw_address_')) return;

  const asset = user.state.replace('withdraw_address_', '') as 'TON' | 'ATF';

  if (!isValidTonAddress(text)) {
    await messageManager.showText(userId, chatId, '❌ Invalid TON address. Please try again.', keyboards.cancelKeyboard('withdraw'));
    return;
  }

  user.state = `withdraw_amount_${asset}`;
  user.stateData = { address: text };
  await user.save();

  const caption = [
    `💎 <b>WITHDRAW ${asset}</b>`,
    '',
    `Destination: <code>${formatAddressShort(text)}</code>`,
    '',
    `Enter ${asset} amount.`,
  ].join('\n');

  await messageManager.showScreen(userId, chatId, caption, keyboards.cancelKeyboard('withdraw'));
}

async function handleWithdrawAmount(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('withdraw_amount_')) return;

  const asset = user.state.replace('withdraw_amount_', '') as 'TON' | 'ATF';

  if (!isValidAmount(text)) {
    await messageManager.showText(userId, chatId, '❌ Invalid amount. Please enter a valid number.', keyboards.cancelKeyboard('withdraw'));
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
      `<b>Asset:</b> ${asset}`,
      `<b>Destination:</b> <code>${formatAddressShort(prep.toAddress)}</code>`,
      `<b>Amount:</b> ${Precision.formatDisplay(prep
