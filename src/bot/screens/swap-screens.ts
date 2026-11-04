/**
 * Swap screens — TON↔ATF flow + PHASE 2 multi-token swap.
 * Imports context + main-menu (static). Never imported by main-menu at
 * load time (restoreLastAction uses a dynamic import) → no cycles.
 */
import {
  TelegramBot, User, Transaction, Precision, config, TON_DECIMALS, ATF_DECIMALS,
  swapService, multiTokenSwapService, priceService, walletService,
  render, toast, clearState,
  terminalHeader, stepHeader, explorerRow, fmtMoney, marketMovement,
  isValidAmount,
  getActiveWallet,
} from '../context';
import { showMainMenu } from './main-menu';
import * as keyboards from '../keyboards';
import { TokenRegistry } from '../../services/token-registry';
import { SwapInProgressError, QuoteExpiredError } from '../../services/multi-token-swap-service';
import { tokenButtonLabel, tokenDetailLine, trendEmoji } from '../token-display';

/* ───────────────────────────────────────────────────────────────────────────
   🔄 SWAP FLOW (TON ↔ ATF — existing behavior preserved)
   ─────────────────────────────────────────────────────────────────────────── */

export async function showSwapPair(userId: number, chatId: number): Promise<void> {
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
    terminalHeader('SWAP', 'instant conversion · quote locked while confirming'),
    '',
    tonPrice ? `💎 TON <code>$${tonPrice.price.toFixed(2)}</code> · ${marketMovement(tonPrice)}` : `💎 TON ⏳ price unavailable`,
    atfPrice ? `🔷 ATF <code>$${atfPrice.price.toFixed(6)}</code> · ${marketMovement(atfPrice)}` : `🔷 ATF ⏳ price unavailable`,
    '',
    `Pick a pair below.`,
  ].join('\n'), keyboards.swapPairKeyboard(), { withImage: true });
}

export async function startSwapInput(userId: number, chatId: number, direction: 'ton_to_atf' | 'atf_to_ton'): Promise<void> {
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

  const isTonToAtf = direction === 'ton_to_atf';
  const sym = isTonToAtf ? 'TON' : 'ATF';
  const caption = [
    stepHeader(`SWAP ${isTonToAtf ? 'TON → ATF' : 'ATF → TON'}`, 'free quote · no commitment'),
    '',
    `Enter the amount to swap.`,
    '',
    isTonToAtf ? `📌 Min: <code>${config.minSwapTon} TON</code>` : '',
    `💳 Balance: <code>${Precision.formatDisplay(balance)} ${sym}</code>`,
  ].filter(Boolean).join('\n');

  user.state = `swap_input_${direction}`;
  user.stateData = {};
  await user.save();

  await render(userId, chatId, caption, keyboards.backKeyboard('swap'), { withImage: true });
}

export async function handleSwapInput(userId: number, chatId: number, text: string): Promise<void> {
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
    const inSym = isTonToAtf ? 'TON' : 'ATF';
    const outSym = isTonToAtf ? 'ATF' : 'TON';
    let receiveUsd: string | null = null;
    if (isTonToAtf && atfPrice) {
      receiveUsd = priceService.convertCryptoToUsd(confirmation.expectedOutput, atfPrice.price, ATF_DECIMALS);
    } else if (!isTonToAtf && tonPrice) {
      receiveUsd = priceService.convertCryptoToUsd(confirmation.expectedOutput, tonPrice.price, TON_DECIMALS);
    }

    const secs = Math.max(0, Math.floor((confirmation.expiresAt.getTime() - Date.now()) / 1000));

    const caption = [
      stepHeader('SWAP QUOTE', `${inSym} → ${outSym} · expires in ${secs}s`),
      '',
      `▸ <b>YOU PAY</b>`,
      `<code>${Precision.formatDisplay(confirmation.inputAmount)} ${inSym}</code>`,
      `├ platform fee  <code>${Precision.formatDisplay(confirmation.platformFee)} ${inSym}</code>`,
      `└ swaps with    <code>${Precision.formatDisplay(confirmation.netSwapAmount)} ${inSym}</code>`,
      '',
      `▸ <b>YOU RECEIVE</b>`,
      `<code>${Precision.formatDisplay(confirmation.expectedOutput)} ${outSym}</code>${receiveUsd ? `  ≈ $${fmtMoney(receiveUsd)}` : ''}`,
      `└ minimum       <code>${Precision.formatDisplay(confirmation.minOutput)} ${outSym}</code>`,
      isTonToAtf ? `⛽ network  <code>${Precision.formatDisplay(confirmation.dexCosts)} TON</code>` : '',
      '',
      `rate  ${confirmation.rate}`,
    ].filter(Boolean).join('\n');

    await render(userId, chatId, caption, keyboards.confirmSwapKeyboard(), { withImage: true });
  } catch (error: any) {
    let msg = error.message || 'Swap failed';
    if (error.message?.includes('Minimum')) {
      msg = `📌 Minimum swap is <b>${config.minSwapTon} TON</b>`;
    } else if (error.message?.includes('gas') || error.message?.includes('treasury')) {
      msg = `⛽ <b>Insufficient gas</b>\n\nTop up your TON balance and retry.`;
    }
    await toast(userId, chatId, `❌ ${msg}`, keyboards.backKeyboard('swap'));
  }
}

export async function executeSwap(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('swap_confirm_')) {
    await showMainMenu(userId, chatId);
    return;
  }

  const direction = user.state.replace('swap_confirm_', '') as 'ton_to_atf' | 'atf_to_ton';
  const { confirmation } = user.stateData || {};
  if (!confirmation || new Date() > confirmation.expiresAt) {
    await clearState(userId);
    await toast(userId, chatId, '⏳ Quote expired — get a fresh one.', keyboards.backKeyboard('swap'));
    return;
  }

  await render(userId, chatId, `🔄 <b>Executing swap…</b>\n\nbroadcasting to TON ⛓️`, { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'back_main' }]] }, { withImage: true });

  try {
    // FIX E: the swap is NOT completed here — it has only been BROADCAST.
    // The reconciler is the sole authority on completion (it observes the
    // on-chain DEX outcome and may still mark this swap failed). Marking it
    // completed here made the bot report success for swaps that later
    // failed on-chain.
    const txId = await swapService.executeSwap(userId, confirmation, direction);
    const txRecord = await Transaction.findById(txId);
    const txHash = txRecord?.txHash || '';
    const isTonToAtf = direction === 'ton_to_atf';
    const inSym = isTonToAtf ? 'TON' : 'ATF';
    const outSym = isTonToAtf ? 'ATF' : 'TON';

    const caption = [
      `✅ <b>SWAP SUBMITTED</b>`,
      '',
      `<code>${Precision.formatDisplay(confirmation.inputAmount)} ${inSym}</code> → <code>${Precision.formatDisplay(confirmation.expectedOutput)} ${outSym}</code>`,
      `└ broadcasting — track final status in ◷ Activity`,
      explorerRow(txHash),
    ].filter(Boolean).join('\n');

    await clearState(userId);
    await render(userId, chatId, caption, keyboards.backKeyboard('back_main'), { withImage: true });
  } catch (error: any) {
    await toast(userId, chatId, `❌ <b>Swap failed</b>\n\n${error.message}`, keyboards.backKeyboard('swap'));
  }
}

/* ═══════════════════════════════════════════════════════════
   PHASE 2 — MULTI-TOKEN SWAP UI  (TON → TOKEN, TOKEN → TON)
   All logic lives in MultiTokenSwapService. These screens only render and
   route; they never decide an outcome or claim a swap succeeded.
   ═══════════════════════════════════════════════════════════ */

const PAGE_SIZE_TOKENS = 6;

const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** base units → trimmed decimal string (never scientific, never float). */
function fmt(base: string | bigint, decimals: number): string {
  const full = Precision.fromBaseUnits(BigInt(base), decimals);
  return full.includes('.') ? full.replace(/0+$/, '').replace(/\.$/, '') || '0' : full;
}

/** Our own, already user-safe messages pass through; anything else is generic. */
const SAFE_ERROR = /^(Insufficient|Invalid amount|Minimum swap|You hold no|Quote expired|Your active wallet|Network gas|Platform gas|The gas top-up|Account is frozen|This swap|No swap route|Quote changed|ATF has its own|Unsupported)/i;
function friendlyError(err: any): string {
  const msg = String(err?.message || err || '');
  if (SAFE_ERROR.test(msg)) return esc(msg.slice(0, 400));
  console.error('[MultiToken] hidden internal error:', msg);
  return "This swap can't be completed right now. Please try again, or try a different amount or token.";
}

const comingSoon = (userId: number, chatId: number) =>
  toast(userId, chatId, '⏳ coming soon', keyboards.swapPairKeyboard());

/** Entry for the 'token_search' button: pick a direction. */
export async function onTokenSearch(userId: number, chatId: number, user: any): Promise<void> {
  if (!config.features.multiTokenSwap) { await comingSoon(userId, chatId); return; }

  multiTokenSwapService.warmRegistry(); // start loading the token list before they search

  user.state = 'idle';
  user.stateData = {};
  await user.save();

  await toast(userId, chatId,
    [
      terminalHeader('SWAP OTHER TOKENS', 'live quote before you confirm'),
      '',
      `💎 <b>TON → TOKEN</b> — buy any listed token`,
      `💠 <b>TOKEN → TON</b> — sell a token your wallet holds`,
    ].join('\n'),
    keyboards.multiTokenMenuKeyboard());
}

/** TON → TOKEN: ask for a name / symbol / contract address. */
export async function startTonToToken(userId: number, chatId: number, user: any): Promise<void> {
  if (!config.features.multiTokenSwap) { await comingSoon(userId, chatId); return; }

  user.state = 'token_search';
  user.stateData = { direction: 'ton_to_token' };
  await user.save();

  await toast(userId, chatId,
    [
      terminalHeader('TON → TOKEN', 'search any listed token'),
      '',
      `Type the token <b>name</b>, <b>symbol</b>, or <b>Jetton contract address</b>.`,
    ].join('\n'),
    keyboards.tokenSearchKeyboard());
}

async function showChoices(userId: number, chatId: number, user: any, page: number, header: string): Promise<void> {
  const st = user.stateData || {};
  const choices: any[] = st.choices || [];
  const isHoldings = st.direction === 'token_to_ton';

  const start = (page - 1) * PAGE_SIZE_TOKENS;
  const pageItems = choices.slice(start, start + PAGE_SIZE_TOKENS);

  // price + 24h change for just the rows on screen (cached, time-boxed, cosmetic)
  await multiTokenSwapService.enrichMarket(pageItems);

  const row = (c: any) => ({
    symbol: c.symbol,
    priceUsd: c.priceUsd,
    change24h: c.change24h,
    balance: isHoldings ? fmt(c.balanceBase, c.decimals) : undefined,
  });

  // the keyboard indexes by absolute position; only the visible page needs a full label
  const labels = choices.map((c, i) =>
    i >= start && i < start + PAGE_SIZE_TOKENS
      ? tokenButtonLabel(row(c))
      : `${trendEmoji(c.change24h)} ${c.symbol}`
  );

  const lines = pageItems.map((c) =>
    `${trendEmoji(c.change24h)} <b>${esc(c.symbol)}</b> — ${esc(c.name)}\n   ${tokenDetailLine(row(c))}`
  );

  await toast(userId, chatId,
    [header, '', ...lines, '', `<i>page ${page} · ${choices.length} token(s)</i>`].join('\n'),
    keyboards.tokenChoiceKeyboard(labels, page, PAGE_SIZE_TOKENS, choices.length, !isHoldings));
}

/** Free-text search (state: token_search). */
export async function handleTokenSearchInput(userId: number, chatId: number, user: any, text: string): Promise<void> {
  if (!config.features.multiTokenSwap) { await comingSoon(userId, chatId); return; }

  const query = text.trim().slice(0, 80);
  if (!query) {
    await startTonToToken(userId, chatId, user);
    return;
  }
  await runSearch(userId, chatId, user, query);
}

/** Browse popular tokens (empty query is a BROWSE request, not "no results"). */
export async function browseTokens(userId: number, chatId: number, user: any): Promise<void> {
  if (!config.features.multiTokenSwap) { await comingSoon(userId, chatId); return; }
  user.state = 'token_search';
  user.stateData = { direction: 'ton_to_token' };
  await user.save();
  await runSearch(userId, chatId, user, '');
}

async function runSearch(userId: number, chatId: number, user: any, query: string): Promise<void> {
  if (query && TokenRegistry.isNative(query)) {
    await toast(userId, chatId,
      `${terminalHeader('TON → TOKEN')}\n💎 <b>TON</b> is the native asset you are paying with.\n\nType the token you want to <b>receive</b>.`,
      keyboards.tokenSearchKeyboard());
    return;
  }
  if (query) {
    const asAddr = TokenRegistry.tryNormalize(query);
    if (asAddr && TokenRegistry.isAtf(asAddr)) {
      await toast(userId, chatId,
        `${terminalHeader('TON → TOKEN')}\n🔷 ATF has its own dedicated swap — use <b>TON → ATF</b> from the swap menu.`,
        keyboards.tokenSearchKeyboard());
      return;
    }
  }

  let tokens;
  try {
    tokens = await multiTokenSwapService.searchTokens(query);
  } catch (err: any) {
    // Provider outage is NOT "no results".
    await toast(userId, chatId,
      `${terminalHeader('TOKEN SEARCH')}\n⚠️ Token search is unavailable right now. Please try again shortly.`,
      keyboards.tokenSearchKeyboard());
    console.error('[MultiToken] search failed:', err?.message || err);
    return;
  }

  if (tokens.length === 0) {
    await toast(userId, chatId,
      `${terminalHeader('TOKEN SEARCH')}\n❌ No listed token matches <b>${esc(query.slice(0, 40))}</b>.\n\nTry the exact symbol or the Jetton contract address.`,
      keyboards.tokenSearchKeyboard());
    return;
  }

  user.state = 'token_pick';
  user.stateData = { direction: 'ton_to_token', choices: tokens, query };
  await user.save();

  await showChoices(userId, chatId, user, 1,
    terminalHeader('SELECT TOKEN', query ? `results for "${esc(query.slice(0, 30))}"` : 'popular tokens'));
}

/** TOKEN → TON: load the wallet's actual Jetton balances. */
export async function startTokenToTon(userId: number, chatId: number, user: any): Promise<void> {
  if (!config.features.multiTokenSwap) { await comingSoon(userId, chatId); return; }

  let result;
  try {
    result = await multiTokenSwapService.listWalletTokens(userId);
  } catch (err: any) {
    await toast(userId, chatId,
      `${terminalHeader('TOKEN → TON')}\n⚠️ Could not load your wallet tokens right now. Please try again shortly.`,
      keyboards.multiTokenMenuKeyboard());
    console.error('[MultiToken] wallet discovery failed:', err?.message || err);
    return;
  }

  if (result.holdings.length === 0) {
    await toast(userId, chatId,
      `${terminalHeader('TOKEN → TON')}\nYour wallet holds no swappable tokens with a positive balance.\n\n<i>ATF is swapped from the TON ⇄ ATF screen.</i>`,
      keyboards.multiTokenMenuKeyboard());
    return;
  }

  user.state = 'token_pick';
  user.stateData = { direction: 'token_to_ton', choices: result.holdings };
  await user.save();

  await showChoices(userId, chatId, user, 1, terminalHeader('YOUR TOKENS', 'select one to sell for TON'));
}

export async function showTokenPage(userId: number, chatId: number, user: any, page: number): Promise<void> {
  if (user.state !== 'token_pick') { await onTokenSearch(userId, chatId, user); return; }
  const header = user.stateData?.direction === 'token_to_ton'
    ? terminalHeader('YOUR TOKENS', 'select one to sell for TON')
    : terminalHeader('SELECT TOKEN');
  await showChoices(userId, chatId, user, Math.max(1, page), header);
}

/** A choice was tapped: verify an EXECUTABLE route, then ask for the amount. */
export async function pickToken(userId: number, chatId: number, user: any, index: number): Promise<void> {
  if (!config.features.multiTokenSwap) { await comingSoon(userId, chatId); return; }
  if (user.state !== 'token_pick') { await onTokenSearch(userId, chatId, user); return; }

  const st = user.stateData || {};
  const choice = (st.choices || [])[index];
  if (!choice) { await onTokenSearch(userId, chatId, user); return; }

  const direction: 'ton_to_token' | 'token_to_ton' = st.direction;
  const token = {
    masterAddress: choice.masterAddress,
    symbol: choice.symbol,
    name: choice.name,
    decimals: choice.decimals,
  };

  // Probe with a tenth of the held balance when selling, minimum swap when buying.
  let probe: bigint | undefined;
  if (direction === 'token_to_ton') {
    const held = BigInt(choice.balanceBase);
    probe = held / 10n > 0n ? held / 10n : held;
  }
  const route = await multiTokenSwapService.checkRoute(direction, token, probe);

  if (route === 'no_route') {
    await toast(userId, chatId,
      `${terminalHeader('NO ROUTE')}\n❌ No swap route is available for <b>${esc(token.symbol)}</b> right now.`,
      keyboards.tokenChoiceKeyboard(
        (st.choices || []).map((c: any) => `${trendEmoji(c.change24h)} ${c.symbol}`),
        1, PAGE_SIZE_TOKENS, (st.choices || []).length, direction === 'ton_to_token'));
    return;
  }
  if (route === 'unknown') {
    await toast(userId, chatId,
      `${terminalHeader('ROUTE CHECK')}\n⚠️ Could not check <b>${esc(token.symbol)}</b> just now. Tap it again in a moment.`,
      keyboards.tokenChoiceKeyboard(
        (st.choices || []).map((c: any) => `${trendEmoji(c.change24h)} ${c.symbol}`),
        1, PAGE_SIZE_TOKENS, (st.choices || []).length, direction === 'ton_to_token'));
    return;
  }

  user.state = 'swap_token_amount';
  user.stateData = {
    direction,
    token,
    balanceBase: direction === 'token_to_ton' ? choice.balanceBase : undefined,
  };
  await user.save();

  const inputSym = direction === 'ton_to_token' ? 'TON' : token.symbol;
  const lines = [
    stepHeader('SWAP', direction === 'ton_to_token' ? `TON → ${esc(token.symbol)}` : `${esc(token.symbol)} → TON`),
    '',
    `Enter the amount of <b>${esc(inputSym)}</b> to swap.`,
  ];
  if (direction === 'token_to_ton') {
    lines.push('', `💳 Balance: <code>${fmt(choice.balanceBase, token.decimals)} ${esc(token.symbol)}</code>`);
  } else {
    lines.push('', `📌 Min: <code>${config.minSwapTon} TON</code>`);
    // how much ALL would swap, and what stays behind for network gas
    try {
      const m = await multiTokenSwapService.maxTonSwappable(userId);
      lines.push(
        m.spendNano > 0n
          ? `💯 ALL = <code>${fmt(m.spendNano, TON_DECIMALS)} TON</code> <i>(${fmt(m.reserveNano, TON_DECIMALS)} TON stays in your wallet for network gas)</i>`
          : `⚠️ Your balance is too low to swap — ${fmt(m.reserveNano, TON_DECIMALS)} TON must stay for network gas.`
      );
    } catch {
      // cosmetic line — never block the amount step
    }
  }
  lines.push('', `Type an amount, or tap <b>ALL</b> to use your whole balance.`);
  await toast(userId, chatId, lines.join('\n'), keyboards.tokenAmountKeyboard());
}

function renderQuote(c: any, isAll = false): string {
  const outSym = esc(c.outputSymbol);
  const inSym = esc(c.inputSymbol);
  const lines: string[] = [
    stepHeader('CONFIRM SWAP', `${inSym} → ${outSym}`),
    '',
    `▸ <b>YOU PAY</b>`,
    `<code>${fmt(c.inputBase, c.inputDecimals)} ${inSym}</code>`,
    `├ platform fee (${c.feePlan.platformPercent}%)  <code>${fmt(c.platformFee.amountBase, c.platformFee.decimals)} ${esc(c.platformFee.symbol)}</code>`,
    `└ swaps with  <code>${fmt(c.feePlan.netInputBase, c.inputDecimals)} ${inSym}</code>`,
    '',
    `▸ <b>YOU RECEIVE</b>`,
    `<code>${fmt(c.expectedOutputBase, c.outputDecimals)} ${outSym}</code> (DEX quote)`,
    `└ minimum  <code>${fmt(c.minOutputBase, c.outputDecimals)} ${outSym}</code>`,
  ];

  if (BigInt(c.tonOutputFeeNano) > 0n) {
    lines.push(
      `├ TON output fee (${config.feePolicy.tokenToTonOutputPercent}%)  <code>${fmt(c.tonOutputFeeNano, TON_DECIMALS)} TON</code>`,
      `└ after all fees ≈  <code>${fmt(c.netExpectedOutputBase, c.outputDecimals)} TON</code>  (min <code>${fmt(c.netMinOutputBase, c.outputDecimals)}</code>)`
    );
  }

  // Network costs
  const swapValue = BigInt(c.swapValueNano);
  const netIn = BigInt(c.feePlan.netInputBase);
  const gasAttach = c.direction === 'ton_to_token' ? (swapValue > netIn ? swapValue - netIn : 0n) : swapValue;
  lines.push('', `⛽ <b>NETWORK</b>`, `└ gas attached  <code>${fmt(gasAttach, TON_DECIMALS)} TON</code> <i>(unused part is returned)</i>`);

  if (BigInt(c.advanceNano) > 0n) {
    lines.push(
      `└ platform gas advance  <code>${fmt(c.advanceNano, TON_DECIMALS)} TON</code> <i>— sent to your wallet now and recovered from this swap</i>`
    );
  }

  if (isAll && c.direction === 'ton_to_token') {
    lines.push('', `💯 <b>ALL</b> — the rest of your TON stays in your wallet for network gas`);
  }

  const secs = Math.max(0, Math.floor((new Date(c.expiresAt).getTime() - Date.now()) / 1000));
  lines.push('', `rate  ${esc(c.rate)}`, `<i>quote expires in ~${secs}s — revalidated before sending</i>`);
  return lines.join('\n');
}

/** Amount typed (state: swap_token_amount) → live quote. */
export async function handleTokenSwapAmount(userId: number, chatId: number, user: any, text: string): Promise<void> {
  const { direction, token } = user.stateData || {};
  if (!direction || !token) { await showMainMenu(userId, chatId); return; }

  const amount = text.trim();
  if (/^(all|max)$/i.test(amount)) { await swapAllTokens(userId, chatId, user); return; }
  if (!isValidAmount(amount)) {
    await toast(userId, chatId,
      `${terminalHeader('SWAP')}\n❌ invalid amount — enter a positive number, or tap ALL.`,
      keyboards.tokenAmountKeyboard());
    return;
  }

  await quoteAndShow(userId, chatId, user, direction, token, amount);
}

async function quoteAndShow(
  userId: number, chatId: number, user: any,
  direction: 'ton_to_token' | 'token_to_ton', token: any, amount: string,
  useAll = false
): Promise<void> {
  let confirmation: any;
  try {
    confirmation = useAll
      ? await multiTokenSwapService.prepareAll({ userId, direction, token })
      : await multiTokenSwapService.prepare({ userId, direction, token, amount });
  } catch (err: any) {
    await toast(userId, chatId,
      `${terminalHeader('SWAP')}\n❌ ${friendlyError(err)}`,
      keyboards.tokenAmountKeyboard());
    return; // stay in swap_token_amount so the user can try a smaller amount
  }

  user.state = 'swap_token_confirm';
  user.stateData = { direction, token, amount, all: useAll, confirmation };
  await user.save();

  await toast(userId, chatId, renderQuote(confirmation, useAll), keyboards.tokenConfirmKeyboard());
}

/** Re-quote with the same inputs (quotes live ~30s). */
export async function refreshTokenQuote(userId: number, chatId: number, user: any): Promise<void> {
  const { direction, token, amount, all } = user.stateData || {};
  if (!direction || !token || !amount) { await onTokenSearch(userId, chatId, user); return; }
  await quoteAndShow(userId, chatId, user, direction, token, amount, !!all);
}

/** ALL tapped (or "all" typed): quote the whole swappable balance. */
export async function swapAllTokens(userId: number, chatId: number, user: any): Promise<void> {
  const { direction, token } = user.stateData || {};
  if (!direction || !token) { await showMainMenu(userId, chatId); return; }
  await quoteAndShow(userId, chatId, user, direction, token, 'ALL', true);
}

export async function cancelTokenSwap(userId: number, chatId: number): Promise<void> {
  await clearState(userId);
  await showSwapPair(userId, chatId);
}

/** Confirm tapped. BROADCASTS ONLY — final status comes from the reconciler. */
export async function executeTokenSwap(userId: number, chatId: number, user: any): Promise<void> {
  const st = user.stateData || {};
  const confirmation = st.confirmation;

  if (!config.features.multiTokenSwap || !confirmation) {
    await showMainMenu(userId, chatId);
    return;
  }

  if (new Date() > new Date(confirmation.expiresAt)) {
    await toast(userId, chatId,
      `⏳ <b>Quote expired</b>\n\nTap Refresh for a new quote.`,
      keyboards.tokenConfirmKeyboard());
    return;
  }

  // Leave the confirm state first: a second tap now routes to the main menu,
  // and anything that races past this still hits the idempotency row.
  user.state = 'idle';
  user.stateData = {};
  await user.save();

  await render(userId, chatId,
    `🔄 <b>Sending swap…</b>\n\nbroadcasting to TON ⛓️`,
    { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'back_main' }]] }, { withImage: true });

  try {
    const { transactionId } = await multiTokenSwapService.execute(userId, confirmation);

    // Watch the chain every 2s; the screen flips to COMPLETE the moment the
    // result is proven on-chain (fee + rent recovery then finish behind it).
    const result = await multiTokenSwapService.settle(transactionId, { timeoutMs: 40_000 });
    const meta = (result.tx?.metadata || {}) as Record<string, any>;
    const txHash =
      result.tx?.txHash && /^[0-9a-f]{64}$/i.test(result.tx.txHash) ? result.tx.txHash : '';

    if (result.status === 'completed') {
      // ton→token: the OBSERVED token increase. token→ton: the quoted net (the
      // chain guarantees at least the minimum shown on the quote screen).
      const received =
        confirmation.direction === 'ton_to_token' && BigInt(meta.actualOutputBaseUnits || '0') > 0n
          ? `<code>${fmt(meta.actualOutputBaseUnits, confirmation.outputDecimals)} ${esc(confirmation.outputSymbol)}</code>`
          : `≈ <code>${fmt(confirmation.netExpectedOutputBase, confirmation.outputDecimals)} ${esc(confirmation.outputSymbol)}</code>`;

      await render(userId, chatId,
        [
          `✅ <b>SWAP COMPLETE</b>`,
          '',
          `Paid  <code>${fmt(confirmation.inputBase, confirmation.inputDecimals)} ${esc(confirmation.inputSymbol)}</code>`,
          `Received  ${received}`,
          '',
          `Your balance is updated.`,
          explorerRow(txHash),
        ].join('\n'),
        keyboards.backKeyboard('back_main'), { withImage: true });
      return;
    }

    if (result.status === 'failed') {
      await render(userId, chatId,
        `❌ <b>Swap failed</b>\n\nNothing was swapped and no fee was charged. Your funds are safe in your wallet.`,
        keyboards.multiTokenMenuKeyboard(), { withImage: true });
      return;
    }

    // Still finalizing on-chain (rare): keep watching and report the real result.
    await render(userId, chatId,
      `⏳ <b>Finalizing your swap…</b>\n\nThis is taking a little longer than usual. We'll message you the moment it's done.`,
      keyboards.backKeyboard('back_main'), { withImage: true });
    void followUpSettlement(userId, chatId, transactionId, confirmation);
  } catch (err: any) {
    if (err instanceof SwapInProgressError) {
      // A duplicate tap / retry of a swap that is already being handled.
      await toast(userId, chatId,
        `⏳ This swap is already being processed. Check ◷ Activity for its status.`,
        keyboards.backKeyboard('back_main'));
      return;
    }
    if (err instanceof QuoteExpiredError) {
      await toast(userId, chatId,
        `⏳ <b>Quote expired</b>\n\nStart the swap again for a fresh quote.`,
        keyboards.multiTokenMenuKeyboard());
      return;
    }
    await toast(userId, chatId,
      `❌ <b>Swap not sent</b>\n\n${friendlyError(err)}`,
      keyboards.multiTokenMenuKeyboard());
  }
}


/** Background: keep watching a slow swap and tell the user the real result. */
async function followUpSettlement(userId: number, chatId: number, swapId: string, confirmation: any): Promise<void> {
  try {
    const result = await multiTokenSwapService.settle(swapId, { timeoutMs: 5 * 60_000, pollMs: 3_000 });
    if (result.status === 'completed') {
      await toast(userId, chatId,
        `✅ <b>SWAP COMPLETE</b>\n\n<code>${fmt(confirmation.inputBase, confirmation.inputDecimals)} ${esc(confirmation.inputSymbol)}</code> → ${esc(confirmation.outputSymbol)}\nYour balance is updated.`,
        keyboards.backKeyboard('back_main'));
    } else if (result.status === 'failed') {
      await toast(userId, chatId,
        `❌ <b>Swap failed</b>\n\nNothing was swapped and no fee was charged.`,
        keyboards.multiTokenMenuKeyboard());
    }
  } catch (err) {
    console.error('[MultiToken] follow-up settlement failed:', err);
  }
            }
                                            
