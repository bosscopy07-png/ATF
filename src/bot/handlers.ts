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
import { config, TON_DECIMALS, AFT_DECIMALS } from '../config';
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
  const aftBalance = Precision.fromBaseUnits(BigInt(user.aftBalance), AFT_DECIMALS);

  const [aftPrice, tonPrice] = await Promise.all([
    priceService.getAftPriceUsd(),
    priceService.getTonPriceUsd(),
  ]);

  const aftUsd = aftPrice ? priceService.convertCryptoToUsd(aftBalance, aftPrice.price, AFT_DECIMALS) : '—';
  const tonUsd = tonPrice ? priceService.convertCryptoToUsd(tonBalance, tonPrice.price, TON_DECIMALS) : '—';

  const caption = [
    '🏠 <b>AFTSWAP</b>',
    '',
    `💎 <b>TON</b>`,
    `${Precision.formatDisplay(tonBalance)} TON`,
    aftPrice ? `≈ $${tonUsd}` : '',
    '',
    `🪙 <b>AFT</b>`,
    `${Precision.formatDisplay(aftBalance)} AFT`,
    aftPrice ? `≈ $${aftUsd}` : '',
    '',
    '━━━━━━━━━━━━',
    aftPrice ? `📈 AFT <code>$${aftPrice.price.toFixed(6)}</code>` : '',
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

  if (data === 'swap_ton_aft') {
    await startSwapInput(userId, chatId, 'ton_to_aft');
    return;
  }

  if (data === 'swap_aft_ton') {
    await startSwapInput(userId, chatId, 'aft_to_ton');
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

  if (data === 'deposit_aft') {
    await showDepositAft(userId, chatId);
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

  if (data === 'withdraw_aft') {
    await startWithdrawal(userId, chatId, 'AFT');
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

async function startSwapInput(userId: number, chatId: number, direction: 'ton_to_aft' | 'aft_to_ton'): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const balanceKey = direction === 'ton_to_aft' ? 'tonBalance' : 'aftBalance';
  const balance = Precision.fromBaseUnits(BigInt(user[balanceKey]), direction === 'ton_to_aft' ? TON_DECIMALS : AFT_DECIMALS);

  const caption = [
    direction === 'ton_to_aft' ? '💎 <b>TON → 🪙 AFT</b>' : '🪙 <b>AFT → 💎 TON</b>',
    '',
    `Enter ${direction === 'ton_to_aft' ? 'TON' : 'AFT'} amount.`,
    '',
    direction === 'ton_to_aft' ? `Minimum: <b>${config.minSwapTon} TON</b>` : '',
    `Your balance: <b>${Precision.formatDisplay(balance)} ${direction === 'ton_to_aft' ? 'TON' : 'AFT'}</b>`,
  ].filter(Boolean).join('\n');

  user.state = `swap_input_${direction}`;
  user.stateData = {};
  await user.save();

  await messageManager.showScreen(userId, chatId, caption, keyboards.backKeyboard('swap'));
}

async function handleSwapInput(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const direction = user.state.replace('swap_input_', '') as 'ton_to_aft' | 'aft_to_ton';

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

    const [aftPrice] = await Promise.all([
      priceService.getAftPriceUsd(),
    ]);

    const receiveUsd = aftPrice && direction === 'ton_to_aft'
      ? priceService.convertCryptoToUsd(confirmation.expectedOutput, aftPrice.price, AFT_DECIMALS)
      : null;

    const caption = [
      '🔄 <b>SWAP QUOTE</b>',
      '',
      '<b>You Pay:</b>',
      `${Precision.formatDisplay(confirmation.inputAmount)} ${direction === 'ton_to_aft' ? 'TON' : 'AFT'}`,
      '',
      '<b>Platform Fee:</b>',
      `${Precision.formatDisplay(confirmation.platformFee)} ${direction === 'ton_to_aft' ? 'TON' : 'AFT'} (${config.platformSwapFeePercent}%)`,
      '',
      '<b>Swap Amount:</b>',
      `${Precision.formatDisplay(confirmation.netSwapAmount)} ${direction === 'ton_to_aft' ? 'TON' : 'AFT'}`,
      '',
      '<b>Estimated Receive:</b>',
      `${Precision.formatDisplay(confirmation.expectedOutput)} ${direction === 'ton_to_aft' ? 'AFT' : 'TON'}`,
      receiveUsd ? `≈ $${receiveUsd}` : '',
      '',
      '<b>Minimum Received:</b>',
      `${Precision.formatDisplay(confirmation.minOutput)} ${direction === 'ton_to_aft' ? 'AFT' : 'TON'}`,
      '',
      '<b>Network/DEX Cost:</b>',
      `≈ ${Precision.formatDisplay(confirmation.dexCosts)} TON`,
      '',
      `<b>Rate:</b> ${confirmation.rate}`,
      '',
      `Quote expires in <b>${Math.max(0, Math.floor((confirmation.expiresAt.getTime() - Date.now()) / 1000))}s</b>`,
    ].filter(Boolean).join('\n');

    await messageManager.showScreen(userId, chatId, caption, keyboards.confirmSwapKeyboard());
  } catch (error: any) {
    const isMinError = error.message?.includes('Minimum swap amount');
    await messageManager.showText(
      userId,
      chatId,
      isMinError
        ? `❌ <b>INVALID AMOUNT</b>\n\nMinimum swap amount is:\n<b>${config.minSwapTon} TON</b>\n\nPlease enter a larger amount.`
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

  const direction = user.state.replace('swap_confirm_', '') as 'ton_to_aft' | 'aft_to_ton';
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

async function showDepositAft(userId: number, chatId: number): Promise<void> {
  const wallet = await walletService.getWallet(userId);
  if (!wallet) {
    await messageManager.showText(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('deposit'));
    return;
  }

  const caption = [
    '🪙 <b>DEPOSIT AFT</b>',
    '',
    'Send AFT to:',
    `<code>${wallet.address}</code>`,
    '',
    `Token: <b>AFT</b>`,
    'Minimum: <b>None</b>',
    '',
    '⚠️ <i>Only send the configured AFT Jetton.</i>',
  ].join('\n');

  await messageManager.showScreen(userId, chatId, caption, keyboards.depositAftScreen());
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

async function startWithdrawal(userId: number, chatId: number, asset: 'TON' | 'AFT'): Promise<void> {
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

  const asset = user.state.replace('withdraw_address_', '') as 'TON' | 'AFT';

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

  const asset = user.state.replace('withdraw_amount_', '') as 'TON' | 'AFT';

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
      `<b>Amount:</b> ${Precision.formatDisplay(prep.amount)} ${asset}`,
      `<b>Network Cost:</b> ≈ ${prep.networkCost} TON`,
      `<b>You Receive:</b> ${Precision.formatDisplay(prep.receiveAmount)} ${asset}`,
    ].join('\n');

    await messageManager.showScreen(userId, chatId, caption, keyboards.confirmWithdrawalKeyboard());
  } catch (error: any) {
    await messageManager.showText(userId, chatId, `❌ ${error.message}`, keyboards.cancelKeyboard('withdraw'));
  }
}

async function executeWithdrawal(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('withdraw_confirm_')) {
    await showMainMenu(userId, chatId);
    return;
  }

  const asset = user.state.replace('withdraw_confirm_', '') as 'TON' | 'AFT';
  const { address, amount } = user.stateData;

  try {
    await messageManager.showText(
      userId,
      chatId,
      '⏳ <b>Processing Withdrawal...</b>',
      { inline_keyboard: [] }
    );

    const txId = await withdrawalService.executeWithdrawal({
      userId,
      asset,
      amount,
      toAddress: address,
    });

    user.state = 'idle';
    user.stateData = {};
    await user.save();

    await messageManager.showText(
      userId,
      chatId,
      `✅ <b>Withdrawal Submitted</b>\n\nTransaction ID: <code>${txId}</code>\n\nYou will be notified once confirmed.`,
      keyboards.backKeyboard('back_main')
    );
  } catch (error: any) {
    await messageManager.showText(
      userId,
      chatId,
      `❌ <b>Withdrawal Failed</b>\n\n${error.message}`,
      keyboards.cancelKeyboard('withdraw')
    );
  }
}

// ─── ACCOUNT / DASHBOARD ───────────────────────────────────────────────────────

async funct
