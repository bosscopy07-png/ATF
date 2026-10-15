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
  
