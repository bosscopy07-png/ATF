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

/* ─────────────────────────────────────────────────────────────────────────── 🔧 SERVICE INSTANCES ─────────────────────────────────────────────────────────────────────────── */
const swapService = new SwapService();
const withdrawalService = new WithdrawalService();
const walletService = new WalletService();
const priceService = PriceService.getInstance();

function marketMovement(price: any): string {
  const change = Number(price?.change24hPercent);
  if (!Number.isFinite(change)) return '24h · —';
  const sign = change > 0 ? '+' : '';
  const icon = change > 0 ? '↗' : change < 0 ? '↘' : '→';
  return `24h ${icon} ${sign}${change.toFixed(2)}%`;
}

function sourceLabel(price: any): string {
  const source = String(price?.source || 'market');
  try { return new URL(source).hostname.replace(/^www\./, ''); } catch { return source.slice(0, 28); }
}

function terminalHeader(title: string, subtitle?: string): string {
  return [
    `◈ <b>ATF NEXUS</b> · <b>${title}</b>`,
    subtitle ? `<i>${subtitle}</i>` : '',
    `━━━━━━━━━━━━━━━━━━━━`,
  ].filter(Boolean).join('\n');
}

let botInstance: TelegramBot;

export function setBot(bot: TelegramBot): void {
  botInstance = bot;
}

/* ─────────────────────────────────────────────────────────────────────────── 🎨 STRICT SINGLE-MESSAGE RENDER ENGINE ─────────────────────────────────────────────────────────────────────────── Policy: exactly ONE bot message per chat. • Photo exists → edit caption + keyboard. • Text exists → delete it, send a photo (one-time migration). • Nothing exists→ send a photo. Cross-chat alerts (referrals / broadcasts) are the only exception. ─────────────────────────────────────────────────────────────────────────── */
async function render( userId: number, chatId: number, text: string, keyboard: any, opts?: { withImage?: boolean } ): Promise<void> {
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

/* ─────────────────────────────────────────────────────────────────────────── 👤 USER LIFECYCLE ─────────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────── 💼 WALLET HELPERS ─────────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────── 🔄 RESTORE LAST ACTION ─────────────────────────────────────────────────────────────────────────── */
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
  /* ─────────────────────────────────────────────────────────────────────────── 🏠 MAIN MENU ─────────────────────────────────────────────────────────────────────────── */
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
    } catch { /* preserve zero fallback */ }
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

  const caption = [
    terminalHeader('PORTFOLIO', 'Your assets, market value and live pricing'),
    ``,
    `💼 <b>Total Portfolio</b>`,
    `<code>$${totalUsd}</code>${totalNgn ? ` · <code>₦${totalNgn}</code>` : ''}`,
    ``,
    `💎 <b>TON</b> <code>${Precision.formatDisplay(tonBalance)}</code>`,
    tonUsd ? ` ≈ $${tonUsd} · ${marketMovement(tonPrice)}` : ` Market unavailable`,
    ``,
    `🔷 <b>ATF</b> <code>${Precision.formatDisplay(atfBalance)}</code>`,
    atfUsd ? ` ≈ $${atfUsd} · ${marketMovement(atfPrice)}` : ` Market unavailable`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `◉ <b>MARKET</b>`,
    tonPrice ? `TON <code>$${tonPrice.price.toFixed(2)}</code> · ${marketMovement(tonPrice)}` : `TON <i>unavailable</i>`,
    atfPrice ? `ATF <code>$${atfPrice.price.toFixed(6)}</code> · ${marketMovement(atfPrice)}` : `ATF <i>unavailable</i>`,
    ngnRate ? `USD <code>₦${ngnRate.price.toFixed(2)}</code>` : '',
    ``,
    wallet ? `◉ Wallet <code>${formatAddressShort(wallet.address)}</code>` : `⚠ Wallet unavailable`,
    wallet?.walletVersion ? `Network <code>TON · ${wallet.walletVersion.toUpperCase()}</code>` : '',
  ].filter(Boolean).join('\n');

  await render(userId, chatId, caption, keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin), { withImage: true });
}

/* ─────────────────────────────────────────────────────────────────────────── 🔄 SWAP FLOW ─────────────────────────────────────────────────────────────────────────── */
async function showSwapPair(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.lastAction = 'swap';
    await user.save();
  }

  const [tonPrice, atfPrice] = await Promise.all([
    priceService.getTonPriceUsd().catch(() => null),
    priceService.getAtfPriceUsd().catch(() => null),
  ]);

  await render(userId, chatId, [
    terminalHeader('SWAP', 'Instant TON ↔ ATF conversion'),
    ``,
    `Choose a trading pair below.`,
    ``,
    tonPrice ? `💎 TON <code>$${tonPrice.price.toFixed(2)}</code> · ${marketMovement(tonPrice)}` : `💎 TON <i>price unavailable</i>`,
    atfPrice ? `🔷 ATF <code>$${atfPrice.price.toFixed(6)}</code> · ${marketMovement(atfPrice)}` : `🔷 ATF <i>price unavailable</i>`,
    ``,
    `⚡ <i>Quote is locked during confirmation.</i>`,
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
    await render(userId, chatId, caption, keyboards.backKeyboard('back_main'), { withImage: true });
  } catch (error: any) {
    await toast(userId, chatId, `❌ <b>Swap Failed</b>\n\n${error.message}`, keyboards.backKeyboard('swap'));
  }
               }
      /* ─────────────────────────────────────────────────────────────────────────── 📥 DEPOSIT FLOW ─────────────────────────────
