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

/* ── SERVICE INSTANCES ── */

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

/* ── Price display helpers ── */

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

/* ── STRICT SINGLE-MESSAGE RENDER ENGINE ── */

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

  // ── Premium emoji upgrade: compute once, reuse for every branch ──
  const premiumEntities = buildPremiumEmojiEntities(text);
  const textEntities =
    premiumEntities.length > 0 ? { entities: premiumEntities } : {};
  const captionEntities =
    premiumEntities.length > 0 ? { caption_entities: premiumEntities } : {};

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

/* ── USER LIFECYCLE ── */

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

/* ── WALLET HELPERS ── */

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
/* ── RESTORE LAST ACTION ── */

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
    case 'portfolio': await showPortfolio(userId, chatId, 1); break;
    case 'transfer_relay': await showRelayHome(userId, chatId, user); break;
    default: await showMainMenu(userId, chatId);
  }
}

/* ── MAIN MENU ── */

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

/* ── SWAP FLOW ── */

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
  if (!user || !user.state.startsWith('swap_input_')) return;

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
    ].join('\n'), keyboards.backKeyboard(`deposit_${asset.toLowerCase()}`));
  } catch (error: any) {
    await toast(userId, chatId, `❌ ${error.message}`, keyboards.backKeyboard('deposit'));
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
    terminalHeader('WITHDRAW', 'Send assets to an external TON address'),
    ``,
    `Select the asset to withdraw.`,
    ``,
    `💎 <b>TON</b>  ·  Native TON`,
    `🔷 <b>ATF</b>  ·  ATF Jetton`,
    ``,
    `⚠ <i>Destination transactions cannot normally be reversed.</i>`,
  ].join('\n'), keyboards.withdrawAssetKeyboard(), { withImage: true });
}

async function startWithdrawal(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.state = `withdraw_address_${asset}`;
  user.stateData = {};
  await user.save();

  await render(userId, chatId, [
    `◈ <b>ATF NEXUS · WITHDRAW ${asset}</b>`,
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
    `◈ <b>ATF NEXUS · WITHDRAW ${asset}</b>`,
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
      `◈ <b>ATF NEXUS · CONFIRM WITHDRAWAL</b>`,
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
    ].filter(Boolean).join('\n'), keyboards.backKeyboard('back_main'), { withImage: true });
  } catch (error: any) {
    await toast(userId, chatId, `❌ <b>Withdrawal Failed</b>\n\n${error.message}`, keyboards.cancelKeyboard('withdraw'));
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
   🔐 WALLET EXPORT
   ─────────────────────────────────────────────────────────────────────────── */

async function showExportWarning(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.state = 'export_wallet';
    await user.save();
  }

  await render(userId, chatId, [
    `⚠️ <b>WALLET EXPORT WARNING</b>`,
    ``,
    `You are about to reveal your recovery phrase.`,
    ``,
    `<b>Anyone with this phrase can control your funds.</b>`,
    ``,
    `<i>Only proceed in a private chat.</i>`,
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
  } finally {
    await clearState(userId);
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
  const timer = setTimeout(() => autoDetectMnemonicCache.delete(userId), 90_000);
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
    } else {
      selectedVersion = manualVersion!;
    }

    await finalizeWalletImport(userId, chatId, mnemonic, selectedVersion);
  } catch (error: any) {
    await toast(userId, chatId, `❌ ${error.message}`, keyboards.cancelKeyboard('account'));
  }
}

async function handleImportVersionConfirm(userId: number, chatId: number, version: WalletVersion): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || user.state !== 'import_version_confirm') return;

  const mnemonic = getAndClearAutoDetectMnemonic(userId);
  if (!mnemonic) {
    await toast(userId, chatId, '⏳ Session expired. Please paste your phrase again.', keyboards.backKeyboard('account'));
    await clearState(userId);
    return;
  }

  await finalizeWalletImport(userId, chatId, mnemonic, version);
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
  
