/**
 * Swap screens — TON↔ATF flow + PHASE 2 multi-token swap.
 * Imports context + main-menu (static). Never imported by main-menu at
 * load time (restoreLastAction uses a dynamic import) → no cycles.
 */
import {
  TelegramBot, User, Transaction, Precision, config, TON_DECIMALS, ATF_DECIMALS,
  swapService, priceService, walletService,
  render, toast, clearState,
  terminalHeader, stepHeader, explorerRow, fmtMoney, marketMovement,
  isValidAmount,
  getActiveWallet,
} from '../context';
import { showMainMenu } from './main-menu';
import * as keyboards from '../keyboards';
import { TokenRegistry } from '../../services/token-registry';

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
    tonPrice ? `💎 TON <code>$${tonPrice.price.toFixed(2)}</code> · ${marketMovement(tonPrice)}` : `💎 TON <i>⏳ price unavailable</i>`,
    atfPrice ? `🔷 ATF <code>$${atfPrice.price.toFixed(6)}</code> · ${marketMovement(atfPrice)}` : `🔷 ATF <i>⏳ price unavailable</i>`,
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
    `💳 you have  <code>${Precision.formatDisplay(balance)} ${sym}</code>`,
    isTonToAtf ? `📌 minimum   <code>${config.minSwapTon} TON</code>` : '',
    '',
    `Type the amount to swap:`,
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
      `<code>${Precision.formatDisplay(confirmation.expectedOutput)} ${outSym}</code>${receiveUsd ? `  <i>≈ $${fmtMoney(receiveUsd)}</i>` : ''}`,
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

  await render(userId, chatId, `🔄 <b>Swapping…</b>\n\n<i>broadcasting to TON ⛓️</i>`, { inline_keyboard: [] }, { withImage: true });

  try {
    const txId = await swapService.executeSwap(userId, confirmation, direction);
    await Transaction.findByIdAndUpdate(txId, { status: 'completed' });
    const txRecord = await Transaction.findById(txId);
    const txHash = txRecord?.txHash || '';
    const isTonToAtf = direction === 'ton_to_atf';
    const inSym = isTonToAtf ? 'TON' : 'ATF';
    const outSym = isTonToAtf ? 'ATF' : 'TON';

    const caption = [
      `✅ <b>SWAP EXECUTED</b>`,
      '',
      `<code>${Precision.formatDisplay(confirmation.inputAmount)} ${inSym}</code> → <code>${Precision.formatDisplay(confirmation.expectedOutput)} ${outSym}</code>`,
      `└ settled in ~3–6s`,
      explorerRow(txHash),
      '',
      `<i>funds are in your wallet ✅</i>`,
    ].filter(Boolean).join('\n');

    await clearState(userId);
    await render(userId, chatId, caption, keyboards.backKeyboard('back_main'), { withImage: true });
  } catch (error: any) {
    await toast(userId, chatId, `❌ <b>Swap failed</b>\n\n${error.message}`, keyboards.backKeyboard('swap'));
  }
}

/* ═══════════════════════════════════════════════════════════
   PHASE 2 — MULTI-TOKEN SWAP UI
   ═══════════════════════════════════════════════════════════ */

const PAGE_SIZE_TOKENS = 8;

export async function showTokenList(userId: number, chatId: number, direction: string, page: number): Promise<void> {
  if (!config.features.multiTokenSwap) {
    await toast(userId, chatId, '⏳ <i>coming soon</i>', keyboards.tokenSearchKeyboard());
    return;
  }

  try {
    const { items, total } = await TokenRegistry.search('', page, PAGE_SIZE_TOKENS);

    await toast(userId, chatId,
      [
        terminalHeader('SELECT TOKEN'),
        `page ${page} · ${total} token(s)`,
        '',
        `<i>verified &amp; community tokens with executable routes only.</i>`,
      ].join('\n'),
      keyboards.tokenListKeyboard(
        items.map((t) => ({ masterAddress: t.masterAddress, symbol: t.symbol })),
        page,
        page * PAGE_SIZE_TOKENS < total,
        direction
      ));
  } catch (err: any) {
    await toast(userId, chatId,
      `❌ <i>token list unavailable: ${String(err.message).slice(0, 200)}</i>`,
      keyboards.tokenSearchKeyboard());
  }
}

/** Callback entry for the 'token_search' button (routes through feature gate). */
export async function onTokenSearch(userId: number, chatId: number, user: any): Promise<void> {
  if (!config.features.multiTokenSwap) {
    await toast(userId, chatId, '⏳ <i>coming soon</i>', keyboards.swapPairKeyboard());
    return;
  }

  user.state = 'token_search';
  user.stateData = { direction: user.stateData?.direction ?? 'ton_to_token' };
  await user.save();

  await toast(userId, chatId,
    `${terminalHeader('TOKEN SEARCH')}\nType a token <b>name</b>, <b>symbol</b>, or exact <b>contract address</b>.`,
    keyboards.tokenSearchKeyboard());
}

export async function handleTokenSearchInput(userId: number, chatId: number, user: any, text: string): Promise<void> {
  const direction = user.stateData?.direction ?? 'ton_to_token';

  if (!config.features.multiTokenSwap) {
    await toast(userId, chatId, '⏳ <i>coming soon</i>', keyboards.tokenSearchKeyboard());
    return;
  }

  const query = text.trim().slice(0, 60);
  if (!query) {
    await toast(userId, chatId,
      `${terminalHeader('TOKEN SEARCH')}\nType a token <b>name</b>, <b>symbol</b>, or exact <b>contract address</b>.`,
      keyboards.tokenSearchKeyboard());
    return;
  }

  try {
    const { items, total } = await TokenRegistry.search(query, 1, PAGE_SIZE_TOKENS);

    if (!total) {
      await toast(userId, chatId,
        `${terminalHeader('TOKEN SEARCH')}\n❌ nothing supported found for <b>${query.slice(0, 40)}</b>.\n\n<i>search by name, symbol, or exact contract address.</i>`,
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
      `❌ <i>search failed: ${String(err.message).slice(0, 200)}</i>`,
      keyboards.tokenSearchKeyboard());
  }
}

export async function startTokenSwapInput(userId: number, chatId: number, direction: string, master: string): Promise<void> {
  if (!config.features.multiTokenSwap) {
    await toast(userId, chatId, '⏳ <i>coming soon</i>', keyboards.tokenSearchKeyboard());
    return;
  }

  const token = await TokenRegistry.resolve(master);
  if (!token) {
    await toast(userId, chatId,
      `${terminalHeader('SWAP')}\n❌ <i>token unavailable, unverified, or route unsupported.</i>`,
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
      stepHeader('SWAP', `${direction === 'ton_to_token' ? 'TON → ' + token.symbol : token.symbol + ' → TON'}`),
      '',
      `Type the amount of <b>${inputName}</b> to swap:`,
    ].join('\n'),
    keyboards.cancelKeyboard('swap'));
}

export async function handleTokenSwapAmount(userId: number, chatId: number, user: any, text: string): Promise<void> {
  const { direction, tokenMaster, tokenSymbol, tokenDecimals } = user.stateData || {};
  if (!direction || !tokenMaster) { await showMainMenu(userId, chatId); return; }

  const amount = text.trim();
  if (!isValidAmount(amount) || Number(amount) <= 0) {
    await toast(userId, chatId,
      `${terminalHeader('SWAP')}\n❌ <i>invalid amount — enter a positive number.</i>`,
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
      `├ platform fee (${fp.platformPercent}%)  <code>${confirmation.platformFee}</code> ${inputSymbol} <i>from input</i>`
    );
  } else {
    feeLines.push(
      `├ platform fee (${fp.platformPercent}%)  <code>${Precision.fromBaseUnits(BigInt(fp.platformFeeOutputBase), tokenDecimals)}</code> ${outputSymbol} <i>from output</i>`
    );
  }
  if (fp.tonOutputFeeBase && fp.tonOutputFeeBase !== '0') {
    feeLines.push(
      `├ TON output fee (${config.feePolicy.tokenToTonOutputPercent}%)  <code>${Precision.fromBaseUnits(BigInt(fp.tonOutputFeeBase), TON_DECIMALS)}</code> TON`
    );
  }

  await toast(userId, chatId,
    [
      stepHeader('CONFIRM SWAP', `${inputSymbol} → ${outputSymbol}`),
      '',
      `<code>${confirmation.inputAmount}</code> ${inputSymbol}`,
      ...feeLines,
      `└ you receive  <code>${confirmation.expectedOutput}</code> ${outputSymbol}`,
      `   minimum    <code>${confirmation.minOutput}</code> ${outputSymbol}`,
      `⛽ DEX costs   <code>${confirmation.dexCosts}</code> TON`,
      '',
      `<i>quote valid until ${new Date(confirmation.expiresAt).toLocaleTimeString()} — revalidated before execution.</i>`,
    ].join('\n'),
    { inline_keyboard: [
      [{ text: '✅ Confirm Swap', callback_data: 'confirm_token_swap' }],
      [{ text: '❌ Cancel', callback_data: 'swap' }],
    ] });
}

export async function executeTokenSwap(userId: number, chatId: number, user: any): Promise<void> {
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
    `🔄 <b>Swapping…</b>\n\n<i>broadcasting to TON ⛓️</i>`,
    { inline_keyboard: [] }, { withImage: true });

  try {
    const txId = await swapService.executeTokenSwap(userId, confirmation, tokenDecimals);
    const txRecord = await Transaction.findById(txId);
    const txHash = txRecord?.txHash || '';

    await render(userId, chatId,
      [
        `✅ <b>SWAP SUBMITTED</b>`,
        '',
        `<code>${confirmation.inputAmount}</code> sent`,
        `└ expect ~<code>${confirmation.expectedOutput}</code> back`,
        explorerRow(txHash),
        '',
        `<i>track final status in ◷ Activity.</i>`,
      ].filter(Boolean).join('\n'),
      keyboards.backKeyboard('back_main'), { withImage: true });
  } catch (err: any) {
    await toast(userId, chatId,
      `❌ <b>Swap failed</b>\n\n<i>${String(err.message).slice(0, 300)}</i>`,
      keyboards.tokenSearchKeyboard());
  }
}
  
