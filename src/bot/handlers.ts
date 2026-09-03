import TelegramBot from 'node-telegram-bot-api';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { Wallet } from '../models/Wallet';
import { Transaction } from '../models/Transaction';
import { AdminAction } from '../models/AdminAction';
import { Referral } from '../models/Referral';
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

/* ───────────────────────────────────────────────────────────────────────────
   🔧 SERVICE INSTANCES
   ─────────────────────────────────────────────────────────────────────────── */
const swapService = new SwapService();
const withdrawalService = new WithdrawalService();
const walletService = new WalletService();
const priceService = PriceService.getInstance();

let botInstance: TelegramBot;

export function setBot(bot: TelegramBot): void {
  botInstance = bot;
}

/* ───────────────────────────────────────────────────────────────────────────
   🎨 STRICT SINGLE-MESSAGE RENDER ENGINE
   ───────────────────────────────────────────────────────────────────────────
   Policy: exactly ONE bot message per chat.
   • Photo exists  → edit caption + keyboard.
   • Text exists   → delete it, send a photo (one-time migration).
   • Nothing exists→ send a photo.
   Cross-chat alerts (referrals / broadcasts) are the only exception.
   ─────────────────────────────────────────────────────────────────────────── */
async function render(
  userId: number,
  chatId: number,
  text: string,
  keyboard: any,
  opts?: { withImage?: boolean }
): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  const msgId = user?.lastBotMessageId;
  const imageUrl = config.botBrandingImageUrl;

  // Default to photo mode when a branding image is configured.
  const wantPhoto = opts?.withImage !== false && !!imageUrl;
  const wasPhoto = user?.lastMessageWasPhoto ?? false;

  const saveRef = async (sent: TelegramBot.Message, isPhoto: boolean) => {
    if (!user) return;
    user.lastBotMessageId = sent.message_id;
    user.lastMessageWasPhoto = isPhoto;
    await user.save();
  };

  const purgeRef = async () => {
    if (!user) return;
    user.lastBotMessageId = null as any;
    user.lastMessageWasPhoto = false;
    await user.save();
  };

  /* ── Existing message? Try to recycle it ── */
  if (msgId) {
    // Photo → Photo : edit caption
    if (wantPhoto && wasPhoto) {
      try {
        await botInstance.editMessageCaption(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        return;
      } catch (err: any) {
        if (err.message?.includes('message is not modified')) return;
        try { await botInstance.deleteMessage(chatId, msgId); } catch {}
        await purgeRef();
      }
    }

    // Text → Photo : delete text, fall through to send fresh photo
    if (wantPhoto && !wasPhoto) {
      try { await botInstance.deleteMessage(chatId, msgId); } catch {}
      await purgeRef();
    }

    // Photo → Text : delete photo, fall through to send fresh text
    if (!wantPhoto && wasPhoto) {
      try { await botInstance.deleteMessage(chatId, msgId); } catch {}
      await purgeRef();
    }

    // Text → Text : edit text
    if (!wantPhoto && !wasPhoto) {
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
        try { await botInstance.deleteMessage(chatId, msgId); } catch {}
        await purgeRef();
      }
    }
  }

  /* ── No message to edit → send fresh ── */
  if (wantPhoto && imageUrl) {
    const sent = await botInstance.sendPhoto(chatId, imageUrl, {
      caption: text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    await saveRef(sent, true);
  } else {
    const sent = await botInstance.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
    await saveRef(sent, false);
  }
}

/* ── Thin wrapper so every screen uses the same engine ── */
async function toast(userId: number, chatId: number, text: string, keyboard: any): Promise<void> {
  return render(userId, chatId, text, keyboard);
}

async function clearState(userId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.state = 'idle';
    user.stateData = {};
    await user.save();
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   👤 USER LIFECYCLE
   ─────────────────────────────────────────────────────────────────────────── */
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
      walletIds: [],
    });

    const wallet = await walletService.createWallet(telegramId);
    if (wallet) {
      user.walletIds.push(wallet._id);
      user.activeWalletId = wallet._id;
      await user.save();
    }

    const refCode = (msg.text || '').split(' ')[1];
    if (refCode && /^\d+$/.test(refCode)) {
      const referrerId = parseInt(refCode, 10);
      if (referrerId !== telegramId) {
        await Referral.create({ referrerId, referredId: telegramId });
        try {
          // Cross-chat notification is the only exception to the single-message rule.
          await botInstance.sendMessage(
            referrerId,
            `🎉 <b>New Referral!</b>\n\nUser <code>${telegramId}</code> joined using your link.`,
            { parse_mode: 'HTML' }
          );
        } catch { /* silent fail */ }
      }
    }
  }

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

function explorerLink(txHash: string): string {
  if (!txHash || txHash.includes('_')) return '';
  return `https://tonscan.org/tx/${txHash}`;
}

/* ───────────────────────────────────────────────────────────────────────────
   💼 WALLET HELPERS
   ─────────────────────────────────────────────────────────────────────────── */
async function getActiveWallet(userId: number): Promise<any> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return null;

  if (user.activeWalletId) {
    const active = await Wallet.findById(user.activeWalletId);
    if (active) return active;
  }

  const wallets = await walletService.getWallets(userId);
  if (wallets.length > 0) {
    user.activeWalletId = wallets[wallets.length - 1]._id;
    await user.save();
    return wallets[wallets.length - 1];
  }

  return null;
}

async function getUserWallets(userId: number): Promise<any[]> {
  return walletService.getWallets(userId);
}

/* ───────────────────────────────────────────────────────────────────────────
   🔄 RESTORE LAST ACTION
   ─────────────────────────────────────────────────────────────────────────── */
async function restoreLastAction(userId: number, chatId: number): Promise<void> {
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
  /* ───────────────────────────────────────────────────────────────────────────
   🏠 MAIN MENU
   ─────────────────────────────────────────────────────────────────────────── */
export async function showMainMenu(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.lastAction = 'main_menu';
  await user.save();

  const wallet = await getActiveWallet(userId);
  let tonBalance = '0';
  let atfBalance = '0';

  if (wallet?.address) {
    try {
      const onChain = await walletService.getBalance(wallet.address);
      tonBalance = Precision.fromBaseUnits(onChain.ton, TON_DECIMALS);
      atfBalance = Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS);
    } catch { /* fallback */ }
  }

  const [atfPrice, tonPrice, ngnRate] = await Promise.all([
    priceService.getAtfPriceUsd().catch(() => null),
    priceService.getTonPriceUsd().catch(() => null),
    priceService.getUsdNgnRate().catch(() => null),
  ]);

  const tonUsd = tonPrice ? priceService.convertCryptoToUsd(tonBalance, tonPrice.price, TON_DECIMALS) : null;
  const atfUsd = atfPrice ? priceService.convertCryptoToUsd(atfBalance, atfPrice.price, ATF_DECIMALS) : null;
  const totalUsd = (parseFloat(tonUsd || '0') + parseFloat(atfUsd || '0')).toFixed(2);
  const totalNgn = ngnRate ? priceService.convertUsdToNgn(totalUsd, ngnRate.price) : null;

  const priceLine = atfPrice && tonPrice
    ? `📊 ATF <code>$${atfPrice.price.toFixed(6)}</code>  ·  TON <code>$${tonPrice.price.toFixed(2)}</code>`
    : '';

  const caption = [
    `╔══════════════════════╗`,
    `║   🚀  ATF SWAP       ║`,
    `╚══════════════════════╝`,
    ``,
    `💎 <b>TON</b>  <code>${Precision.formatDisplay(tonBalance)}</code> TON`,
    tonUsd ? `<i>≈ $${tonUsd}</i>` : '',
    ngnRate && tonUsd ? `<i>≈ ₦${priceService.convertUsdToNgn(tonUsd, ngnRate.price)}</i>` : '',
    ``,
    `🔷 <b>ATF</b>  <code>${Precision.formatDisplay(atfBalance)}</code> ATF`,
    atfUsd ? `<i>≈ $${atfUsd}</i>` : '',
    ngnRate && atfUsd ? `<i>≈ ₦${priceService.convertUsdToNgn(atfUsd, ngnRate.price)}</i>` : '',
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    totalUsd !== '0.00' ? `💰 Total <b>$${totalUsd}</b> ${totalNgn ? `· ₦${totalNgn}` : ''}` : '',
    ``,
    priceLine,
    ``,
    wallet ? `👛 Wallet: <code>${formatAddressShort(wallet.address)}</code>` : '',
    wallet?.isImported ? '<i>🔑 Imported Account</i>' : '<i>🆕 Created wallet</i>',
    ``,
    `<i>Tap an action below 👇</i>`,
  ].filter(Boolean).join('\n');

  const isAdmin = user.isAdmin === true || user.isSuperAdmin === true;
  await render(userId, chatId, caption, keyboards.mainMenuKeyboard(isAdmin), { withImage: true });
}

/* ───────────────────────────────────────────────────────────────────────────
   🔄 SWAP FLOW
   ─────────────────────────────────────────────────────────────────────────── */
async function showSwapPair(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.lastAction = 'swap';
    await user.save();
  }

  await render(userId, chatId, [
    `⚡ <b>INSTANT SWAP</b>`,
    ``,
    `Choose your trading pair:`,
    ``,
    `<i>Zero slippage protection enabled ✅</i>`,
  ].join('\n'), keyboards.swapPairKeyboard(), { withImage: true });
}

async function startSwapInput(userId: number, chatId: number, direction: 'ton_to_atf' | 'atf_to_ton'): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const wallet = await getActiveWallet(userId);
  let balance = '0';
  if (wallet?.address) {
    try {
      const onChain = await walletService.getBalance(wallet.address);
      const raw = direction === 'ton_to_atf' ? onChain.ton : onChain.atf;
      balance = Precision.fromBaseUnits(raw, direction === 'ton_to_atf' ? TON_DECIMALS : ATF_DECIMALS);
    } catch { /* ignore */ }
  }

  const caption = [
    direction === 'ton_to_atf' ? `🔄 <b>TON → ATF</b>` : `🔄 <b>ATF → TON</b>`,
    ``,
    `Enter the amount to swap.`,
    ``,
    direction === 'ton_to_atf' ? `📌 Min: <b>${config.minSwapTon} TON</b>` : '',
    `💳 Balance: <code>${Precision.formatDisplay(balance)} ${direction === 'ton_to_atf' ? 'TON' : 'ATF'}</code>`,
  ].filter(Boolean).join('\n');

  user.state = `swap_input_${direction}`;
  user.stateData = {};
  await user.save();

  await render(userId, chatId, caption, keyboards.backKeyboard('swap'), { withImage: true });
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
    const confirmation = await swapService.prepareSwap({
      userId,
      direction,
      amount: text.trim(),
    });

    user.state = `swap_confirm_${direction}`;
    user.stateData = { confirmation, inputAmount: text.trim() };
    await user.save();

    const [atfPrice, tonPrice] = await Promise.all([
      priceService.getAtfPriceUsd().catch(() => null),
      priceService.getTonPriceUsd().catch(() => null),
    ]);

    const isTonToAtf = direction === 'ton_to_atf';
    let receiveUsd: string | null = null;
    if (isTonToAtf && atfPrice) {
      receiveUsd = priceService.convertCryptoToUsd(confirmation.expectedOutput, atfPrice.price, ATF_DECIMALS);
    } else if (!isTonToAtf && tonPrice) {
      receiveUsd = priceService.convertCryptoToUsd(confirmation.expectedOutput, tonPrice.price, TON_DECIMALS);
    }

    const caption = [
      `📋 <b>SWAP QUOTE</b>`,
      ``,
      `<b>You Pay:</b> <code>${Precision.formatDisplay(confirmation.inputAmount)} ${isTonToAtf ? 'TON' : 'ATF'}</code>`,
      `<b>Platform Fee:</b> <code>${Precision.formatDisplay(confirmation.platformFee)} ${isTonToAtf ? 'TON' : 'ATF'}</code>`,
      `<b>Swap Net:</b> <code>${Precision.formatDisplay(confirmation.netSwapAmount)} ${isTonToAtf ? 'TON' : 'ATF'}</code>`,
      ``,
      `<b>You Receive:</b> <code>${Precision.formatDisplay(confirmation.expectedOutput)} ${isTonToAtf ? 'ATF' : 'TON'}</code>`,
      receiveUsd ? `<i>≈ $${receiveUsd}</i>` : '',
      `<b>Minimum:</b> <code>${Precision.formatDisplay(confirmation.minOutput)} ${isTonToAtf ? 'ATF' : 'TON'}</code>`,
      isTonToAtf ? `<b>Network Cost:</b> <code>${Precision.formatDisplay(confirmation.dexCosts)} TON</code>` : '',
      ``,
      `<b>Rate:</b> ${confirmation.rate}`,
      `⏳ Expires in <b>${Math.max(0, Math.floor((confirmation.expiresAt.getTime() - Date.now()) / 1000))}s</b>`,
    ].filter(Boolean).join('\n');

    await render(userId, chatId, caption, keyboards.confirmSwapKeyboard(), { withImage: true });
  } catch (error: any) {
    let msg = error.message || 'Swap failed';
    if (error.message?.includes('Minimum')) {
      msg = `📌 Minimum swap is <b>${config.minSwapTon} TON</b>`;
    } else if (error.message?.includes('gas') || error.message?.includes('treasury')) {
      msg = `⛽ <b>Insufficient gas</b>\n\nPlease top up your TON balance.`;
    }
    await toast(userId, chatId, `❌ ${msg}`, keyboards.backKeyboard('swap'));
  }
}

async function executeSwap(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('swap_confirm_')) {
    await showMainMenu(userId, chatId);
    return;
  }

  const direction = user.state.replace('swap_confirm_', '') as 'ton_to_atf' | 'atf_to_ton';
  const { confirmation } = user.stateData || {};
  if (!confirmation || new Date() > confirmation.expiresAt) {
    await clearState(userId);
    await toast(userId, chatId, '⏳ Quote expired. Start again.', keyboards.backKeyboard('swap'));
    return;
  }

  await render(userId, chatId, `🔄 <b>Executing Swap...</b>\n\nBroadcasting to TON blockchain ⛓️`, { inline_keyboard: [] }, { withImage: true });

  try {
    const txId = await swapService.executeSwap(userId, confirmation, direction);
    await Transaction.findByIdAndUpdate(txId, { status: 'completed' });
    const txRecord = await Transaction.findById(txId);
    const txHash = txRecord?.txHash || '';
    const link = explorerLink(txHash);
    const isTonToAtf = direction === 'ton_to_atf';

    const caption = [
      `✅ <b>Swap Executed</b>`,
      ``,
      `<b>Sent:</b> ${Precision.formatDisplay(confirmation.inputAmount)} ${isTonToAtf ? 'TON' : 'ATF'}`,
      `<b>Receive:</b> ${Precision.formatDisplay(confirmation.expectedOutput)} ${isTonToAtf ? 'ATF' : 'TON'}`,
      `<b>Speed:</b> ~3–6s`,
      `<b>Asset:</b> ${isTonToAtf ? 'ATF' : 'TON'}`,
      link ? `🔗 <a href="${link}">View on Explorer</a>` : '',
      ``,
      `<i>Transaction done. Kindly check your wallet ✅</i>`,
    ].filter(Boolean).join('\n');

    await clearState(userId);
    await render(userId, chatId, caption, keyboards.backKeyboard('main'), { withImage: true });
  } catch (error: any) {
    await toast(userId, chatId, `❌ <b>Swap Failed</b>\n\n${error.message}`, keyboards.backKeyboard('swap'));
  }
               }
      /* ───────────────────────────────────────────────────────────────────────────
   📥 DEPOSIT FLOW
   ─────────────────────────────────────────────────────────────────────────── */
async function showDepositMenu(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.lastAction = 'deposit';
    await user.save();
  }

  await render(userId, chatId, [
    `📥 <b>DEPOSIT</b>`,
    ``,
    `Select asset to deposit:`,
    ``,
    `<i>All deposits are auto-credited ✅</i>`,
  ].join('\n'), keyboards.depositKeyboard(), { withImage: true });
}

async function showDepositTon(userId: number, chatId: number): Promise<void> {
  const wallet = await getActiveWallet(userId);
  if (!wallet) {
    await toast(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('deposit'));
    return;
  }

  await render(userId, chatId, [
    `📥 <b>DEPOSIT TON</b>`,
    ``,
    `Send TON to your custodial address:`,
    ``,
    `<code>${wallet.address}</code>`,
    ``,
    `⚠️ <i>Only send native TON to this address.</i>`,
    ``,
    `✅ Deposits are credited automatically in ~3s.`,
  ].join('\n'), keyboards.depositTonScreen(wallet.address), { withImage: true });
}

async function showDepositAtf(userId: number, chatId: number): Promise<void> {
  const wallet = await getActiveWallet(userId);
  if (!wallet) {
    await toast(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('deposit'));
    return;
  }

  await render(userId, chatId, [
    `📥 <b>DEPOSIT ATF</b>`,
    ``,
    `Send ATF Jetton to:`,
    ``,
    `<code>${wallet.address}</code>`,
    ``,
    `Token: <b>ATF</b>`,
    `⚠️ <i>Only send the official ATF Jetton.</i>`,
    ``,
    `✅ Deposits are credited automatically in ~3s.`,
  ].join('\n'), keyboards.depositAtfScreen(), { withImage: true });
}

async function checkDepositStatus(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  const wallet = await getActiveWallet(userId);
  if (!wallet?.address) {
    await toast(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('deposit'));
    return;
  }

  await render(userId, chatId, `🔍 <b>Checking ${asset} deposits...</b>\n\nScanning blockchain ⛓️`, {
    inline_keyboard: [[{ text: '🔙 Back', callback_data: `deposit_${asset.toLowerCase()}` }]],
  }, { withImage: true });

  try {
    const onChain = await walletService.getBalance(wallet.address);
    const balance = asset === 'TON'
      ? Precision.fromBaseUnits(onChain.ton, TON_DECIMALS)
      : Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS);

    await toast(userId, chatId, [
      `✅ <b>${asset} Balance Updated</b>`,
      ``,
      `Current: <code>${Precision.formatDisplay(balance)} ${asset}</code>`,
    ].join('\n'), keyboards.backKeyboard('deposit'));
  } catch (error: any) {
    await toast(userId, chatId, `❌ Check failed: ${error.message}`, keyboards.backKeyboard('deposit'));
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   📤 WITHDRAWAL FLOW
   ─────────────────────────────────────────────────────────────────────────── */
async function showWithdrawMenu(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.lastAction = 'withdraw';
    await user.save();
  }

  await render(userId, chatId, [
    `📤 <b>WITHDRAW</b>`,
    ``,
    `Select asset to withdraw:`,
    ``,
    `<i>Double-check your destination address!</i>`,
  ].join('\n'), keyboards.withdrawAssetKeyboard(), { withImage: true });
}

async function startWithdrawal(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.state = `withdraw_address_${asset}`;
  user.stateData = {};
  await user.save();

  await render(userId, chatId, [
    `📤 <b>WITHDRAW ${asset}</b>`,
    ``,
    `Enter the destination TON address.`,
    ``,
    `<i>Example: EQD... or UQD...</i>`,
  ].join('\n'), keyboards.cancelKeyboard('withdraw'), { withImage: true });
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

  await render(userId, chatId, [
    `📤 <b>WITHDRAW ${asset}</b>`,
    ``,
    `Destination: <code>${formatAddressShort(text)}</code>`,
    ``,
    `Enter ${asset} amount:`,
  ].join('\n'), keyboards.cancelKeyboard('withdraw'), { withImage: true });
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
      amount: text.trim(),
      toAddress: user.stateData.address,
    });

    user.state = `withdraw_confirm_${asset}`;
    user.stateData = { address: user.stateData.address, amount: text.trim(), prep };
    await user.save();

    await render(userId, chatId, [
      `📋 <b>CONFIRM WITHDRAWAL</b>`,
      ``,
      `<b>Asset:</b> ${asset}`,
      `<b>To:</b> <code>${formatAddressShort(prep.toAddress)}</code>`,
      `<b>Amount:</b> <code>${Precision.formatDisplay(prep.amount)} ${asset}</code>`,
      `<b>Network Fee:</b> ≈ ${prep.networkCost} TON`,
      `<b>Net Receive:</b> <code>${Precision.formatDisplay(prep.receiveAmount)} ${asset}</code>`,
    ].join('\n'), keyboards.confirmWithdrawalKeyboard(), { withImage: true });
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

  await render(userId, chatId, `📡 <b>Broadcasting Withdrawal...</b>\n\nPlease wait ⏳`, { inline_keyboard: [] }, { withImage: true });

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

    await clearState(userId);
    await render(userId, chatId, [
      `✅ <b>Withdrawal Sent</b>`,
      ``,
      `<b>Amount:</b> ${amount} ${asset}`,
      `<b>Speed:</b> ~3s`,
      `<b>Asset:</b> ${asset}`,
      link ? `🔗 <a href="${link}">View on Explorer</a>` : '',
      ``,
      `<i>Transaction done. Kindly check your wallet ✅</i>`,
    ].filter(Boolean).join('\n'), keyboards.backKeyboard('main'), { withImage: true });
  } catch (error: any) {
    await toast(userId, chatId, `❌ <b>Withdrawal Failed</b>\n\n${error.message}`, keyboards.cancelKeyboard('withdraw'));
  }
}
  /* ───────────────────────────────────────────────────────────────────────────
   👤 ACCOUNT / DASHBOARD
   ─────────────────────────────────────────────────────────────────────────── */
async function showAccount(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.lastAction = 'account';
  await user.save();

  const wallet = await getActiveWallet(userId);
  let tonBalance = '0';
  let atfBalance = '0';

  if (wallet?.address) {
    try {
      const onChain = await walletService.getBalance(wallet.address);
      tonBalance = Precision.fromBaseUnits(onChain.ton, TON_DECIMALS);
      atfBalance = Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS);
    } catch { /* ignore */ }
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

  const versionTag = wallet?.walletVersion
    ? `🔧 ${wallet.walletVersion.toUpperCase()}`
    : wallet?.isImported
    ? '🔑 Imported wallet'
    : '🆕 Created wallet';

  const caption = [
    `👤 <b>MY DASHBOARD</b>`,
    ``,
    `💎 TON  <code>${Precision.formatDisplay(tonBalance)}</code>`,
    tonUsd ? `<i>≈ $${tonUsd}</i>` : '',
    ``,
    `🔷 ATF  <code>${Precision.formatDisplay(atfBalance)}</code>`,
    atfUsd ? `<i>≈ $${atfUsd}</i>` : '',
    ngnRate && atfUsd ? `<i>≈ ₦${priceService.convertUsdToNgn(atfUsd, ngnRate.price)}</i>` : '',
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    totalUsd !== '0.00' ? `💰 Total <b>$${totalUsd}</b> ${totalNgn ? `· ₦${totalNgn}` : ''}` : '',
    ``,
    atfPrice ? `📊 ATF <code>$${atfPrice.price.toFixed(6)}</code>` : '',
    ``,
    wallet ? `👛 Wallet: <code>${formatAddressShort(wallet.address)}</code>` : '',
    versionTag,
  ].filter(Boolean).join('\n');

  await render(userId, chatId, caption, keyboards.accountKeyboard(), { withImage: true });
}

/* ───────────────────────────────────────────────────────────────────────────
   👛 MULTI-WALLET SYSTEM
   ─────────────────────────────────────────────────────────────────────────── */
async function showWalletList(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const wallets = await getUserWallets(userId);
  const activeId = user.activeWalletId?.toString() || '';

  await render(userId, chatId, [
    `👛 <b>MY WALLETS</b>`,
    ``,
    `You have <b>${wallets.length}</b> wallet${wallets.length !== 1 ? 's' : ''}.`,
    `Tap to switch active wallet:`,
  ].join('\n'), keyboards.walletListKeyboard(wallets, activeId), { withImage: true });
}

async function switchWallet(userId: number, chatId: number, walletId: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const hasWallet = user.walletIds.some((id: any) => id.toString() === walletId);
  if (!hasWallet) {
    await toast(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('account'));
    return;
  }

  user.activeWalletId = new mongoose.Types.ObjectId(walletId);
  await user.save();

  await toast(userId, chatId, '✅ <b>Wallet Switched</b>', keyboards.backKeyboard('account'));
  setTimeout(() => showAccount(userId, chatId), 1000);
}

async function createNewWallet(userId: number, chatId: number): Promise<void> {
  try {
    const newWallet = await walletService.createWallet(userId);
    const user = await User.findOne({ telegramId: userId });
    if (user && newWallet) {
      user.walletIds.push(newWallet._id);
      user.activeWalletId = newWallet._id;
      await user.save();
    }

    await toast(userId, chatId, [
      `✅ <b>New Wallet Created</b>`,
      ``,
      `Address: <code>${formatAddressShort(newWallet.address)}</code>`,
      ``,
      `Switched to new wallet automatically.`,
    ].join('\n'), keyboards.backKeyboard('account'));

    setTimeout(() => showAccount(userId, chatId), 1500);
  } catch (error: any) {
    await toast(userId, chatId, `❌ Failed to create wallet: ${error.message}`, keyboards.backKeyboard('account'));
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   🔐 WALLET EXPORT
   ─────────────────────────────────────────────────────────────────────────── */
async function showExportWarning(userId: number, chatId: number): Promise<void> {
  await render(userId, chatId, [
    `🛡️ <b>SECURITY WARNING</b>`,
    ``,
    `Your recovery phrase grants <b>full control</b> over this wallet.`,
    `Never share it. ATFSwap support will <b>never</b> ask for it.`,
    ``,
    `Tap <b>Reveal Phrase</b> to show your backup words.`,
  ].join('\n'), keyboards.exportWarningKeyboard(), { withImage: true });
}

async function exportWallet(userId: number, chatId: number): Promise<void> {
  try {
    const wallet = await getActiveWallet(userId);
    if (!wallet) {
      await toast(userId, chatId, '❌ No wallet found.', keyboards.backKeyboard('account'));
      return;
    }

    const { decrypt } = await import('../utils/encryption');
    const phrase = decrypt(wallet.encryptedMnemonic, wallet.iv, wallet.tag);

    await render(userId, chatId, [
      `🔐 <b>WALLET BACKUP</b>`,
      ``,
      `<code>${phrase}</code>`,
      ``,
      `🗑️ <i>Delete this message immediately after copying.</i>`,
    ].join('\n'), keyboards.backKeyboard('account'), { withImage: true });

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
              /* ───────────────────────────────────────────────────────────────────────────
   🔑 WALLET IMPORT  (V4R2 / W5R1)
   ─────────────────────────────────────────────────────────────────────────── */
type WalletVersion = 'v4r2' | 'v5r1';

/** Ephemeral memory-only cache. NEVER logged. NEVER persisted. */
const autoDetectMnemonicCache = new Map<number, { mnemonic: string; timer: NodeJS.Timeout }>();

function setAutoDetectMnemonic(userId: number, mnemonic: string): void {
  const existing = autoDetectMnemonicCache.get(userId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => autoDetectMnemonicCache.delete(userId), 90000);
  autoDetectMnemonicCache.set(userId, { mnemonic, timer });
}

function getAndClearAutoDetectMnemonic(userId: number): string | null {
  const entry = autoDetectMnemonicCache.get(userId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  autoDetectMnemonicCache.delete(userId);
  return entry.mnemonic;
}

async function startImportWallet(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.state = 'import_version_select';
  user.stateData = {};
  await user.save();

  await render(userId, chatId, [
    `🔐 <b>IMPORT WALLET</b>`,
    ``,
    `Select the wallet version:`,
    ``,
    `<i>Your existing wallets will not be replaced.</i>`,
  ].join('\n'), keyboards.importWalletVersionKeyboard(), { withImage: true });
}

async function handleImportVersionSelect(
  userId: number,
  chatId: number,
  strategy: 'auto' | WalletVersion
): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || user.state !== 'import_version_select') return;

  if (strategy === 'auto') {
    user.stateData = { importStrategy: 'auto' };
  } else {
    user.stateData = { importStrategy: 'manual', importVersion: strategy };
  }

  user.state = 'import_mnemonic_input';
  await user.save();

  await render(userId, chatId, [
    `🔐 <b>IMPORT WALLET</b>`,
    ``,
    `Paste your 24-word recovery phrase below.`,
    ``,
    `<i>This will add a NEW wallet. Your existing wallets will not be replaced.</i>`,
  ].join('\n'), keyboards.cancelKeyboard('account'), { withImage: true });
}

async function handleImportMnemonic(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || user.state !== 'import_mnemonic_input') return;

  const words = text.trim().split(/\s+/);
  if (words.length !== 24) {
    await toast(userId, chatId, '❌ Invalid phrase. Please enter exactly 24 words.', keyboards.cancelKeyboard('account'));
    return;
  }

  const mnemonic = text.trim();
  const strategy = user.stateData?.importStrategy as 'auto' | undefined;
  const manualVersion = user.stateData?.importVersion as WalletVersion | undefined;

  try {
    let selectedVersion: WalletVersion;

    if (strategy === 'auto') {
      try {
        const detected = await walletService.detectWalletVersion(mnemonic);
        selectedVersion = detected.version;
      } catch (detectErr: any) {
        if (detectErr.message?.includes('Both')) {
          const wallets = await walletService.deriveAllWallets(mnemonic);
          setAutoDetectMnemonic(userId, mnemonic);
          user.state = 'import_version_confirm';
          await user.save();

          await render(userId, chatId, [
            `🔍 <b>AUTO-DETECT RESULT</b>`,
            ``,
            `Both <b>V4R2</b> and <b>W5R1</b> were found for this phrase.`,
            ``,
            `V4R2: <code>${wallets.v4.address}</code>`,
            `W5R1: <code>${wallets.v5.address}</code>`,
            ``,
            `Please choose which wallet to import:`,
          ].join('\n'), {
            inline_keyboard: [
              [{ text: '🟦 Import V4R2', callback_data: 'import_version_v4' }],
              [{ text: '🟪 Import W5R1', callback_data: 'import_version_v5' }],
              [{ text: '❌ Cancel', callback_data: 'account' }],
            ],
          }, { withImage: true });
          return;
        }
        throw detectErr;
      }
    } else if (manualVersion) {
      selectedVersion = manualVersion;
    } else {
      await toast(userId, chatId, '❌ Import configuration error. Please start over.', keyboards.backKeyboard('account'));
      return;
    }

    await finalizeWalletImport(userId, chatId, mnemonic, selectedVersion);
  } catch (error: any) {
    await toast(userId, chatId, `❌ Import failed: ${error.message}`, keyboards.cancelKeyboard('account'));
  }
}

async function handleImportVersionConfirm(userId: number, chatId: number, version: WalletVersion): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || user.state !== 'import_version_confirm') return;

  const mnemonic = getAndClearAutoDetectMnemonic(userId);
  if (!mnemonic) {
    await toast(userId, chatId, '⏳ Session expired. Please start again.', keyboards.backKeyboard('account'));
    await clearState(userId);
    return;
  }

  try {
    await finalizeWalletImport(userId, chatId, mnemonic, version);
  } catch (error: any) {
    await toast(userId, chatId, `❌ Import failed: ${error.message}`, keyboards.cancelKeyboard('account'));
  }
}

async function finalizeWalletImport(
  userId: number,
  chatId: number,
  mnemonic: string,
  version: WalletVersion
): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const existingWallets = await getUserWallets(userId);
  const derived = await walletService.deriveAllWallets(mnemonic);
  const targetAddress = version === 'v4r2' ? derived.v4.address : derived.v5.address;

  const existing = existingWallets.find((w: any) => w.address === targetAddress);
  if (existing) {
    user.activeWalletId = existing._id;
    await user.save();
    await clearState(userId);

    const versionTag = existing.walletVersion ? existing.walletVersion.toUpperCase() : 'Legacy / Unknown';

    await render(userId, chatId, [
      `ℹ️ <b>Wallet Already Exists</b>`,
      ``,
      `This wallet is already in your list.`,
      ``,
      `Address: <code>${formatAddressShort(existing.address)}</code>`,
      `Type: <b>${versionTag}</b>`,
      ``,
      `Switched to existing wallet automatically.`,
    ].join('\n'), keyboards.backKeyboard('account'), { withImage: true });
    return;
  }

  const newWallet = await walletService.importWallet(userId, mnemonic, version);

  user.walletIds.push(newWallet._id);
  user.activeWalletId = newWallet._id;
  await user.save();
  await clearState(userId);

  const versionTag = newWallet.walletVersion
    ? newWallet.walletVersion.toUpperCase()
    : 'Legacy / Unknown';

  await render(userId, chatId, [
    `✅ <b>Wallet Imported</b>`,
    ``,
    `Wallet ${user.walletIds.length}`,
    ``,
    `Address:`,
    `<code>${formatAddressShort(newWallet.address)}</code>`,
    ``,
    `Wallet Type:`,
    `<b>${versionTag}</b>`,
    ``,
    `Switched to imported wallet automatically.`,
  ].join('\n'), keyboards.backKeyboard('account'), { withImage: true });
}
/* ───────────────────────────────────────────────────────────────────────────
   📜 HISTORY
   ─────────────────────────────────────────────────────────────────────────── */
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

  const lines = display.map((tx: any) => {
    const icon = tx.type === 'deposit' ? '📥' : tx.type === 'withdrawal' ? '📤' : '🔄';
    const amt = Precision.fromBaseUnits(BigInt(tx.amount), tx.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
    const shortHash = tx.txHash && !tx.txHash.includes('-')
      ? `<a href="${explorerLink(tx.txHash)}">${tx.txHash.slice(0, 6)}...${tx.txHash.slice(-4)}</a>`
      : '...';
    const statusIcon = tx.status === 'completed' ? '✅' : tx.status === 'pending' ? '⏳' : '❌';
    return `${icon} <b>${tx.type.toUpperCase()}</b> <code>${Precision.formatDisplay(amt)} ${tx.asset}</code>\n   ${statusIcon} ${tx.status} · ${shortHash}`;
  });

  const caption = [
    `📜 <b>TRANSACTION HISTORY</b>`,
    ``,
    ...(lines.length ? lines : ['<i>No transactions yet.</i>']),
    ``,
    `Page ${page}`,
  ].join('\n');

  await render(userId, chatId, caption, keyboards.historyPaginationKeyboard(page, hasMore), { withImage: true });
}

/* ───────────────────────────────────────────────────────────────────────────
   💹 PRICES
   ─────────────────────────────────────────────────────────────────────────── */
async function showPrices(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.lastAction = 'prices';
    await user.save();
  }

  const [atfPrice, tonPrice, ngnRate] = await Promise.all([
    priceService.getAtfPriceUsd().catch(() => null),
    priceService.getTonPriceUsd().catch(() => null),
    priceService.getUsdNgnRate().catch(() => null),
  ]);

  const caption = [
    `💹 <b>LIVE MARKET PRICES</b>`,
    ``,
    atfPrice
      ? `🔷 <b>ATF</b> $${atfPrice.price.toFixed(6)}\n${ngnRate ? `<i>≈ ₦${(atfPrice.price * ngnRate.price).toFixed(2)}</i>` : ''}`
      : '❌ ATF price unavailable',
    ``,
    tonPrice
      ? `💎 <b>TON</b> $${tonPrice.price.toFixed(2)}\n${ngnRate ? `<i>≈ ₦${(tonPrice.price * ngnRate.price).toFixed(2)}</i>` : ''}`
      : '❌ TON price unavailable',
    ``,
    ngnRate
      ? `💱 <b>USD/NGN</b> ₦${ngnRate.price.toFixed(2)}`
      : '❌ NGN rate unavailable',
  ].filter(Boolean).join('\n');

  await render(userId, chatId, caption, keyboards.pricesKeyboard(), { withImage: true });
}

/* ───────────────────────────────────────────────────────────────────────────
   ❓ HELP
   ─────────────────────────────────────────────────────────────────────────── */
async function showHelp(userId: number, chatId: number): Promise<void> {
  await render(userId, chatId, [
    `❓ <b>ATF SWAP HELP</b>`,
    ``,
    `<b>What is this?</b>`,
    `A custodial TON ↔ ATF exchange inside Telegram.`,
    ``,
    `<b>Quick Start</b>`,
    `1. Deposit TON or ATF 📥`,
    `2. Swap instantly 🔄`,
    `3. Withdraw to any TON address 📤`,
    ``,
    `<b>Commands</b>`,
    `/start — Open menu`,
    `/help — Show this message`,
    ``,
    `<b>Fees</b>`,
    `• Swap: ${config.platformSwapFeePercent}% platform fee`,
    `• Withdrawal: network gas only`,
    ``,
    `<b>Support</b>`,
    `Contact admin if a transaction stalls for >5 minutes.`,
  ].join('\n'), keyboards.helpKeyboard(), { withImage: true });
}

/* ───────────────────────────────────────────────────────────────────────────
   🤝 REFERRAL PROGRAM
   ─────────────────────────────────────────────────────────────────────────── */
async function showReferral(userId: number, chatId: number): Promise<void> {
  const count = await Referral.countDocuments({ referrerId: userId });
  const link = `https://t.me/${config.botUsername}?start=${userId}`;

  await render(userId, chatId, [
    `🤝 <b>REFERRAL PROGRAM</b>`,
    ``,
    `Invite friends and earn rewards!`,
    ``,
    `👥 Referred: <b>${count}</b> user${count !== 1 ? 's' : ''}`,
    ``,
    `Your link:`,
    `<code>${link}</code>`,
    ``,
    `<i>Share your link. When they trade, you earn!</i>`,
  ].join('\n'), keyboards.backKeyboard('back_main'), { withImage: true });
}

/* ───────────────────────────────────────────────────────────────────────────
   🛡️ ADMIN PANEL
   ─────────────────────────────────────────────────────────────────────────── */
async function showAdminPanel(userId: number, chatId: number): Promise<void> {
  try {
    const user = await requireAdmin(userId);
    user.lastAction = 'admin_panel';
    await user.save();

    await render(userId, chatId, [
      `🛡️ <b>ADMIN PANEL</b>`,
      ``,
      `Welcome, ${user.firstName || 'Admin'}!`,
      ``,
      `Select a section:`,
    ].join('\n'), keyboards.adminPanelKeyboard(user.isSuperAdmin), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showAdminManagement(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    await render(userId, chatId, `👥 <b>ADMIN MANAGEMENT</b>`, keyboards.adminManagementKeyboard(), { withImage: true });
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

    await render(userId, chatId, `👤 <b>GIVE ADMIN</b>\n\nEnter Telegram ID:`, keyboards.cancelKeyboard('admin_management'), { withImage: true });
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

    await render(userId, chatId, `🚫 <b>REMOVE ADMIN</b>\n\nEnter Telegram ID:`, keyboards.cancelKeyboard('admin_management'), { withImage: true });
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
    await toast(userId, chatId, '⛔ Cannot remove super admin.', keyboards.cancelKeyboard('admin_management'));
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
    const admins = await User.find({ isAdmin: true }).sort({ createdAt: -1 });
    const lines = admins.map((a: any) => `• <code>${a.telegramId}</code> ${a.isSuperAdmin ? '(Super)' : ''}`);

    await render(userId, chatId, [
      `👥 <b>ADMIN LIST</b>`,
      ``,
      ...(lines.length ? lines : ['<i>No admins found.</i>']),
    ].join('\n'), keyboards.backKeyboard('admin_management'), { withImage: true });
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

async function showUserList(userId: number, chatId: number, page: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const limit = 10;
    const skip = (page - 1) * limit;

    const users = await User.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)
      .select('telegramId firstName username isFrozen createdAt');

    const hasMore = users.length > limit;
    const display = hasMore ? users.slice(0, limit) : users;

    await render(userId, chatId, [
      `👤 <b>USERS</b>`,
      ``,
      `Total: ${await User.countDocuments()}`,
      `Page ${page}`,
    ].join('\n'), keyboards.userListKeyboard(display, page, hasMore), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showUserDetail(userId: number, chatId: number, targetId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const target = await User.findOne({ telegramId: targetId });
    if (!target) {
      await toast(userId, chatId, '❌ User not found.', keyboards.backKeyboard('admin_users'));
      return;
    }

    const wallet = await walletService.getWallet(targetId);
    let tonBalance = '0';
    let atfBalance = '0';

    if (wallet?.address) {
      try {
        const onChain = await walletService.getBalance(wallet.address);
        tonBalance = Precision.fromBaseUnits(onChain.ton, TON_DECIMALS);
        atfBalance = Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS);
      } catch { /* ignore */ }
    }

    const caption = [
      `👤 <b>USER DETAIL</b>`,
      ``,
      `ID: <code>${target.telegramId}</code>`,
      `Name: ${target.firstName || 'N/A'} ${target.lastName || ''}`,
      `Username: ${target.username ? `@${target.username}` : 'N/A'}`,
      `Status: ${target.isFrozen ? '❄️ Frozen' : '✅ Active'}`,
      ``,
      `💎 TON: <code>${Precision.formatDisplay(tonBalance)}</code>`,
      `🔷 ATF: <code>${Precision.formatDisplay(atfBalance)}</code>`,
      ``,
      `Created: ${target.createdAt.toLocaleString()}`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.userActionKeyboard(targetId, target.isFrozen), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showAdminUserBalance(userId: number, chatId: number, targetId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const wallet = await walletService.getWallet(targetId);
    if (!wallet?.address) {
      await toast(userId, chatId, '❌ No wallet found.', keyboards.backKeyboard(`admin_user_${targetId}`));
      return;
    }

    const onChain = await walletService.getBalance(wallet.address);
    const ton = Precision.fromBaseUnits(onChain.ton, TON_DECIMALS);
    const atf = Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS);

    const caption = [
      `⛓️ <b>ON-CHAIN BALANCE</b>`,
      ``,
      `User: <code>${targetId}</code>`,
      ``,
      `💎 TON: <code>${Precision.formatDisplay(ton)}</code>`,
      `🔷 ATF: <code>${Precision.formatDisplay(atf)}</code>`,
      ``,
      `Wallet: <code>${formatAddressShort(wallet.address)}</code>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard(`admin_user_${targetId}`), { withImage: true });
  } catch (error: any) {
    await toast(userId, chatId, `❌ ${error.message}`, keyboards.backKeyboard('admin_users'));
  }
}

async function showAdminUserTransactions(userId: number, chatId: number, targetId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const target = await User.findOne({ telegramId: targetId });
    if (!target) {
      await toast(userId, chatId, '❌ User not found.', keyboards.backKeyboard('admin_users'));
      return;
    }

    const txs = await Transaction.find({ userId: target._id }).sort({ createdAt: -1 }).limit(20);
    const lines = txs.map((tx: any) => {
      const icon = tx.type === 'deposit' ? '📥' : tx.type === 'withdrawal' ? '📤' : '🔄';
      const amt = Precision.fromBaseUnits(BigInt(tx.amount), tx.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
      return `${icon} <code>${tx.type}</code> <code>${Precision.formatDisplay(amt)} ${tx.asset}</code> · ${tx.status}`;
    });

    const caption = [
      `📜 <b>USER TRANSACTIONS</b>`,
      ``,
      `User: <code>${targetId}</code>`,
      ``,
      ...(lines.length ? lines : ['<i>No transactions.</i>']),
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard(`admin_user_${targetId}`), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function toggleFreeze(userId: number, chatId: number, targetId: number, action: 'freeze' | 'unfreeze'): Promise<void> {
  try {
    await requireAdmin(userId);
    const target = await User.findOne({ telegramId: targetId });
    if (!target) {
      await toast(userId, chatId, '❌ User not found.', keyboards.backKeyboard('admin_users'));
      return;
    }

    if (target.isSuperAdmin) {
      await toast(userId, chatId, '⛔ Cannot modify super admin.', keyboards.backKeyboard('admin_users'));
      return;
    }

    const wasFrozen = target.isFrozen;
    target.isFrozen = action === 'freeze';
    await target.save();

    await AdminAction.create({
      adminId: userId,
      action: target.isFrozen ? 'USER_FROZEN' : 'USER_UNFROZEN',
      target: targetId.toString(),
      oldValue: wasFrozen.toString(),
      newValue: target.isFrozen.toString(),
      result: 'success',
    });

    await toast(userId, chatId, `✅ User <code>${targetId}</code> is now ${target.isFrozen ? '❄️ frozen' : '✅ active'}.`, keyboards.backKeyboard('admin_users'));
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showAuditLogs(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const logs = await AdminAction.find().sort({ createdAt: -1 }).limit(15);
    const lines = logs.map((l: any) => {
      const date = new Date(l.createdAt).toLocaleString();
      return `${date} <b>${l.action}</b> by <code>${l.adminId}</code>`;
    });

    await render(userId, chatId, [
      `📋 <b>AUDIT LOGS</b> (Last 15)`,
      ``,
      ...(lines.length ? lines : ['<i>No logs.</i>']),
    ].join('\n'), keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showSystemSettings(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const caption = [
      `⚙️ <b>SYSTEM SETTINGS</b>`,
      ``,
      `Fee Wallet: <code>${formatAddressShort(config.adminFeeWalletAddress)}</code>`,
      `Platform Fee: <b>${config.platformSwapFeePercent}%</b>`,
      `Min Swap: <b>${config.minSwapTon} TON</b>`,
      `Max Slippage: <b>${config.maxSlippagePercent}%</b>`,
      `Network: <b>${config.tonNetwork || 'mainnet'}</b>`,
      ``,
      `<i>Settings are configured via environment variables.</i>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   📊 ADMIN TRANSACTION VIEWS
   ─────────────────────────────────────────────────────────────────────────── */
async function showAdminTransactions(userId: number, chatId: number, page: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const limit = 5;
    const skip = (page - 1) * limit;

    const txs = await Transaction.find().sort({ createdAt: -1 }).skip(skip).limit(limit + 1);
    const hasMore = txs.length > limit;
    const display = hasMore ? txs.slice(0, limit) : txs;

    const lines = display.map((tx: any) => {
      const icon = tx.type === 'deposit' ? '📥' : tx.type === 'withdrawal' ? '📤' : '🔄';
      const amt = Precision.fromBaseUnits(BigInt(tx.amount), tx.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
      return `${icon} <code>${tx.userId}</code> — <b>${tx.type}</b> <code>${Precision.formatDisplay(amt)} ${tx.asset}</code>`;
    });

    const caption = ['📜 <b>ALL TRANSACTIONS</b>', '', ...lines, '', `Page ${page}`].filter(Boolean).join('\n');
    await render(userId, chatId, caption, keyboards.adminPaginationKeyboard('admin_transactions', page, hasMore), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showAdminDeposits(userId: number, chatId: number, page: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const limit = 5;
    const skip = (page - 1) * limit;

    const txs = await Transaction.find({ type: 'deposit' }).sort({ createdAt: -1 }).skip(skip).limit(limit + 1);
    const hasMore = txs.length > limit;
    const display = hasMore ? txs.slice(0, limit) : txs;

    const lines = display.map((tx: any) => {
      const amt = Precision.fromBaseUnits(BigInt(tx.amount), tx.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
      return `📥 <code>${tx.userId}</code> — <code>${Precision.formatDisplay(amt)} ${tx.asset}</code>`;
    });

    const caption = ['📥 <b>DEPOSITS</b>', '', ...lines, '', `Page ${page}`].filter(Boolean).join('\n');
    await render(userId, chatId, caption, keyboards.adminPaginationKeyboard('admin_deposits', page, hasMore), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showAdminWithdrawals(userId: number, chatId: number, page: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const limit = 5;
    const skip = (page - 1) * limit;

    const txs = await Transaction.find({ type: 'withdrawal' }).sort({ createdAt: -1 }).skip(skip).limit(limit + 1);
    const hasMore = txs.length > limit;
    const display = hasMore ? txs.slice(0, limit) : txs;

    const lines = display.map((tx: any) => {
      const amt = Precision.fromBaseUnits(BigInt(tx.amount), tx.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
      return `📤 <code>${tx.userId}</code> — <code>${Precision.formatDisplay(amt)} ${tx.asset}</code>`;
    });

    const caption = ['📤 <b>WITHDRAWALS</b>', '', ...lines, '', `Page ${page}`].filter(Boolean).join('\n');
    await render(userId, chatId, caption, keyboards.adminPaginationKeyboard('admin_withdrawals', page, hasMore), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showAdminSwaps(userId: number, chatId: number, page: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const limit = 5;
    const skip = (page - 1) * limit;

    const txs = await Transaction.find({ type: 'swap' }).sort({ createdAt: -1 }).skip(skip).limit(limit + 1);
    const hasMore = txs.length > limit;
    const display = hasMore ? txs.slice(0, limit) : txs;

    const lines = display.map((tx: any) => {
      const amt = Precision.fromBaseUnits(BigInt(tx.amount), tx.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
      return `🔄 <code>${tx.userId}</code> — <code>${Precision.formatDisplay(amt)} ${tx.asset}</code>`;
    });

    const caption = ['🔄 <b>SWAPS</b>', '', ...lines, '', `Page ${page}`].filter(Boolean).join('\n');
    await render(userId, chatId, caption, keyboards.adminPaginationKeyboard('admin_swaps', page, hasMore), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showAdminTokenConfig(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const caption = [
      `🔷 <b>TOKEN CONFIG</b>`,
      ``,
      `ATF Jetton: <code>${formatAddressShort(config.atfJettonAddress)}</code>`,
      `Decimals: <b>${ATF_DECIMALS}</b>`,
      ``,
      `<i>Edit via environment variables.</i>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showAdminDexConfig(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const caption = [
      `🔀 <b>DEX CONFIG</b>`,
      ``,
      `STON.fi API: <code>${config.stonfiApiUrl}</code>`,
      `Slippage: <b>${config.maxSlippagePercent}%</b>`,
      ``,
      `<i>Edit via environment variables.</i>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showAdminFeeConfig(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const caption = [
      `💰 <b>FEE CONFIG</b>`,
      ``,
      `Swap Fee: <b>${config.platformSwapFeePercent}%</b>`,
      `Fee Wallet: <code>${formatAddressShort(config.adminFeeWalletAddress)}</code>`,
      ``,
      `<i>Edit via environment variables.</i>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

async function showAdminPriceProviders(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const caption = [
      `📡 <b>PRICE PROVIDERS</b>`,
      ``,
      `TON/USD: <code>${config.tonPriceApiUrl || 'auto-fallback'}</code>`,
      `ATF/USD: <code>${config.atfPriceApiUrl || 'auto-fallback'}</code>`,
      `USD/NGN: <code>${config.usdNgnRateApiUrl || 'auto-fallback'}</code>`,
      ``,
      `<i>Edit via environment variables.</i>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   📢 BROADCAST MESSAGE (Super Admin)
   ─────────────────────────────────────────────────────────────────────────── */
async function startBroadcast(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    user.state = 'broadcast_input';
    await user.save();

    await render(userId, chatId, `📢 <b>BROADCAST MESSAGE</b>\n\nType the message to send to ALL users:`, keyboards.cancelKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

async function handleBroadcast(userId: number, chatId: number, text: string): Promise<void> {
  try {
    await requireSuperAdmin(userId);
  } catch {
    await showMainMenu(userId, chatId);
    return;
  }

  const users = await User.find().select('telegramId');
  let sent = 0;
  let failed = 0;

  for (const u of users) {
    try {
      await botInstance.sendMessage(u.telegramId, `📢 <b>Announcement</b>\n\n${text}`, { parse_mode: 'HTML' });
      sent++;
    } catch {
      failed++;
    }
    if (sent % 20 === 0) await new Promise(r => setTimeout(r, 1000));
  }

  await clearState(userId);
  await toast(userId, chatId, `✅ <b>Broadcast Complete</b>\n\nSent: <b>${sent}</b>\nFailed: <b>${failed}</b>`, keyboards.backKeyboard('admin_panel'));

  await AdminAction.create({
    adminId: userId,
    action: 'BROADCAST_SENT',
    target: 'all_users',
    result: 'success',
  });
      }

                              /* ───────────────────────────────────────────────────────────────────────────
   📈 PLATFORM STATS
   ─────────────────────────────────────────────────────────────────────────── */
async function handleStats(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const totalUsers = await User.countDocuments();
    const totalTxs = await Transaction.countDocuments();
    const totalSwaps = await Transaction.countDocuments({ type: 'swap' });
    const totalDeposits = await Transaction.countDocuments({ type: 'deposit' });
    const totalWithdrawals = await Transaction.countDocuments({ type: 'withdrawal' });

    const caption = [
      `📊 <b>PLATFORM STATS</b>`,
      ``,
      `👥 Total Users: <b>${totalUsers}</b>`,
      `📜 Total Txns: <b>${totalTxs}</b>`,
      ``,
      `🔄 Swaps: <b>${totalSwaps}</b>`,
      `📥 Deposits: <b>${totalDeposits}</b>`,
      `📤 Withdrawals: <b>${totalWithdrawals}</b>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

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

  try {
    await botInstance.answerCallbackQuery(query.id);
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

  /* ── Swap ── */
  if (data === 'swap') { await showSwapPair(userId, chatId); return; }
  if (data === 'swap_ton_atf') { await startSwapInput(userId, chatId, 'ton_to_atf'); return; }
  if (data === 'swap_atf_ton') { await startSwapInput(userId, chatId, 'atf_to_ton'); return; }
  if (data === 'confirm_swap') { await executeSwap(userId, chatId); return; }
  if (data === 'cancel_swap') { await clearState(userId); await showMainMenu(userId, chatId); return; }

  /* ── Deposit ── */
  if (data === 'deposit') { await showDepositMenu(userId, chatId); return; }
  if (data === 'deposit_ton') { await showDepositTon(userId, chatId); return; }
  if (data === 'deposit_atf') { await showDepositAtf(userId, chatId); return; }
  if (data === 'check_deposit_ton') { await checkDepositStatus(userId, chatId, 'TON'); return; }
  if (data === 'check_deposit_atf') { await checkDepositStatus(userId, chatId, 'ATF'); return; }

  /* ── Withdraw ── */
  if (data === 'withdraw') { await showWithdrawMenu(userId, chatId); return; }
  if (data === 'withdraw_ton') { await startWithdrawal(userId, chatId, 'TON'); return; }
  if (data === 'withdraw_atf') { await startWithdrawal(userId, chatId, 'ATF'); return; }
  if (data === 'confirm_withdrawal') { await executeWithdrawal(userId, chatId); return; }
  if (data === 'cancel_withdrawal') { await clearState(userId); await showMainMenu(userId, chatId); return; }

  /* ── Account & Wallets ── */
  if (data === 'account') { await showAccount(userId, chatId); return; }
  if (data === 'export_wallet') { await showExportWarning(userId, chatId); return; }
  if (data === 'export_confirm') { await exportWallet(userId, chatId); return; }
  if (data === 'import_wallet') { await startImportWallet(userId, chatId); return; }

  /* 🔑 Wallet Version Selection — matches keyboard callback_data */
  if (data === 'import_version_auto') { await handleImportVersionSelect(userId, chatId, 'auto'); return; }
  if (data === 'import_version_v4') {
    if (user.state === 'import_version_confirm') {
      await handleImportVersionConfirm(userId, chatId, 'v4r2');
    } else {
      await handleImportVersionSelect(userId, chatId, 'v4r2');
    }
    return;
  }
  if (data === 'import_version_v5') {
    if (user.state === 'import_version_confirm') {
      await handleImportVersionConfirm(userId, chatId, 'v5r1');
    } else {
      await handleImportVersionSelect(userId, chatId, 'v5r1');
    }
    return;
  }

  if (data === 'my_wallets') { await showWalletList(userId, chatId); return; }
  if (data === 'create_wallet') { await createNewWallet(userId, chatId); return; }
  if (data.startsWith('switch_wallet_')) {
    await switchWallet(userId, chatId, data.replace('switch_wallet_', ''));
    return;
  }

  /* ── History ── */
  if (data === 'history') { await showHistory(userId, chatId, 1); return; }
  if (data.startsWith('history_page_')) {
    await showHistory(userId, chatId, parseInt(data.split('_')[2], 10));
    return;
  }

  /* ── Prices / Help / Referral ── */
  if (data === 'prices') { await showPrices(userId, chatId); return; }
  if (data === 'help') { await showHelp(userId, chatId); return; }
  if (data === 'referral') { await showReferral(userId, chatId); return; }

  /* ── Admin Callbacks ── */
  if (data === 'admin_panel') { await showAdminPanel(userId, chatId); return; }
  if (data === 'admin_management') { await showAdminManagement(userId, chatId); return; }
  if (data === 'admin_give') { await startGiveAdmin(userId, chatId); return; }
  if (data === 'admin_remove') { await startRemoveAdmin(userId, chatId); return; }
  if (data === 'admin_list') { await showAdminList(userId, chatId); return; }
  if (data === 'admin_users') { await showUserList(userId, chatId, 1); return; }
  if (data.startsWith('admin_users_page_')) {
    await showUserList(userId, chatId, parseInt(data.split('_')[3], 10));
    return;
  }
  if (data.startsWith('admin_user_')) {
    await showUserDetail(userId, chatId, parseInt(data.replace('admin_user_', ''), 10));
    return;
  }
  if (data.startsWith('admin_freeze_')) {
    const parts = data.split('_');
    await toggleFreeze(userId, chatId, parseInt(parts[2], 10), parts[3] as 'freeze' | 'unfreeze');
    return;
  }
  if (data.startsWith('admin_balance_')) {
    await showAdminUserBalance(userId, chatId, parseInt(data.split('_')[2], 10));
    return;
  }
  if (data.startsWith('admin_tx_')) {
    await showAdminUserTransactions(userId, chatId, parseInt(data.split('_')[2], 10));
    return;
  }
  if (data === 'admin_audit') { await showAuditLogs(userId, chatId); return; }
  if (data === 'admin_settings') { await showSystemSettings(userId, chatId); return; }
  if (data === 'admin_transactions') { await showAdminTransactions(userId, chatId, 1); return; }
  if (data.startsWith('admin_transactions_page_')) {
    await showAdminTransactions(userId, chatId, parseInt(data.split('_')[3], 10));
    return;
  }
  if (data === 'admin_deposits') { await showAdminDeposits(userId, chatId, 1); return; }
  if (data.startsWith('admin_deposits_page_')) {
    await showAdminDeposits(userId, chatId, parseInt(data.split('_')[3], 10));
    return;
  }
  if (data === 'admin_withdrawals') { await showAdminWithdrawals(userId, chatId, 1); return; }
  if (data.startsWith('admin_withdrawals_page_')) {
    await showAdminWithdrawals(userId, chatId, parseInt(data.split('_')[3], 10));
    return;
  }
  if (data === 'admin_swaps') { await showAdminSwaps(userId, chatId, 1); return; }
  if (data.startsWith('admin_swaps_page_')) {
    await showAdminSwaps(userId, chatId, parseInt(data.split('_')[3], 10));
    return;
  }
  if (data === 'admin_token') { await showAdminTokenConfig(userId, chatId); return; }
  if (data === 'admin_dex') { await showAdminDexConfig(userId, chatId); return; }
  if (data === 'admin_fees') { await showAdminFeeConfig(userId, chatId); return; }
  if (data === 'admin_prices') { await showAdminPriceProviders(userId, chatId); return; }
  if (data === 'admin_stats') { await handleStats(userId, chatId); return; }
  if (data === 'admin_broadcast') { await startBroadcast(userId, chatId); return; }
}

/* ───────────────────────────────────────────────────────────────────────────
   📝 TEXT INPUT HANDLER
   ─────────────────────────────────────────────────────────────────────────── */
async function delUserMsg(chatId: number, messageId: number): Promise<void> {
  try { await botInstance.deleteMessage(chatId, messageId); } catch {}
}

export async function handleText(msg: TelegramBot.Message): Promise<void> {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (!userId) return;

  await delUserMsg(chatId, msg.message_id);

  /* Explicit /start handler */
  if (text === '/start') {
    await handleStart(msg);
    return;
  }

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

  if (user.state === 'broadcast_input') {
    await handleBroadcast(userId, chatId, text);
    return;
  }

  /* Fallback: unknown text → main menu */
  await showMainMenu(userId, chatId);
                                                                   }
    
