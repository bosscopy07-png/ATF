/**
 * ATF NEXUS — Bot context.
 * Everything shared by all screen modules: service instances, the
 * single-message render engine, user lifecycle, and display helpers.
 * Imports nothing from ./screens or ./handlers (no cycles).
 */
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
import { PortfolioService } from '../services/portfolio-service';
import { TransferRelayService, RelayQuote } from '../services/transfer-relay-service';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS, ATF_DECIMALS } from '../config';
import {
  isValidTonAddress,
  isValidAmount,
  isValidTelegramId,
  formatAddressShort,
} from '../utils/validation';
import {
  buildPremiumEmojiEntities,
  premiumEmojiOptions,
} from './premium-emoji';

/* ── Re-exports so screens need only one import ── */
export {
  TelegramBot, mongoose, User, Wallet, Transaction, AdminAction, Referral,
  Precision, config, TON_DECIMALS, ATF_DECIMALS,
  isValidTonAddress, isValidAmount, isValidTelegramId, formatAddressShort,
  premiumEmojiOptions,
};
export type { RelayQuote };

/* ── Service instances (single shared set) ── */

export const swapService = new SwapService();
export const withdrawalService = new WithdrawalService();
export const walletService = new WalletService();
export const priceService = PriceService.getInstance();
export const portfolioService = new PortfolioService();
export const relayService = new TransferRelayService();

export const WALLET_BALANCE_TIMEOUT_MS = 8_000;

export const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

/* ── Price display helpers ── */

export const fmtMoney = (v: string, dp = 2): string =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export const cleanSource = (p: any): string => String(p?.source ?? '').replace(' (stale)', '');

export const isStale = (p: any): boolean => typeof p?.source === 'string' && p.source.includes('(stale)');

export function movementLine(p: any): string {
  if (!p) return '⚪ —';
  if (isStale(p)) return '⏳ cached';
  const c = p.change24hPercent ?? null;
  if (c === null || !Number.isFinite(c)) return '⚪ —';
  return `${c > 0 ? '🟢' : c < 0 ? '🔴' : '⚪'} ${c > 0 ? '+' : ''}${c.toFixed(2)}%`;
}

/** Compact 2-line asset block: balance on line 1, "value · 24h movement" on line 2.
 *  Unavailable balance and unavailable price are distinct states — never $0.00. */
export function assetRow(emoji: string, symbol: string, balance: string | null, usd: string | null, price: any): string[] {
  if (balance === null) {
    return [`${emoji} <b>${symbol}</b>  <i>⏳ balance unavailable</i>`];
  }
  const value = usd !== null ? `<code>$${fmtMoney(usd)}</code>` : '<i>price unavailable</i>';
  return [
    `${emoji} <b>${symbol}</b>  <code>${Precision.formatDisplay(balance)}</code>`,
    `   ├ 💵 ${value} · 📊 ${movementLine(price)}`,
  ];
}

export function sourceBadge(p: any): string {
  const name = sourceLabel({ ...p, source: cleanSource(p) });
  return `<i>${name}${isStale(p) ? ' · ⏳ stale' : ''}</i>`;
}

export function marketMovement(price: any): string {
  const change = Number(price?.change24hPercent);
  if (!Number.isFinite(change)) return '24h · —';
  const sign = change > 0 ? '+' : '';
  const icon = change > 0 ? '↗' : change < 0 ? '↘' : '→';
  return `24h ${icon} ${sign}${change.toFixed(2)}%`;
}

export function sourceLabel(price: any): string {
  const source = String(price?.source || 'market');
  try {
    return new URL(source).hostname.replace(/^www\./, '');
  } catch {
    return source.slice(0, 28);
  }
}

export function terminalHeader(title: string, subtitle?: string): string {
  return [
    `◈ <b>ATF NEXUS</b> · <b>${title}</b>`,
    subtitle ? `<i>${subtitle}</i>` : '',
    `━━━━━━━━━━━━━━━━━━━━`,
  ].filter(Boolean).join('\n');
}

/** Compact step header for multi-step flows (brand + title, no rule line). */
export function stepHeader(title: string, subtitle?: string): string {
  return [
    `◈ <b>ATF NEXUS</b> · <b>${title}</b>`,
    subtitle ? `<i>${subtitle}</i>` : '',
  ].filter(Boolean).join('\n');
}

/** Compact "Label: value" row — the standard confirm/quote line format. */
export const kv = (label: string, value: string): string =>
  `<b>${label}:</b> ${value}`;

/* ── Bot instance ──*/
let botInstance: TelegramBot;

export function setBot(bot: TelegramBot): void {
  botInstance = bot;
}

export function getBot(): TelegramBot {
  return botInstance;
}

/* ── STRICT SINGLE-MESSAGE RENDER ENGINE ── */

export async function render(
  userId: number,
  chatId: number,
  text: string,
  keyboard: any,
  opts?: { withImage?: boolean }
): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  const msgId = user?.lastBotMessageId;
  const imageUrl = config.botBrandingImageUrl;

  // ── Premium emoji upgrade. Entities are JSON.stringify'd —
  //    node-telegram-bot-api mangles raw arrays in multipart forms.
  //    Layer is disabled by default (returns []) → zero impact. ──
  const premiumEntities = buildPremiumEmojiEntities(text);
  const textEntities: any =
    premiumEntities.length > 0 ? { entities: JSON.stringify(premiumEntities) } : {};
  const captionEntities: any =
    premiumEntities.length > 0 ? { caption_entities: JSON.stringify(premiumEntities) } : {};

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

  if (msgId) {
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

    if (wantPhoto && !wasPhoto) {
      try { await botInstance.deleteMessage(chatId, msgId); } catch {}
      await purgeRef();
    }

    if (!wantPhoto && wasPhoto) {
      try { await botInstance.deleteMessage(chatId, msgId); } catch {}
      await purgeRef();
    }

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

export async function toast(userId: number, chatId: number, text: string, keyboard: any): Promise<void> {
  return render(userId, chatId, text, keyboard);
}

export async function clearState(userId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.state = 'idle';
    user.stateData = {};
    await user.save();
  }
}

/* ── USER LIFECYCLE ── */
export async function getOrCreateUser(msg: TelegramBot.Message): Promise<any> {
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

export async function requireAdmin(userId: number): Promise<any> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || (!user.isAdmin && !user.isSuperAdmin)) throw new Error('Unauthorized');
  return user;
}

export async function requireSuperAdmin(userId: number): Promise<any> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.isSuperAdmin) throw new Error('Super Admin only');
  return user;
}

export function explorerLink(txHash: string): string {
  if (!txHash || txHash.includes('_')) return '';
  return `https://tonscan.org/tx/${txHash}`;
}

/** Explorer link row for success screens — '' when the hash is unusable. */
export function explorerRow(txHash: string): string {
  const link = explorerLink(txHash);
  return link ? `🔗 <a href="${link}">View on Explorer</a>` : '';
}

/* ── WALLET HELPERS ──*/

export async function getActiveWallet(userId: number): Promise<any> {
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

export async function getUserWallets(userId: number): Promise<any[]> {
  return walletService.getWallets(userId);
}

/* ── PHASE 4: rehydrate a RelayQuote that round-tripped through
   user.stateData (Mongo Mixed converts bigint → string). ── */
export function reviveRelayQuote(raw: any): RelayQuote {
  return {
    ...raw,
    requestedNano: BigInt(raw.requestedNano),
    platformFeeNano: BigInt(raw.platformFeeNano),
    fundingAmountNano: BigInt(raw.fundingAmountNano),
    forwardFeeEstimateNano: BigInt(raw.forwardFeeEstimateNano),
    minReserveNano: BigInt(raw.minReserveNano),
    totalDebitNano: BigInt(raw.totalDebitNano),
    relayResidualExpectedNano: BigInt(raw.relayResidualExpectedNano ?? '0'),
    expiresAt: new Date(raw.expiresAt),
  };
    }
    
