/**
 * Transfer screens — deposit flow + withdrawal flow.
 * Imports context + main-menu (static). No cycles.
 */
import {
  TelegramBot, User, Transaction, Precision, config, TON_DECIMALS, ATF_DECIMALS,
  withdrawalService, walletService,
  render, toast, clearState,
  terminalHeader, stepHeader, explorerRow,
  isValidTonAddress, isValidAmount, formatAddressShort,
  getActiveWallet,
} from '../context';
import { showMainMenu } from './main-menu';
import * as keyboards from '../keyboards';

/* ───────────────────────────────────────────────────────────────────────────
   📥 DEPOSIT FLOW
   ─────────────────────────────────────────────────────────────────────────── */

export async function showDepositMenu(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.lastAction = 'deposit';
    await user.save();
  }

  const wallet = await getActiveWallet(userId);

  const caption = [
    terminalHeader('DEPOSIT', 'fund your account — assets credited on-chain'),
    '',
    ...(wallet
      ? [`◉ 🗝 <b>YOUR WALLET</b>`, `<code>${wallet.address}</code>`, '']
      : [`⚠️ <b>No active wallet</b> — tap ▣ Wallet first`, '']),
    `💎 <b>TON</b> — native coin`,
    `🔷 <b>ATF</b> — jetton`,
    '',
    `<i>⛓ both are detected and credited automatically.</i>`,
  ].join('\n');

  await render(userId, chatId, caption, keyboards.depositKeyboard(), { withImage: true });
}

export async function showDepositTon(userId: number, chatId: number): Promise<void> {
  const wallet = await getActiveWallet(userId);
  if (!wallet) {
    await toast(userId, chatId, '⚠️ <b>No active wallet</b> — create one first.', keyboards.depositKeyboard());
    return;
  }

  await render(userId, chatId, [
    stepHeader('DEPOSIT TON'),
    '',
    `Send TON (any amount above the network fee) to:`,
    '',
    `<code>${wallet.address}</code>`,
    '',
    `<i>⛓ credited automatically in ~30s</i>`,
  ].join('\n'), keyboards.depositTonScreen(wallet.address), { withImage: true });
}

export async function showDepositAtf(userId: number, chatId: number): Promise<void> {
  const wallet = await getActiveWallet(userId);
  if (!wallet) {
    await toast(userId, chatId, '⚠️ <b>No active wallet</b> — create one first.', keyboards.depositKeyboard());
    return;
  }

  await render(userId, chatId, [
    stepHeader('DEPOSIT ATF'),
    '',
    `Send ATF to your wallet address:`,
    '',
    `<code>${wallet.address}</code>`,
    '',
    `<i>⛓ jetton deposits are detected automatically.</i>`,
  ].join('\n'), keyboards.depositAtfScreen(), { withImage: true });
}

export async function checkDepositStatus(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  const wallet = await getActiveWallet(userId);
  if (!wallet?.address) {
    await toast(userId, chatId, '❌ <b>Wallet not found.</b>', keyboards.backKeyboard('deposit'));
    return;
  }

  await render(userId, chatId, `🔍 <b>Checking ${asset}…</b>\n\n<i>scanning the chain ⛓️</i>`, {
    inline_keyboard: [[{ text: '🔙 Back', callback_data: `deposit_${asset.toLowerCase()}` }]],
  }, { withImage: true });

  try {
    const onChain = await walletService.getBalance(wallet.address);
    const balance = asset === 'TON'
      ? Precision.fromBaseUnits(onChain.ton, TON_DECIMALS)
      : Precision.fromBaseUnits(onChain.atf, ATF_DECIMALS);

    await toast(userId, chatId, [
      `◉ <b>${asset} BALANCE</b>`,
      '',
      `<code>${Precision.formatDisplay(balance)} ${asset}</code>`,
    ].join('\n'), keyboards.backKeyboard(`deposit_${asset.toLowerCase()}`));
  } catch (error: any) {
    await toast(userId, chatId, `❌ ${error.message}`, keyboards.backKeyboard('deposit'));
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   📤 WITHDRAWAL FLOW
   ─────────────────────────────────────────────────────────────────────────── */

export async function showWithdrawMenu(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.lastAction = 'withdraw';
    await user.save();
  }

  await render(userId, chatId, [
    terminalHeader('WITHDRAW', 'send assets to any TON address'),
    '',
    `💎 <b>TON</b> — native coin`,
    `🔷 <b>ATF</b> — jetton`,
    '',
    `⚠️ <i>sends cannot normally be reversed.</i>`,
  ].join('\n'), keyboards.withdrawAssetKeyboard(), { withImage: true });
}

export async function startWithdrawal(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.state = `withdraw_address_${asset}`;
  user.stateData = {};
  await user.save();

  await render(userId, chatId, [
    stepHeader(`WITHDRAW ${asset}`, 'step 1/2 · destination'),
    '',
    `Which TON address should receive the ${asset}?`,
    '',
    `<i>Paste EQD… / UQD…</i>`,
  ].join('\n'), keyboards.cancelKeyboard('withdraw'), { withImage: true });
}

export async function handleWithdrawAddress(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('withdraw_address_')) return;

  const asset = user.state.replace('withdraw_address_', '') as 'TON' | 'ATF';
  if (!isValidTonAddress(text)) {
    await toast(userId, chatId, '❌ That doesn\u2019t look like a TON address — try again.', keyboards.cancelKeyboard('withdraw'));
    return;
  }

  user.state = `withdraw_amount_${asset}`;
  user.stateData = { address: text };
  await user.save();

  await render(userId, chatId, [
    stepHeader(`WITHDRAW ${asset}`, 'step 2/2 · amount'),
    '',
    `To: <code>${formatAddressShort(text)}</code>`,
    '',
    `How much ${asset} do you want to send?`,
  ].join('\n'), keyboards.cancelKeyboard('withdraw'), { withImage: true });
}

export async function handleWithdrawAmount(userId: number, chatId: number, text: string): Promise<void> {
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
      stepHeader('CONFIRM WITHDRAWAL'),
      '',
      `<code>${Precision.formatDisplay(prep.amount)} ${asset}</code>`,
      `→ <code>${formatAddressShort(prep.toAddress)}</code>`,
      '',
      `├ network fee  ≈ <code>${prep.networkCost} TON</code>`,
      `└ they get     <code>${Precision.formatDisplay(prep.receiveAmount)} ${asset}</code>`,
      '',
      `⚠️ <i>Cannot be reversed — verify the address above.</i>`,
    ].join('\n'), keyboards.confirmWithdrawalKeyboard(), { withImage: true });
  } catch (error: any) {
    await toast(userId, chatId, `❌ ${error.message}`, keyboards.cancelKeyboard('withdraw'));
  }
}

export async function executeWithdrawal(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || !user.state.startsWith('withdraw_confirm_')) {
    await showMainMenu(userId, chatId);
    return;
  }

  const asset = user.state.replace('withdraw_confirm_', '') as 'TON' | 'ATF';
  const { address, amount } = user.stateData;

  await render(userId, chatId, `📡 <b>Sending ${asset}…</b>\n\n<i>signing &amp; broadcasting ⛓️</i>`, { inline_keyboard: [] }, { withImage: true });

  try {
    const txId = await withdrawalService.executeWithdrawal({
      userId,
      asset,
      amount,
      toAddress: address,
    });

    const txRecord = await Transaction.findById(txId);
    const txHash = txRecord?.txHash || '';

    await clearState(userId);
    await render(userId, chatId, [
      `✅ <b>WITHDRAWAL SENT</b>`,
      '',
      `<code>${amount} ${asset}</code> → <code>${formatAddressShort(address)}</code>`,
      `└ confirmed in ~3s`,
      explorerRow(txHash),
      '',
      `<i>check your destination wallet ✅</i>`,
    ].filter(Boolean).join('\n'), keyboards.backKeyboard('back_main'), { withImage: true });
  } catch (error: any) {
    await toast(userId, chatId, `❌ <b>Withdrawal failed</b>\n\n${error.message}`, keyboards.cancelKeyboard('withdraw'));
  }
}
