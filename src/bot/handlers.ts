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

// ── PHASE 1 addition: portfolio ──
import { PortfolioService } from '../services/portfolio-service';

// ── PHASE 2 addition: token registry / multi-token swap ──
import { TokenRegistry } from '../services/token-registry';

// ── PHASE 4 addition: transfer relay ──
import { TransferRelayService, RelayQuote } from '../services/transfer-relay-service';

// ── Premium emoji layer (message text/captions only) ──
import {
  buildPremiumEmojiEntities,
  premiumEmojiOptions,
} from './premium-emoji';

/* ───────────────────────────────────────────────────────────────────────────
   🔧 SERVICE INSTANCES
─────────────────────────────────────────────────────────────────────────── */

const swapService = new SwapService();
const withdrawalService = new WithdrawalService();
const walletService = new WalletService();
const priceService = PriceService.getInstance();

// ── PHASE 1 addition ──
const portfolioService = new PortfolioService();

// ── PHASE 4 addition ──
const relayService = new TransferRelayService();

const WALLET_BALANCE_TIMEOUT_MS = 8_000;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

/* ── 💰 Price display helpers ── */

const fmtMoney = (v: string, dp = 2): string =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const cleanSource = (p: any): string => String(p?.source ?? '').replace(' (stale)', '');

const isStale = (p: any): boolean => typeof p?.source === 'string' && p.source.includes('(stale)');

function movementLine(p: any): string {
  if (!p) return '⚪ —';
  if (isStale(p)) return '⏳ cached';
  const c = p.change24hPercent ?? null;
  if (c === null || !Number.isFinite(c)) return '⚪ —';
  return `${c > 0 ? '🟢' : c < 0 ? '🔴' : '⚪'} ${c > 0 ? '+' : ''}${c.toFixed(2)}%`;
}

function sourceBadge(p: any): string {
  const name = sourceLabel({ ...p, source: cleanSource(p) });
  return `<i>${name}${isStale(p) ? ' · ⏳ stale' : ''}</i>`;
}

function marketMovement(price: any): string {
  const change = Number(price?.change24hPercent);
  if (!Number.isFinite(change)) return '24h · —';
  const sign = change > 0 ? '+' : '';
  const icon = change > 0 ? '↗' : change < 0 ? '↘' : '→';
  return `24h ${icon} ${sign}${change.toFixed(2)}%`;
}

function sourceLabel(price: any): string {
  const source = String(price?.source || 'market');
  try {
    return new URL(source).hostname.replace(/^www\./, '');
  } catch {
    return source.slice(0, 28);
  }
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

/* ───────────────────────────────────────────────────────────────────────────
   🎨 STRICT SINGLE-MESSAGE RENDER ENGINE
───────────────────────────────────────────────────────────────────────────
   Policy: exactly ONE bot message per chat.
   • Photo exists → edit caption + keyboard.
   • Text exists → delete it, send a photo (one-time migration).
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

  // ── Premium emoji upgrade: compute once, reuse for every send/edit branch.
  //    Empty array => fields omitted => requests identical to pre-upgrade. ──
  const premiumEntities = buildPremiumEmojiEntities(text);
  const textEntities =
    premiumEntities.length > 0 ? { entities: premiumEntities } : {};
  const captionEntities =
    premiumEntities.length > 0 ? { caption_entities: premiumEntities } : {};

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
          ...captionEntities,
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
          ...textEntities,
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
      ...captionEntities,
    });
    await saveRef(sent, true);
  } else {
    const sent = await botInstance.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true,
      ...textEntities,
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
          const referralText = `🎉 <b>New Referral!</b>\n\nUser <code>${telegramId}</code> joined using your link.`;
          await botInstance.sendMessage(referrerId, referralText, {
            parse_mode: 'HTML',
            ...premiumEmojiOptions(referralText),
          });
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
    // ── PHASE 1/4 additions ──
    case 'portfolio': await showPortfolio(userId, chatId, 1); break;
    case 'transfer_relay': await showRelayHome(userId, chatId, user); break;
    default: await showMainMenu(userId, chatId);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   🏠 MAIN MENU
─────────────────────────────────────────────────────────────────────────── */

export async function showMainMenu(userId: number, chatId: number): Promise<void> {
  const [user, wallet] = await Promise.all([
    User.findOne({ telegramId: userId }),
    getActiveWallet(userId),
  ]);
  if (!user) return;

  if (user.lastAction !== 'main_menu') {
    await User.updateOne({ _id: user._id }, { $set: { lastAction: 'main_menu' } }).catch(() => {});
  }

  const balancePromise = wallet?.address
    ? withTimeout(walletService.getBalance(wallet.address), WALLET_BALANCE_TIMEOUT_MS)
    : Promise.resolve(null);

  const [onChain, [atfPrice, tonPrice, ngnRate]] = await Promise.all([
    balancePromise.catch(() => null),
    Promise.all([
      priceService.getAtfPriceUsd().catch(() => null),
      priceService.getTonPriceUsd().catch(() => null),
      priceService.getUsdNgnRate().catch(() => null),
    ]),
  ]);

  const tonBalance = onChain ? Precision.fromBaseUnits(onChain.ton, TON_DECIMALS) : null;
  const atfBalance = onChain ? Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS) : null;

  const tonUsd = tonBalance !== null && tonPrice ? priceService.convertCryptoToUsd(tonBalance, tonPrice.price, TON_DECIMALS) : null;
  const atfUsd = atfBalance !== null && atfPrice ? priceService.convertCryptoToUsd(atfBalance, atfPrice.price, ATF_DECIMALS) : null;

  const totalUsd = tonUsd !== null || atfUsd !== null
    ? (parseFloat(tonUsd ?? '0') + parseFloat(atfUsd ?? '0')).toFixed(2)
    : null;
  const totalNgn = totalUsd !== null && ngnRate ? priceService.convertUsdToNgn(totalUsd, ngnRate.price) : null;

  const assetBlock = (emoji: string, symbol: string, balance: string | null, usd: string | null, price: any): string[] => {
    if (balance === null) return [`${emoji} <b>${symbol}</b> <i>⏳ unavailable</i>`];
    return [
      `${emoji} <b>${symbol}</b> <code>${Precision.formatDisplay(balance)}</code>`,
      `   ├ 💵 <code>$${fmtMoney(usd ?? '0')}</code>`,
      `   └ 📊 ${movementLine(price)}`,
    ];
  };

  const caption = [
    terminalHeader('PORTFOLIO', '💼 your assets · 💵 live value · 📊 24h movement'),
    '',
    `💼 <b>Total Portfolio</b>`,
    totalUsd !== null
      ? `💵 <code>$${fmtMoney(totalUsd)}</code>${totalNgn ? `  🇳🇬 <code>₦${fmtMoney(totalNgn, 0)}</code>` : ''}`
      : `<i>⏳ unavailable</i>`,
    '',
    ...assetBlock('💎', 'TON', tonBalance, tonUsd, tonPrice),
    '',
    ...assetBlock('🔷', 'ATF', atfBalance, atfUsd, atfPrice),
    '',
    `━━━━━━━━━━━━━━━━━━━━`,
    `◉ <b>MARKET</b>`,
    tonPrice ? `💎 TON <code>$${tonPrice.price.toFixed(2)}</code> · ${movementLine(tonPrice)}` : `💎 TON <i>⏳ unavailable</i>`,
    atfPrice ? `🔷 ATF <code>$${atfPrice.price.toFixed(6)}</code> · ${movementLine(atfPrice)}` : `🔷 ATF <i>⏳ unavailable</i>`,
    ngnRate ? `🇳🇬 USD/NGN <code>₦${ngnRate.price.toFixed(2)}</code>` : '',
    '',
    wallet
      ? `◉ 🗝 Wallet <code>${formatAddressShort(wallet.address)}</code>${wallet.walletVersion ? ` · <code>${wallet.walletVersion.toUpperCase()}</code>` : ''}`
      : `⚠️ No active wallet — tap ▣ Wallet to create or import one`,
  ].filter(Boolean).join('\n');

  await render(userId, chatId, caption, keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin), { withImage: true });
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

/* ═══════════════════════════════════════════════════════════
   PHASE 2 — MULTI-TOKEN SWAP UI
   ═══════════════════════════════════════════════════════════ */

const PAGE_SIZE_TOKENS = 8;

async function showTokenList(userId: number, chatId: number, direction: string, page: number): Promise<void> {
  if (!config.features.multiTokenSwap) {
    await toast(userId, chatId, '⏳ <i>Coming soon.</i>', keyboards.tokenSearchKeyboard());
    return;
  }

  try {
    // List first page of tradeable tokens (empty query = browse)
    const { items, total } = await TokenRegistry.search('', page, PAGE_SIZE_TOKENS);

    await toast(userId, chatId,
      [
        terminalHeader('SELECT TOKEN'),
        `Page ${page} · ${total} token(s)`,
        ``,
        `<i>Only verified &amp; community tokens with executable routes are listed.</i>`,
      ].join('\n'),
      keyboards.tokenListKeyboard(
        items.map((t) => ({ masterAddress: t.masterAddress, symbol: t.symbol })),
        page,
        page * PAGE_SIZE_TOKENS < total,
        direction
      ));
  } catch (err: any) {
    await toast(userId, chatId,
      `❌ <i>Token list unavailable: ${String(err.message).slice(0, 200)}</i>`,
      keyboards.tokenSearchKeyboard());
  }
}

async function handleTokenSearchInput(userId: number, chatId: number, user: any, text: string): Promise<void> {
  const direction = user.stateData?.direction ?? 'ton_to_token';

  if (!config.features.multiTokenSwap) {
    await toast(userId, chatId, '⏳ <i>Coming soon.</i>', keyboards.tokenSearchKeyboard());
    return;
  }

  const query = text.trim().slice(0, 60);
  if (!query) {
    await toast(userId, chatId,
      `${terminalHeader('TOKEN SEARCH')}\nType the token <b>name</b>, <b>symbol</b>, or exact <b>contract address</b>.`,
      keyboards.tokenSearchKeyboard());
    return;
  }

  try {
    const { items, total } = await TokenRegistry.search(query, 1, PAGE_SIZE_TOKENS);

    if (!total) {
      await toast(userId, chatId,
        `${terminalHeader('TOKEN SEARCH')}\n❌ No supported token or route found for <b>${query.slice(0, 40)}</b>.\n\n<i>Search by name, symbol, or exact contract address.</i>`,
        keyboards.tokenSearchKeyboard());
      return;
    }

    await toast(userId, chatId,
      `${terminalHeader('TOKEN SEARCH')}\n${total} result(s) for <b>${query.slice(0, 40)}</b>:`,
      keyboards.tokenListKeyboard(
        items.map((t) => ({ masterAddress: t.masterAddress, symbol: t.symbol })),
        1,
        total > PAGE_SIZE_TOKENS,
        direction
      ));
  } catch (err: any) {
    await toast(userId, chatId,
      `❌ <i>Search failed: ${String(err.message).slice(0, 200)}</i>`,
      keyboards.tokenSearchKeyboard());
  }
}

async function startTokenSwapInput(userId: number, chatId: number, direction: string, master: string): Promise<void> {
  if (!config.features.multiTokenSwap) {
    await toast(userId, chatId, '⏳ <i>Coming soon.</i>', keyboards.tokenSearchKeyboard());
    return;
  }

  const token = await TokenRegistry.resolve(master);
  if (!token) {
    await toast(userId, chatId,
      `${terminalHeader('SWAP')}\n❌ <i>Token unavailable, unverified, or route unsupported.</i>`,
      keyboards.tokenSearchKeyboard());
    return;
  }

  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.state = 'swap_token_amount';
  user.stateData = {
    direction,
    tokenMaster: token.masterAddress,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
  };
  await user.save();

  const inputName = direction === 'ton_to_token' ? 'TON' : token.symbol;

  await toast(userId, chatId,
    [
      terminalHeader('SWAP'),
      `💱 <b>${direction === 'ton_to_token' ? 'TON → ' + token.symbol : token.symbol + ' → TON'}</b>`,
      ``,
      `Enter the amount of <b>${inputName}</b> to swap:`,
    ].join('\n'),
    keyboards.cancelKeyboard('swap'));
}

async function handleTokenSwapAmount(userId: number, chatId: number, user: any, text: string): Promise<void> {
  const { direction, tokenMaster, tokenSymbol, tokenDecimals } = user.stateData || {};
  if (!direction || !tokenMaster) { await showMainMenu(userId, chatId); return; }

  const amount = text.trim();
  if (!isValidAmount(amount) || Number(amount) <= 0) {
    await toast(userId, chatId,
      `${terminalHeader('SWAP')}\n❌ <i>Invalid amount. Enter a positive number.</i>`,
      keyboards.cancelKeyboard('swap'));
    return;
  }

  let confirmation: any;
  try {
    confirmation = await swapService.prepareTokenSwap(
      userId, direction, tokenMaster, tokenDecimals, amount
    );
  } catch (err: any) {
    await toast(userId, chatId,
      `${terminalHeader('SWAP')}\n❌ <i>${String(err.message).slice(0, 300)}</i>`,
      keyboards.tokenSearchKeyboard());
    return;
  }

  user.state = 'swap_token_confirm';
  user.stateData = { ...user.stateData, confirmation };
  await user.save();

  const fp = confirmation.feePlan;
  const inputSymbol = direction === 'ton_to_token' ? 'TON' : tokenSymbol;
  const outputSymbol = direction === 'ton_to_token' ? tokenSymbol : 'TON';

  const feeLines: string[] = [];
  if (fp.platformFeeInputBase && fp.platformFeeInputBase !== '0') {
    feeLines.push(
      `🧾 Platform fee (${fp.platformPercent}%): <code>${confirmation.platformFee}</code> ${inputSymbol} <i>(from input)</i>`
    );
  } else {
    feeLines.push(
      `🧾 Platform fee (${fp.platformPercent}%): <code>${Precision.fromBaseUnits(BigInt(fp.platformFeeOutputBase), tokenDecimals)}</code> ${outputSymbol} <i>(from output)</i>`
    );
  }
  if (fp.tonOutputFeeBase && fp.tonOutputFeeBase !== '0') {
    feeLines.push(
      `🧾 TON output fee (${config.feePolicy.tokenToTonOutputPercent}%): <code>${Precision.fromBaseUnits(BigInt(fp.tonOutputFeeBase), TON_DECIMALS)}</code> TON`
    );
  }

  await toast(userId, chatId,
    [
      terminalHeader('CONFIRM SWAP'),
      `💱 <b>${inputSymbol} → ${outputSymbol}</b>`,
      ``,
      `You send: <code>${confirmation.inputAmount}</code> ${inputSymbol}`,
      ...feeLines,
      `Minimum received: <code>${confirmation.minOutput}</code> ${outputSymbol}`,
      `Expected received: <code>${confirmation.expectedOutput}</code> ${outputSymbol}`,
      `DEX costs: <code>${confirmation.dexCosts}</code> TON`,
      ``,
      `<i>Quote valid until ${new Date(confirmation.expiresAt).toLocaleTimeString()}. Quote and balances are revalidated before execution.</i>`,
    ].join('\n'),
    { inline_keyboard: [
      [{ text: '✅ Confirm Swap', callback_data: 'confirm_token_swap' }],
      [{ text: '❌ Cancel', callback_data: 'swap' }],
    ] });
}

async function executeTokenSwap(userId: number, chatId: number, user: any): Promise<void> {
  const st = user.stateData || {};
  const { confirmation, tokenDecimals } = st;

  if (!config.features.multiTokenSwap || !confirmation) {
    await showMainMenu(userId, chatId);
    return;
  }

  // Single-use confirmation: clear state BEFORE executing so a replayed
  // callback can never trigger a second path even if idempotency is bypassed.
  user.state = 'idle';
  user.stateData = {};
  await user.save();

  await render(userId, chatId,
    `🔄 <b>Executing Swap...</b>\n\nBroadcasting to TON blockchain ⛓️`,
    { inline_keyboard: [] }, { withImage: true });

  try {
    const txId = await swapService.executeTokenSwap(userId, confirmation, tokenDecimals);
    const txRecord = await Transaction.findById(txId);
    const txHash = txRecord?.txHash || '';
    const link = explorerLink(txHash);

    await render(userId, chatId,
      [
        `✅ <b>Swap Submitted</b>`,
        ``,
        `<b>Sent:</b> ${confirmation.inputAmount}`,
        `<b>Expected receive:</b> ${confirmation.expectedOutput}`,
        link ? `🔗 <a href="${link}">View on Explorer</a>` : '',
        ``,
        `<i>Track final status in ◷ Activity.</i>`,
      ].filter(Boolean).join('\n'),
      keyboards.backKeyboard('back_main'), { withImage: true });
  } catch (err: any) {
    await toast(userId, chatId,
      `❌ <b>Swap Failed</b>\n\n<i>${String(err.message).slice(0, 300)}</i>`,
      keyboards.tokenSearchKeyboard());
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

  const wallet = await getActiveWallet(userId);

  const caption = [
    `📥 <b>DEPOSIT</b>`,
    ``,
    `Select asset to fund your account.`,
    ``,
    wallet
      ? `⛓ Your Address: <code>${wallet.address}</code>`
      : `⚠️ No active wallet — tap ▣ Wallet first`,
  ].filter(Boolean).join('\n');

  await render(userId, chatId, caption, keyboards.depositKeyboard(), { withImage: true });
}

async function showDepositTon(userId: number, chatId: number): Promise<void> {
  const wallet = await getActiveWallet(userId);
  if (!wallet) {
    await toast(userId, chatId, '⚠️ No active wallet. Create one first.', keyboards.depositKeyboard());
    return;
  }

  await render(userId, chatId, [
    `💎 <b>DEPOSIT TON</b>`,
    ``,
    `Send TON to your address:`,
    `<code>${wallet.address}</code>`,
    ``,
    `<i>Minimum: any amount above network fee.</i>`,
    `<i>Deposits are credited automatically (~30s).</i>`,
  ].join('\n'), keyboards.depositTonScreen(wallet.address), { withImage: true });
}

async function showDepositAtf(userId: number, chatId: number): Promise<void> {
  const wallet = await getActiveWallet(userId);
  if (!wallet) {
    await toast(userId, chatId, '⚠️ No active wallet. Create one first.', keyboards.depositKeyboard());
    return;
  }

  await render(userId, chatId, [
    `🔷 <b>DEPOSIT ATF</b>`,
    ``,
    `Send ATF to your address:`,
    `<code>${wallet.address}</code>`,
    ``,
    `<i>Jetton deposits are detected automatically.</i>`,
  ].join('\n'), keyboards.depositAtfScreen(), { withImage: true });
}

async function checkDepositStatus(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  const wallet = await getActiveWallet(userId);
  if (!wallet?.address) {
    await toast(userId, chatId, '⚠️ No active wallet.', keyboards.depositKeyboard());
    return;
  }

  await toast(userId, chatId, `🔍 <b>Checking ${asset} deposits...</b>\n\n<i>This scans recent blockchain activity. Large deposits may take a moment.</i>`, keyboards.backKeyboard('deposit'));

  try {
    const { BlockchainMonitor } = await import('../services/blockchain-monitor');
    const monitor = new BlockchainMonitor();
    const found = await monitor.scanAddressForDeposits(wallet.address, asset);

    if (found && found.length > 0) {
      const lines = found.map((d: any) => `✅ <code>${Precision.fromBaseUnits(BigInt(d.amount), d.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS)} ${d.asset}</code> credited`);
      await toast(userId, chatId, [`📥 <b>DEPOSITS FOUND</b>`, ``, ...lines].join('\n'), keyboards.backKeyboard('deposit'));
    } else {
      await toast(userId, chatId, [`⏳ <b>NO NEW DEPOSITS</b>`, ``, `<i>If you already sent funds, wait 1–2 minutes and check again.</i>`].join('\n'), keyboards.backKeyboard('deposit'));
    }
  } catch (err: any) {
    await toast(userId, chatId, `❌ ${err.message}`, keyboards.backKeyboard('deposit'));
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
    `Select asset to withdraw.`,
    ``,
    `<i>Network gas applies. Double-check your address.</i>`,
  ].join('\n'), keyboards.withdrawAssetKeyboard(), { withImage: true });
}

async function startWithdrawal(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const wallet = await getActiveWallet(userId);
  let balance = '0';
  if (wallet?.address) {
    try {
      const onChain = await walletService.getBalance(wallet.address);
      const raw = asset === 'TON' ? onChain.ton : onChain.atf;
      balance = Precision.fromBaseUnits(raw, asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
    } catch { /* ignore */ }
  }

  user.state = `withdraw_address_${asset.toLowerCase()}`;
  user.stateData = { asset, balance };
  await user.save();

  await render(userId, chatId, [
    `📤 <b>WITHDRAW ${asset}</b>`,
    ``,
    `Available: <code>${Precision.formatDisplay(balance)} ${asset}</code>`,
    ``,
    `Enter the destination TON address:`,
  ].join('\n'), keyboards.cancelKeyboard('withdraw'), { withImage: true });
}

async function handleWithdrawAddress(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('withdraw_address_')) return;

  const asset = user.state.replace('withdraw_address_', '').toUpperCase() as 'TON' | 'ATF';

  if (!isValidTonAddress(text.trim())) {
    await toast(userId, chatId, '❌ Invalid TON address. Try again.', keyboards.cancelKeyboard('withdraw'));
    return;
  }

  user.state = `withdraw_amount_${asset.toLowerCase()}`;
  user.stateData = { ...user.stateData, address: text.trim() };
  await user.save();

  await render(userId, chatId, [
    `📤 <b>WITHDRAW ${asset}</b>`,
    ``,
    `To: <code>${formatAddressShort(text.trim())}</code>`,
    `Available: <code>${Precision.formatDisplay(user.stateData.balance)} ${asset}</code>`,
    ``,
    `Enter amount to withdraw:`,
  ].join('\n'), keyboards.cancelKeyboard('withdraw'), { withImage: true });
}

async function handleWithdrawAmount(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('withdraw_amount_')) return;

  const asset = user.state.replace('withdraw_amount_', '').toUpperCase() as 'TON' | 'ATF';
  const { address, balance } = user.stateData;

  if (!isValidAmount(text)) {
    await toast(userId, chatId, '❌ Invalid amount.', keyboards.cancelKeyboard('withdraw'));
    return;
  }

  const decimals = asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS;
  const amountBase = Precision.toBaseUnits(text.trim(), decimals);
  const balanceBase = Precision.toBaseUnits(balance, decimals);

  if (amountBase <= 0n || amountBase > balanceBase) {
    await toast(userId, chatId, `❌ Amount exceeds balance. Max: ${Precision.formatDisplay(balance)} ${asset}`, keyboards.cancelKeyboard('withdraw'));
    return;
  }

  // Preview network fee
  let feeDisplay = 'network gas';
  try {
    const fee = await withdrawalService.estimateFee(asset, amountBase);
    feeDisplay = `${Precision.formatDisplay(Precision.fromBaseUnits(fee, TON_DECIMALS))} TON`;
  } catch { /* keep default */ }

  user.state = `withdraw_confirm_${asset.toLowerCase()}`;
  user.stateData = { ...user.stateData, amount: text.trim(), feeDisplay };
  await user.save();

  await render(userId, chatId, [
    `📋 <b>CONFIRM WITHDRAWAL</b>`,
    ``,
    `Asset: <b>${asset}</b>`,
    `Amount: <code>${Precision.formatDisplay(text.trim())} ${asset}</code>`,
    `To: <code>${formatAddressShort(address)}</code>`,
    `Network Fee: <code>${feeDisplay}</code>`,
    ``,
    `<i>Verify the address carefully. Transactions cannot be reversed.</i>`,
  ].join('\n'), keyboards.confirmWithdrawalKeyboard(), { withImage: true });
}

async function executeWithdrawal(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('withdraw_confirm_')) {
    await showMainMenu(userId, chatId);
    return;
  }

  const asset = user.state.replace('withdraw_confirm_', '').toUpperCase() as 'TON' | 'ATF';
  const { address, amount } = user.stateData;

  await render(userId, chatId, `📤 <b>Processing Withdrawal...</b>\n\nBroadcasting to TON blockchain ⛓️`, { inline_keyboard: [] }, { withImage: true });

  try {
    const txHash = await withdrawalService.withdraw(userId, asset, address, amount);

    await AdminAction.create({
      adminId: userId,
      action: 'WITHDRAWAL_COMPLETED',
      target: userId.toString(),
      result: 'success',
      metadata: { asset, amount, address, txHash },
    }).catch(() => {});

    const link = explorerLink(txHash);

    await clearState(userId);
    await render(userId, chatId, [
      `✅ <b>Withdrawal Sent</b>`,
      ``,
      `Asset: <b>${asset}</b>`,
      `Amount: <code>${Precision.formatDisplay(amount)}</code>`,
      `To: <code>${formatAddressShort(address)}</code>`,
      link ? `🔗 <a href="${link}">View on Explorer</a>` : '',
      ``,
      `<i>Arrives after blockchain confirmation.</i>`,
    ].filter(Boolean).join('\n'), keyboards.backKeyboard('back_main'), { withImage: true });
  } catch (error: any) {
    await toast(userId, chatId, `❌ <b>Withdrawal Failed</b>\n\n${error.message}`, keyboards.backKeyboard('withdraw'));
  }
}
/* ───────────────────────────────────────────────────────────────────────────
   ▣ ACCOUNT & WALLET MANAGEMENT
   ─────────────────────────────────────────────────────────────────────────── */

async function showAccount(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.lastAction = 'account';
    await user.save();
  }

  const wallets = await getUserWallets(userId);
  const active = await getActiveWallet(userId);

  let tonBalance = '0';
  let atfBalance = '0';
  if (active?.address) {
    try {
      const onChain = await walletService.getBalance(active.address);
      tonBalance = Precision.fromBaseUnits(onChain.ton, TON_DECIMALS);
      atfBalance = Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS);
    } catch { /* ignore */ }
  }

  await render(userId, chatId, [
    `▣ <b>WALLET</b>`,
    ``,
    `Active: <code>${active ? formatAddressShort(active.address) : 'none'}</code>`,
    ``,
    `💎 TON: <code>${Precision.formatDisplay(tonBalance)}</code>`,
    `🔷 ATF: <code>${Precision.formatDisplay(atfBalance)}</code>`,
    ``,
    `Wallets: <b>${wallets.length}</b>`,
  ].join('\n'), keyboards.accountKeyboard(), { withImage: true });
}

async function showMyWallets(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const wallets = await getUserWallets(userId);
  const activeId = user.activeWalletId?.toString() || '';

  await render(userId, chatId, [
    `▣ <b>MY WALLETS</b>`,
    ``,
    `<i>Tap to switch active wallet.</i>`,
  ].join('\n'), keyboards.walletListKeyboard(wallets, activeId), { withImage: true });
}

async function switchWallet(userId: number, chatId: number, walletId: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const wallet = await Wallet.findById(walletId);
  if (!wallet || !user.walletIds.map((id: any) => id.toString()).includes(walletId)) {
    await toast(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('my_wallets'));
    return;
  }

  user.activeWalletId = wallet._id;
  await user.save();

  await toast(userId, chatId, `✅ Switched to <code>${formatAddressShort(wallet.address)}</code>`, keyboards.backKeyboard('account'));
}

async function createNewWallet(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const wallet = await walletService.createWallet(userId);
  if (!wallet) {
    await toast(userId, chatId, '❌ Failed to create wallet.', keyboards.backKeyboard('my_wallets'));
    return;
  }

  user.walletIds.push(wallet._id);
  user.activeWalletId = wallet._id;
  await user.save();

  await toast(userId, chatId, [
    `✅ <b>New Wallet Created</b>`,
    ``,
    `Address: <code>${wallet.address}</code>`,
    ``,
    `<i>It is now your active wallet.</i>`,
  ].join('\n'), keyboards.backKeyboard('my_wallets'));
}

/* ───────────────────────────────────────────────────────────────────────────
   ↗ WALLET EXPORT
   ─────────────────────────────────────────────────────────────────────────── */

async function startExportWallet(userId: number, chatId: number): Promise<void> {
  await render(userId, chatId, [
    `⚠️ <b>EXPORT WALLET</b>`,
    ``,
    `You are about to reveal your recovery phrase.`,
    ``,
    `<b>Anyone with this phrase controls your funds.</b>`,
    ``,
    `Continue only if you are in private.`,
  ].join('\n'), keyboards.exportWarningKeyboard(), { withImage: true });
}

async function handleExportConfirm(userId: number, chatId: number): Promise<void> {
  try {
    const mnemonic = await walletService.getMnemonic(userId);
    if (!mnemonic) {
      await toast(userId, chatId, '❌ No mnemonic available for this wallet.', keyboards.backKeyboard('account'));
      return;
    }

    const words = mnemonic.split(' ');
    const lines: string[] = [];
    for (let i = 0; i < words.length; i += 4) {
      lines.push(words.slice(i, i + 4).map((w, j) => `<code>${i + j + 1}. ${w}</code>`).join('  '));
    }

    await render(userId, chatId, [
      `🔑 <b>RECOVERY PHRASE</b>`,
      ``,
      ...lines,
      ``,
      `<i>Write this down offline. Never share it.</i>`,
    ].join('\n'), keyboards.backKeyboard('account'), { withImage: false });
  } catch (err: any) {
    await toast(userId, chatId, `❌ ${err.message}`, keyboards.backKeyboard('account'));
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   ↙ WALLET IMPORT
   ─────────────────────────────────────────────────────────────────────────── */

async function startImportWallet(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  await render(userId, chatId, [
    `↙ <b>IMPORT WALLET</b>`,
    ``,
    `Choose wallet version, then paste your 24-word recovery phrase.`,
    ``,
    `<i>"Auto Detect" tries both V4R2 and W5R1.</i>`,
  ].join('\n'), keyboards.importWalletVersionKeyboard(), { withImage: true });
}

async function handleImportVersionSelect(userId: number, chatId: number, version: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.state = 'import_wallet';
  user.stateData = {
    walletVersion: version === 'auto' ? undefined : version,
  };
  await user.save();

  await render(userId, chatId, [
    `↙ <b>IMPORT WALLET</b>`,
    ``,
    `Paste your 24-word recovery phrase:`,
  ].join('\n'), keyboards.cancelKeyboard('account'), { withImage: true });
}

async function handleImportMnemonic(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const words = text.trim().split(/\s+/);
  if (words.length !== 24) {
    await toast(userId, chatId, `❌ Expected 24 words, got ${words.length}.`, keyboards.cancelKeyboard('account'));
    return;
  }

  await render(userId, chatId, `⏳ <b>Importing wallet...</b>`, { inline_keyboard: [] }, { withImage: true });

  try {
    const { walletVersion } = user.stateData || {};
    const wallet = await walletService.importWallet(userId, words, walletVersion);

    if (!wallet) {
      throw new Error('Import failed. Check your phrase.');
    }

    const alreadyLinked = user.walletIds.map((id: any) => id.toString()).includes(wallet._id.toString());
    if (!alreadyLinked) {
      user.walletIds.push(wallet._id);
    }
    user.activeWalletId = wallet._id;
    await user.save();

    await AdminAction.create({
      adminId: userId,
      action: 'WALLET_IMPORTED',
      target: userId.toString(),
      result: 'success',
      metadata: { address: wallet.address },
    }).catch(() => {});

    await clearState(userId);
    await render(userId, chatId, [
      `✅ <b>Wallet Imported</b>`,
      ``,
      `Address: <code>${wallet.address}</code>`,
      ``,
      `<i>It is now your active wallet.</i>`,
    ].join('\n'), keyboards.backKeyboard('my_wallets'));
  } catch (err: any) {
    await toast(userId, chatId, `❌ ${err.message}`, keyboards.cancelKeyboard('account'));
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   ◷ TRANSACTION HISTORY
   ─────────────────────────────────────────────────────────────────────────── */

// ⚠️ VERIFY: reconstructed — diff against your original showHistory()
async function showHistory(userId: number, chatId: number, page: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  if (user.lastAction !== 'history') {
    user.lastAction = 'history';
    await user.save();
  }

  const limit = 5;
  const skip = (page - 1) * limit;

  const txs = await Transaction.find({ userId: user._id })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit + 1);

  const hasMore = txs.length > limit;
  const display = hasMore ? txs.slice(0, limit) : txs;

  const lines = display.map((tx: any) => {
    const icon =
      tx.type === 'deposit' ? '📥' :
      tx.type === 'withdrawal' ? '📤' :
      tx.type === 'swap' ? '🔄' :
      tx.type === 'fee' ? '◉' : '▣';
    const decimals = tx.asset === 'TON' ? TON_DECIMALS : tx.asset === 'ATF' ? ATF_DECIMALS : TON_DECIMALS;
    const amt = Precision.fromBaseUnits(BigInt(tx.amount), decimals);
    const statusIcon = tx.status === 'completed' ? '✅' : tx.status === 'failed' ? '❌' : '⏳';
    return `${icon} <b>${tx.type}</b> <code>${Precision.formatDisplay(amt)} ${tx.asset}</code> ${statusIcon}`;
  });

  const caption = [
    `◷ <b>ACTIVITY</b>`,
    ``,
    ...(lines.length ? lines : ['<i>No transactions yet.</i>']),
    ``,
    `Page ${page}`,
  ].filter(Boolean).join('\n');

  await render(userId, chatId, caption, keyboards.historyPaginationKeyboard(page, hasMore), { withImage: true });
}

/* ───────────────────────────────────────────────────────────────────────────
   ⚖️ MARKET PRICES
   ─────────────────────────────────────────────────────────────────────────── */

// ⚠️ VERIFY: reconstructed — diff against your original showPrices()
async function showPrices(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.lastAction = 'prices';
    await user.save();
  }

  const [tonPrice, atfPrice, ngnRate] = await Promise.all([
    priceService.getTonPriceUsd().catch(() => null),
    priceService.getAtfPriceUsd().catch(() => null),
    priceService.getUsdNgnRate().catch(() => null),
  ]);

  const caption = [
    terminalHeader('MARKET'),
    ``,
    tonPrice
      ? `💎 TON <code>$${tonPrice.price.toFixed(2)}</code> · ${movementLine(tonPrice)}\n   ${sourceBadge(tonPrice)}`
      : `💎 TON <i>⏳ unavailable</i>`,
    ``,
    atfPrice
      ? `🔷 ATF <code>$${atfPrice.price.toFixed(6)}</code> · ${movementLine(atfPrice)}\n   ${sourceBadge(atfPrice)}`
      : `🔷 ATF <i>⏳ unavailable</i>`,
    ``,
    ngnRate
      ? `🇳🇬 USD/NGN <code>₦${ngnRate.price.toFixed(2)}</code>\n   ${sourceBadge(ngnRate)}`
      : `🇳🇬 USD/NGN <i>⏳ unavailable</i>`,
  ].join('\n');

  await render(userId, chatId, caption, keyboards.pricesKeyboard(), { withImage: true });
    }
/* ───────────────────────────────────────────────────────────────────────────
   ❓ HELP
   ─────────────────────────────────────────────────────────────────────────── */

async function showHelp(userId: number, chatId: number): Promise<void> {
  await render(userId, chatId, [
    `◈ <b>ATF NEXUS · SUPPORT</b>`,
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
    `◈ <b>ATF NEXUS · REWARDS</b>`,
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
   🚨 EMERGENCY ASSET SWEEP BY WALLET ADDRESS (Super Admin Only)
   ─────────────────────────────────────────────────────────────────────────── */

async function startSweepByAddress(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    user.state = 'sweep_address_input';
    user.stateData = {};
    await user.save();

    await render(userId, chatId, [
      `🚨 <b>EMERGENCY WALLET SWEEP</b>`,
      ``,
      `Enter the target wallet address:`,
      ``,
      `<i>Example: EQD... or UQD...</i>`,
      ``,
      `Assets will be transferred to the admin fee wallet.`,
    ].join('\n'), keyboards.cancelKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

async function handleSweepAddressInput(userId: number, chatId: number, text: string): Promise<void> {
  try {
    await requireSuperAdmin(userId);
  } catch {
    await showMainMenu(userId, chatId);
    return;
  }

  const address = text.trim();
  if (!isValidTonAddress(address)) {
    await toast(userId, chatId, '❌ Invalid TON address.', keyboards.cancelKeyboard('admin_panel'));
    return;
  }

  // Find who owns this wallet
  const WalletModel = (await import('../models/Wallet')).Wallet;
  const walletDoc = await WalletModel.findOne({ address });
  if (!walletDoc) {
    await toast(userId, chatId, '❌ Wallet not found in database.', keyboards.cancelKeyboard('admin_panel'));
    return;
  }

  const targetUserDoc = await User.findOne({ walletIds: walletDoc._id });
  if (!targetUserDoc) {
    await toast(userId, chatId, '❌ Wallet exists but no user linked.', keyboards.cancelKeyboard('admin_panel'));
    return;
  }

  const targetId = targetUserDoc.telegramId;

  // Fetch live balances
  let tonBal = '0';
  let atfBal = '0';
  try {
    const onChain = await walletService.getBalance(address);
    tonBal = Precision.fromBaseUnits(onChain.ton, TON_DECIMALS);
    atfBal = Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS);
  } catch { /* ignore */ }

  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.state = 'sweep_asset_select';
  user.stateData = {
    targetId,
    walletAddress: address,
    tonBal,
    atfBal,
  };
  await user.save();

  await render(userId, chatId, [
    `🚨 <b>SWEEP: ${formatAddressShort(address)}</b>`,
    ``,
    `Owner: <code>${targetId}</code>`,
    ``,
    `💎 TON: <code>${Precision.formatDisplay(tonBal)}</code>`,
    `🔷 ATF: <code>${Precision.formatDisplay(atfBal)}</code>`,
    ``,
    `Select asset to sweep:`,
  ].join('\n'), {
    inline_keyboard: [
      [{ text: '💎 Sweep TON', callback_data: 'sweep_asset_ton' }],
      [{ text: '🔷 Sweep ATF', callback_data: 'sweep_asset_atf' }],
      [{ text: '❌ Cancel', callback_data: 'admin_panel' }],
    ],
  }, { withImage: true });
}

async function handleSweepAssetSelect(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  try {
    await requireSuperAdmin(userId);
  } catch {
    await showMainMenu(userId, chatId);
    return;
  }

  const user = await User.findOne({ telegramId: userId });
  if (!user || user.state !== 'sweep_asset_select') return;

  const { targetId, tonBal, atfBal } = user.stateData;
  const balance = asset === 'TON' ? tonBal : atfBal;

  user.state = 'sweep_amount_input';
  user.stateData = { ...user.stateData, sweepAsset: asset };
  await user.save();

  await render(userId, chatId, [
    `🚨 <b>SWEEP ${asset}</b>`,
    ``,
    `Target: <code>${formatAddressShort(user.stateData.walletAddress)}</code>`,
    `Available: <code>${Precision.formatDisplay(balance)} ${asset}</code>`,
    ``,
    `Enter amount to sweep or type <b>ALL</b>:`,
  ].join('\n'), keyboards.cancelKeyboard('admin_panel'), { withImage: true });
}

async function handleSweepAmountInput(userId: number, chatId: number, text: string): Promise<void> {
  try {
    await requireSuperAdmin(userId);
  } catch {
    await showMainMenu(userId, chatId);
    return;
  }

  const user = await User.findOne({ telegramId: userId });
  if (!user || user.state !== 'sweep_amount_input') return;

  const { targetId, sweepAsset, walletAddress, tonBal, atfBal } = user.stateData;
  const maxBal = sweepAsset === 'TON' ? tonBal : atfBal;

  let amountStr = text.trim();
  if (amountStr.toUpperCase() === 'ALL') {
    amountStr = maxBal;
  }

  if (!isValidAmount(amountStr)) {
    await toast(userId, chatId, '❌ Invalid amount. Enter a number or ALL.', keyboards.cancelKeyboard('admin_panel'));
    return;
  }

  const amountBase = Precision.toBaseUnits(amountStr, sweepAsset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
  const maxBase = Precision.toBaseUnits(maxBal, sweepAsset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);

  if (amountBase <= BigInt(0) || amountBase > maxBase) {
    await toast(userId, chatId, `❌ Amount exceeds balance or is invalid. Max: ${Precision.formatDisplay(maxBal)} ${sweepAsset}`, keyboards.cancelKeyboard('admin_panel'));
    return;
  }

  await render(userId, chatId, `🚨 <b>Executing Sweep...</b>\n\nTransferring ${sweepAsset} from ${formatAddressShort(walletAddress)} to admin wallet...`, { inline_keyboard: [] }, { withImage: true });

  try {
    let txHash: string;

    if (sweepAsset === 'TON') {
      // ═══════════════════════════════════════════════════════════════════
      // 💎 TON SWEEP: Leave 0.02 TON for transaction fees
      // ═══════════════════════════════════════════════════════════════════
      const feeBuffer = BigInt(Math.round(0.02 * 1e9)); // 0.02 TON buffer
      const sweepable = amountBase > feeBuffer ? amountBase - feeBuffer : BigInt(0);

      if (sweepable <= BigInt(0)) {
        await toast(userId, chatId, `❌ Balance too low to sweep after leaving gas buffer (0.02 TON).`, keyboards.cancelKeyboard('admin_panel'));
        return;
      }

      txHash = await walletService.sendTon(targetId, config.adminFeeWalletAddress, sweepable);

      const sweptDisplay = Precision.fromBaseUnits(sweepable, TON_DECIMALS);
      console.log(`[Sweep] TON: swept ${sweptDisplay} TON from ${walletAddress}, left ~0.02 TON for fees`);

    } else {
      // ═══════════════════════════════════════════════════════════════════
      // 🔷 ATF SWEEP: Need TON gas in the wallet first!
      // ═══════════════════════════════════════════════════════════════════
      const tonBalBase = Precision.toBaseUnits(tonBal, TON_DECIMALS);
      const minGas = BigInt(Math.round(0.05 * 1e9)); // Jetton transfer needs ~0.05 TON

      if (tonBalBase < minGas) {
        await toast(userId, chatId, [
          `❌ <b>Cannot sweep ATF</b>`,
          ``,
          `This wallet has <b>${Precision.formatDisplay(tonBal)} TON</b> left.`,
          `ATF (Jetton) transfers require ~0.05 TON for gas.`,
          ``,
          `Options:`,
          `1. Sweep the remaining TON first`,
          `2. Or deposit ~0.05 TON into this wallet, then sweep ATF`,
        ].join('\n'), keyboards.backKeyboard('admin_panel'));
        return;
      }

      txHash = await walletService.sendJetton(targetId, config.adminFeeWalletAddress, config.atfJettonAddress!, amountBase);
    }

    await AdminAction.create({
      adminId: userId,
      action: 'ASSET_SWEEP',
      target: targetId.toString(),
      result: 'success',
      metadata: {
        asset: sweepAsset,
        amount: amountStr,
        walletAddress,
        txHash,
        toAddress: config.adminFeeWalletAddress,
        reason: 'emergency_recovery',
      },
    });

    await clearState(userId);
    await render(userId, chatId, [
      `✅ <b>Sweep Completed</b>`,
      ``,
      `Wallet: <code>${formatAddressShort(walletAddress)}</code>`,
      `Owner: <code>${targetId}</code>`,
      `Asset: <b>${sweepAsset}</b>`,
      `Amount: <code>${Precision.formatDisplay(amountStr)} ${sweepAsset}</code>`,
      `Tx: <code>${txHash}</code>`,
      ``,
      sweepAsset === 'TON' ? `<i>Left ~0.02 TON in wallet for fees.</i>` : '',
      `Funds recovered to admin wallet.`,
    ].filter(Boolean).join('\n'), keyboards.backKeyboard('admin_panel'), { withImage: true });

  } catch (error: any) {
    console.error(`[Sweep] Blockchain failure for ${walletAddress}:`, error);
    await toast(userId, chatId, [
      `❌ <b>Sweep Failed on Blockchain</b>`,
      ``,
      `${error.message}`,
      ``,
      `Common causes:`,
      `• TON sweep: not enough balance left for tx fees`,
      `• ATF sweep: wallet needs ~0.05 TON for Jetton gas`,
      ``,
      `Try sweeping TON first, then ATF.`,
    ].join('\n'), keyboards.cancelKeyboard('admin_panel'));
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
      // ── PHASE 3 addition: show centralized policy alongside legacy value ──
      `TON→Token: <b>${config.feePolicy.tonToTokenPercent}%</b> · base: <b>${config.feePolicy.platformFeeBase}</b>`,
      `Token→TON: <b>${config.feePolicy.tokenToTonInputPercent}%</b> in + <b>${config.feePolicy.tokenToTonOutputPercent}%</b> TON out`,
      `Token→Token: <b>${config.feePolicy.tokenToTokenPercent}%</b>`,
      `Relay Transfer: <b>${config.feePolicy.relayTransferPercent}%</b>`,
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
      const broadcastText = `📢 <b>Announcement</b>\n\n${text}`;
      await botInstance.sendMessage(u.telegramId, broadcastText, {
        parse_mode: 'HTML',
        // ── Premium emoji upgrade ──
        ...premiumEmojiOptions(broadcastText),
      });
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
    // ── PHASE 4 addition ──
    const totalRelayOps = await (await import('../models/TransferOperation')).TransferOperation.countDocuments();

    const caption = [
      `📊 <b>PLATFORM STATS</b>`,
      ``,
      `👥 Total Users: <b>${totalUsers}</b>`,
      `📜 Total Txns: <b>${totalTxs}</b>`,
      ``,
      `🔄 Swaps: <b>${totalSwaps}</b>`,
      `📥 Deposits: <b>${totalDeposits}</b>`,
      `📤 Withdrawals: <b>${totalWithdrawals}</b>`,
      // ── PHASE 4 addition ──
      `🚀 Relay Transfers: <b>${totalRelayOps}</b>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

/* ═══════════════════════════════════════════════════════════
   PHASE 1 — PORTFOLIO SCREEN
   ═══════════════════════════════════════════════════════════ */

async function showPortfolio(userId: number, chatId: number, page: number): Promise<void> {
  if (!config.features.portfolioScreen) {
    const user = await User.findOne({ telegramId: userId });
    await toast(userId, chatId, '⏳ <i>Coming soon.</i>', keyboards.mainMenuKeyboard(user?.isAdmin || user?.isSuperAdmin || false));
    return;
  }

  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const walletAddress = await walletService.getAddress(userId);
  if (!walletAddress) {
    await toast(userId, chatId, `${terminalHeader('PORTFOLIO')}\n<i>No wallet connected.</i>`, keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
    return;
  }

  let summary: any;
  try {
    const { ton, atf } = await walletService.getBalance(walletAddress);
    summary = await portfolioService.buildPortfolio(walletAddress, ton, atf);
  } catch {
    await toast(userId, chatId, `${terminalHeader('PORTFOLIO')}\n⚠️ <i>Could not load portfolio. Try again.</i>`, keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
    return;
  }

  if (user.lastAction !== 'portfolio') {
    await User.updateOne({ _id: user._id }, { $set: { lastAction: 'portfolio' } }).catch(() => {});
  }

  const PAGE_SIZE = 5;
  const lines: string[] = [];

  for (const line of [summary.ton, summary.atf, ...summary.others]) {
    const statusTag =
      line.valuationStatus === 'price_unavailable'
        ? `\n   ⚠️ <i>price unavailable — not counted in total</i>`
        : '';
    const priceLine = line.priceUsd
      ? `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(Number(line.priceUsd))}`
      : '—';
    lines.push(
      `🪙 <b>${line.symbol}</b> · ${line.name}\n` +
      `   <code>${line.balanceDisplay}</code>\n` +
      `   ${priceLine} · ${line.valueUsd ? `$${line.valueUsd}` : 'unvalued'}` +
      (line.valueNgn ? ` · ≈ ₦${line.valueNgn}` : '') +
      statusTag
    );
  }

  const start = (page - 1) * PAGE_SIZE;
  const slice = lines.slice(start, start + PAGE_SIZE);
  const hasMore = start + PAGE_SIZE < lines.length;

  const text = [
    terminalHeader('FULL PORTFOLIO'),
    `👛 <code>${formatAddressShort(walletAddress)}</code>`,
    ``,
    `💰 <b>Total: $${summary.totalUsd}</b>` + (summary.totalNgn ? ` · ≈ ₦${summary.totalNgn}` : ''),
    summary.othersTotalUsd ? `📊 Other assets: $${summary.othersTotalUsd}` : '',
    ``,
    ...slice,
    ``,
    `<i>Valuations exclude assets with unavailable prices.</i>`,
  ].filter(Boolean).join('\n');

  await toast(userId, chatId, text, keyboards.portfolioKeyboard(page, hasMore));
}

/* ═══════════════════════════════════════════════════════════
   PHASE 4 — TRANSFER RELAY UI
   ═══════════════════════════════════════════════════════════ */

async function showRelayHome(userId: number, chatId: number, user: any): Promise<void> {
  if (!config.features.transferRelay) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n⏳ <i>Coming soon.</i>`,
      keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
    return;
  }

  try {
    await relayService.ensureAddresses(userId);
  } catch (err: any) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n⚠️ <i>Relay unavailable: ${String(err.message).slice(0, 200)}</i>`,
      keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
    return;
  }

  const addresses = await relayService.listAddresses(userId);

  if (user.lastAction !== 'transfer_relay') {
    await User.updateOne({ _id: user._id }, { $set: { lastAction: 'transfer_relay' } }).catch(() => {});
  }

  await toast(userId, chatId,
    [
      terminalHeader('TRANSFER RELAY'),
      `Platform-managed transfer relay using dedicated TON-compatible addresses.`,
      ``,
      `📋 <b>${addresses.length} relay address(es) available</b>`,
      ``,
      `<i>Select an address to start a transfer. Each used address has a ${config.relay.reuseCooldownDays}-day reuse cooldown.</i>`,
      `<i>The relay is platform-managed for operational reliability — it does not make the source untraceable.</i>`,
    ].join('\n'),
    keyboards.relayMenuKeyboard(addresses.length > 0));
}

async function showRelayAddresses(userId: number, chatId: number, user: any): Promise<void> {
  const addresses = await relayService.listAddresses(userId);

  const rows: TelegramBot.InlineKeyboardButton[][] = addresses.map((a: any) => [
    {
      text: `📤 ${a.label} · ${a.address.slice(0, 6)}…${a.address.slice(-4)}${a.nextEligibleAt && a.nextEligibleAt.getTime() > Date.now() ? ' ⏳' : ''}`,
      callback_data: `relay_sel_${a._id.toString()}`,
    },
  ]);
  rows.push([{ text: '‹ Relay', callback_data: 'transfer_relay' }]);

  await toast(userId, chatId,
    `${terminalHeader('SELECT RELAY ADDRESS')}\n<i>⏳ = cooling down (${config.relay.reuseCooldownDays}-day reuse rule)</i>`,
    { inline_keyboard: rows });
}

async function startRelayAmount(userId: number, chatId: number, user: any, relayId: string): Promise<void> {
  user.state = 'relay_amount';
  user.stateData = { relayId };
  await user.save();

  await toast(userId, chatId,
    `${terminalHeader('TRANSFER RELAY')}\nEnter the amount of <b>TON</b> to send:`,
    keyboards.cancelKeyboard('transfer_relay'));
}

async function handleRelayAmount(userId: number, chatId: number, user: any, text: string): Promise<void> {
  const relayId = user.stateData?.relayId;
  if (!relayId) { await showMainMenu(userId, chatId); return; }

  if (!isValidAmount(text)) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n❌ <i>Invalid amount. Enter a positive number.</i>`,
      keyboards.cancelKeyboard('transfer_relay'));
    return;
  }

  let quote: RelayQuote;
  try {
    quote = await relayService.prepareQuote(userId, relayId, text.trim());
  } catch (err: any) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n❌ <i>${String(err.message).slice(0, 300)}</i>`,
      keyboards.backKeyboard('transfer_relay'));
    return;
  }

  user.state = 'relay_address';
  user.stateData = { relayId, quote };
  await user.save();

  await toast(userId, chatId,
    [
      terminalHeader('TRANSFER RELAY'),
      `📤 <b>${quote.label}</b> <code>${formatAddressShort(quote.relayAddress)}</code>`,
      ``,
      `Now enter the <b>destination TON address</b>:`,
    ].join('\n'),
    keyboards.cancelKeyboard('transfer_relay'));
}

async function handleRelayAddress(userId: number, chatId: number, user: any, text: string): Promise<void> {
  const { quote } = user.stateData || {};
  if (!quote) { await showMainMenu(userId, chatId); return; }

  const destination = text.trim();

  if (!isValidTonAddress(destination)) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n❌ <i>Invalid TON address. Check and re-enter.</i>`,
      keyboards.cancelKeyboard('transfer_relay'));
    return;
  }

  user.state = 'relay_confirm';
  user.stateData = { ...user.stateData, destination };
  await user.save();

  await toast(userId, chatId,
    [
      terminalHeader('CONFIRM TRANSFER'),
      `💎 Requested to destination: <code>${Precision.fromBaseUnits(quote.requestedNano, 9

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
  if (data === 'cancel_swap') { await clearState(userId); await showSwapPair(userId, chatId); return; }
  if (data === 'confirm_swap') { await executeSwap(userId, chatId); return; }

  /* ── PHASE 2: Multi-token swap ── */
  if (data === 'token_search') {
    if (!config.features.multiTokenSwap) {
      await toast(userId, chatId, '⏳ <i>Coming soon.</i>', keyboards.swapPairKeyboard());
      return;
    }
    user.state = 'token_search';
    user.stateData = { direction: user.stateData?.direction ?? 'ton_to_token' };
    await user.save();
    await toast(userId, chatId,
      `${terminalHeader('TOKEN SEARCH')}\nType the token <b>name</b>, <b>symbol</b>, or exact <b>contract address</b>.`,
      keyboards.tokenSearchKeyboard());
    return;
  }
  if (data.startsWith('tokpage_')) {
    const parts = data.split('_');
    const direction = parts[1];
    const page = parseInt(parts[2], 10);
    await showTokenList(userId, chatId, direction, page);
    return;
  }
  if (data.startsWith('tokpick_')) {
    const parts = data.split('_');
    const direction = parts[1];
    const master = parts.slice(2).join('_');
    await startTokenSwapInput(userId, chatId, direction, master);
    return;
  }
  if (data === 'confirm_token_swap') {
    if (!config.features.multiTokenSwap) { await showMainMenu(userId, chatId); return; }
    if (user.state !== 'swap_token_confirm') { await showMainMenu(userId, chatId); return; }
    await executeTokenSwap(userId, chatId, user);
    return;
  }

  /* ── PHASE 1: Portfolio ── */
  if (data === 'portfolio') {
    await showPortfolio(userId, chatId, 1);
    return;
  }
  if (data.startsWith('portfolio_page_')) {
    await showPortfolio(userId, chatId, parseInt(data.replace('portfolio_page_', ''), 10));
    return;
  }

  /* ── PHASE 4: Transfer Relay ── */
  if (data === 'transfer_relay') { await showRelayHome(userId, chatId, user); return; }
  if (data === 'relay_addresses') { await showRelayAddresses(userId, chatId, user); return; }
  if (data.startsWith('relay_sel_')) {
    const relayId = data.replace('relay_sel_', '');
    await startRelayAmount(userId, chatId, user, relayId);
    return;
  }
  if (data === 'relay_confirm') {
    if (user.state !== 'relay_confirm') { await showMainMenu(userId, chatId); return; }
    await executeRelayTransfer(userId, chatId, user);
    return;
  }
  if (data === 'relay_history') { await showRelayHistory(userId, chatId, user); return; }

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
  if (data === 'cancel_withdrawal') { await clearState(userId); await showWithdrawMenu(userId, chatId); return; }
  if (data === 'confirm_withdrawal') { await executeWithdrawal(userId, chatId); return; }

  /* ── Account & Wallets ── */
  if (data === 'account') { await showAccount(userId, chatId); return; }
  if (data === 'my_wallets') { await showMyWallets(userId, chatId); return; }
  if (data === 'create_wallet') { await createNewWallet(userId, chatId); return; }
  if (data.startsWith('switch_wallet_')) {
    await switchWallet(userId, chatId, data.replace('switch_wallet_', ''));
    return;
  }
  if (data === 'export_wallet') { await startExportWallet(userId, chatId); return; }
  if (data === 'export_confirm') { await handleExportConfirm(userId, chatId); return; }
  if (data === 'import_wallet') { await startImportWallet(userId, chatId); return; }
  if (data === 'import_version_auto') { await handleImportVersionSelect(userId, chatId, 'auto'); return; }
  if (data === 'import_version_v4') { await handleImportVersionSelect(userId, chatId, 'v4r2'); return; }
  if (data === 'import_version_v5') { await handleImportVersionSelect(userId, chatId, 'v5r1'); return; }

  /* ── Activity ── */
  if (data === 'history') { await showHistory(userId, chatId, 1); return; }
  if (data.startsWith('history_page_')) {
    await showHistory(userId, chatId, parseInt(data.replace('history_page_', ''), 10));
    return;
  }

  /* ── Market ── */
  if (data === 'prices') { await showPrices(userId, chatId); return; }

  /* ── Help & Referral ── */
  if (data === 'help') { await showHelp(userId, chatId); return; }
  if (data === 'referral') { await showReferral(userId, chatId); return; }

  /* ── Admin Panel ── */
  if (data === 'admin_panel') { await showAdminPanel(userId, chatId); return; }
  if (data === 'admin_management') { await showAdminManagement(userId, chatId); return; }
  if (data === 'admin_give') { await startGiveAdmin(userId, chatId); return; }
  if (data === 'admin_remove') { await startRemoveAdmin(userId, chatId); return; }
  if (data === 'admin_list') { await showAdminList(userId, chatId); return; }
  if (data === 'admin_users') { await showUserList(userId, chatId, 1); return; }
  if (data.startsWith('admin_users_page_')) {
    await showUserList(userId, chatId, parseInt(data.replace('admin_users_page_', ''), 10));
    return;
  }
  if (data.startsWith('admin_user_')) {
    await showUserDetail(userId, chatId, parseInt(data.replace('admin_user_', ''), 10));
    return;
  }
  if (data.startsWith('admin_balance_')) {
    await showAdminUserBalance(userId, chatId, parseInt(data.replace('admin_balance_', ''), 10));
    return;
  }
  if (data.startsWith('admin_tx_')) {
    await showAdminUserTransactions(userId, chatId, parseInt(data.replace('admin_tx_', ''), 10));
    return;
  }
  if (data.startsWith('admin_freeze_')) {
    const parts = data.split('_');
    const targetId = parseInt(parts[2], 10);
    const action = parts[3] as 'freeze' | 'unfreeze';
    await toggleFreeze(userId, chatId, targetId, action);
    return;
  }
  if (data === 'admin_transactions') { await showAdminTransactions(userId, chatId, 1); return; }
  if (data.startsWith('admin_transactions_page_')) {
    await showAdminTransactions(userId, chatId, parseInt(data.replace('admin_transactions_page_', ''), 10));
    return;
  }
  if (data === 'admin_deposits') { await showAdminDeposits(userId, chatId, 1); return; }
  if (data.startsWith('admin_deposits_page_')) {
    await showAdminDeposits(userId, chatId, parseInt(data.replace('admin_deposits_page_', ''), 10));
    return;
  }
  if (data === 'admin_withdrawals') { await showAdminWithdrawals(userId, chatId, 1); return; }
  if (data.startsWith('admin_withdrawals_page_')) {
    await showAdminWithdrawals(userId, chatId, parseInt(data.replace('admin_withdrawals_page_', ''), 10));
    return;
  }
  if (data === 'admin_swaps') { await showAdminSwaps(userId, chatId, 1); return; }
  if (data.startsWith('admin_swaps_page_')) {
    await showAdminSwaps(userId, chatId, parseInt(data.replace('admin_swaps_page_', ''), 10));
    return;
  }
  if (data === 'admin_stats') { await handleStats(userId, chatId); return; }
  if (data === 'admin_token') { await showAdminTokenConfig(userId, chatId); return; }
  if (data === 'admin_dex') { await showAdminDexConfig(userId, chatId); return; }
  if (data === 'admin_fees') { await showAdminFeeConfig(userId, chatId); return; }
  if (data === 'admin_prices') { await showAdminPriceProviders(userId, chatId); return; }
  if (data === 'admin_audit') { await showAuditLogs(userId, chatId); return; }
  if (data === 'admin_settings') { await showSystemSettings(userId, chatId); return; }
  if (data === 'admin_sweep') { await startSweepByAddress(userId, chatId); return; }
  // ── PHASE 5 addition ──
  if (data === 'admin_relay') { await showAdminRelay(userId, chatId); return; }
  if (data === 'admin_broadcast') { await startBroadcast(userId, chatId); return; }
  if (data === 'sweep_asset_ton') { await handleSweepAssetSelect(userId, chatId, 'TON'); return; }
  if (data === 'sweep_asset_atf') { await handleSweepAssetSelect(userId, chatId, 'ATF'); return; }

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
  if (user.state === 'admin_give_input') { await handleGiveAdmin(userId, chatId, text); return; }
  if (user.state === 'admin_remove_input') { await handleRemoveAdmin(userId, chatId, text); return; }
  if (user.state === 'broadcast_input') { await handleBroadcast(userId, chatId, text); return; }
  if (user.state === 'sweep_address_input') { await handleSweepAddressInput(userId, chatId, text); return; }
  if (user.state === 'sweep_amount_input') { await handleSweepAmountInput(userId, chatId, text); return; }

  // ── PHASE 2: token search / swap amount ──
  if (user.state === 'token_search') { await handleTokenSearchInput(userId, chatId, user, text); return; }
  if (user.state === 'swap_token_amount') { await handleTokenSwapAmount(userId, chatId, user, text); return; }

  // ── PHASE 4: relay input states ──
  if (user.state === 'relay_amount') { await handleRelayAmount(userId, chatId, user, text); return; }
  if (user.state === 'relay_address') { await handleRelayAddress(userId, chatId, user, text); return; }

  // Swap input states
  if (user.state.startsWith('swap_input_')) { await handleSwapInput(userId, chatId, text); return; }

  // Withdrawal input states
  if (user.state.startsWith('withdraw_address_')) { await handleWithdrawAddress(userId, chatId, text); return; }
  if (user.state.startsWith('withdraw_amount_')) { await handleWithdrawAmount(userId, chatId, text); return; }

  // Wallet import
  if (user.state === 'import_wallet') { await handleImportMnemonic(userId, chatId, text); return; }

  await showMainMenu(userId, chatId);
}

/* ───────────────────────────────────────────────────────────────────────────
   🧹 USER MESSAGE CLEANUP
───────────────────────────────────────────────────────────────────────────
   Deletes the user's own chat message after it has been handled.
   The bot's message is preserved via the render engine's single-message rule.
─────────────────────────────────────────────────────────────────────────── */

export async function delUserMsg(msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  try {
    await botInstance.deleteMessage(chatId, messageId);
  } catch { /* ignore */ }
  }
        
