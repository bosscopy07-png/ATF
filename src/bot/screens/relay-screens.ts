/**
 * PHASE 4 — Transfer Relay UI + PHASE 5 admin relay view.
 * Imports context + main-menu (static). No cycles.
 */
import {
  TelegramBot, User, Precision, config, TON_DECIMALS,
  relayService,
  render, toast,
  terminalHeader, stepHeader,
  isValidTonAddress, isValidAmount, formatAddressShort,
  requireAdmin,
  reviveRelayQuote,
} from '../context';
import type { RelayQuote } from '../context';
import { showMainMenu } from './main-menu';
import * as keyboards from '../keyboards';

/* ───────────────────────────────────────────────────────────────────────────
   🚀 TRANSFER RELAY UI
   ─────────────────────────────────────────────────────────────────────────── */

export async function showRelayHome(userId: number, chatId: number, user: any): Promise<void> {
  if (!config.features.transferRelay) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n⏳ <i>coming soon</i>`,
      keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
    return;
  }

  try {
    await relayService.ensureAddresses(userId);
  } catch (err: any) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n⚠️ <i>unavailable: ${String(err.message).slice(0, 200)}</i>`,
      keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
    return;
  }

  const addresses = await relayService.listAddresses(userId);

  if (user.lastAction !== 'transfer_relay') {
    await User.updateOne({ _id: user._id }, { $set: { lastAction: 'transfer_relay' } }).catch(() => {});
  }

  await toast(userId, chatId,
    [
      terminalHeader('TRANSFER RELAY', 'send TON via a dedicated relay address'),
      '',
      `📋 <b>${addresses.length}</b> relay address${addresses.length !== 1 ? 'es' : ''} ready`,
      '',
      `├ each used address rests <code>${config.relay.reuseCooldownDays}</code> days before reuse`,
      `└ platform-managed — reliable, but <b>not</b> anonymous`,
      '',
      `<i>Select an address below to start a transfer.</i>`,
    ].join('\n'),
    keyboards.relayMenuKeyboard(addresses.length > 0));
}

export async function showRelayAddresses(userId: number, chatId: number, user: any): Promise<void> {
  const addresses = await relayService.listAddresses(userId);

  const rows: TelegramBot.InlineKeyboardButton[][] = addresses.map((a: any) => [
    {
      text: `📤 ${a.label} · ${a.address.slice(0, 6)}…${a.address.slice(-4)}${a.nextEligibleAt && a.nextEligibleAt.getTime() > Date.now() ? ' ⏳' : ''}`,
      callback_data: `relay_sel_${a._id.toString()}`,
    },
  ]);
  rows.push([{ text: '‹ Relay', callback_data: 'transfer_relay' }]);

  await toast(userId, chatId,
    `${stepHeader('SELECT RELAY ADDRESS')}\n<i>⏳ = cooling down (${config.relay.reuseCooldownDays}-day reuse rule)</i>`,
    { inline_keyboard: rows });
}

export async function startRelayAmount(userId: number, chatId: number, user: any, relayId: string): Promise<void> {
  user.state = 'relay_amount';
  user.stateData = { relayId };
  await user.save();

  await toast(userId, chatId,
    `${stepHeader('TRANSFER RELAY', 'step 1/2 · amount')}\nHow much <b>TON</b> should reach the destination?`,
    keyboards.cancelKeyboard('transfer_relay'));
}

export async function handleRelayAmount(userId: number, chatId: number, user: any, text: string): Promise<void> {
  const relayId = user.stateData?.relayId;
  if (!relayId) { await showMainMenu(userId, chatId); return; }

  if (!isValidAmount(text)) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n❌ <i>Invalid amount — enter a positive number.</i>`,
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
      stepHeader('TRANSFER RELAY', 'step 2/2 · destination'),
      '',
      `📤 via <b>${quote.label}</b> <code>${formatAddressShort(quote.relayAddress)}</code>`,
      '',
      `Now enter the <b>destination TON address</b>:`,
    ].join('\n'),
    keyboards.cancelKeyboard('transfer_relay'));
}

export async function handleRelayAddress(userId: number, chatId: number, user: any, text: string): Promise<void> {
  const rawQuote = user.stateData?.quote;
  if (!rawQuote) { await showMainMenu(userId, chatId); return; }
  const quote = reviveRelayQuote(rawQuote);

  const destination = text.trim();

  if (!isValidTonAddress(destination)) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n❌ <i>Invalid TON address — check and re-enter.</i>`,
      keyboards.cancelKeyboard('transfer_relay'));
    return;
  }

  user.state = 'relay_confirm';
  user.stateData = { ...user.stateData, destination };
  await user.save();

  await toast(userId, chatId,
    [
      stepHeader('CONFIRM TRANSFER', quote.label),
      '',
      `🏁 destination  <code>${formatAddressShort(destination)}</code>`,
      `📤 via relay    <code>${formatAddressShort(quote.relayAddress)}</code>`,
      '',
      `▸ <b>COSTS</b>`,
      `💎 arrives at destination  <code>${Precision.fromBaseUnits(quote.requestedNano, 9)} TON</code>`,
      `├ platform fee (${config.feePolicy.relayTransferPercent}%)  <code>${Precision.fromBaseUnits(quote.platformFeeNano, 9)} TON</code>`,
      `└ est. network  <code>~${Precision.fromBaseUnits(quote.forwardFeeEstimateNano + config.relay.minRelayReserveNano, 9)} TON</code>`,
      '',
      `💰 <b>total debit  <code>${Precision.fromBaseUnits(quote.totalDebitNano, 9)} TON</code></b>`,
      '',
      `<i>Platform fee and network costs are distinct. Network costs are estimates — the destination receives the requested amount only if on-chain conditions satisfy it, otherwise the operation is flagged for recovery, never silently short-paid.</i>`,
    ].join('\n'),
    keyboards.relayConfirmKeyboard());
}

export async function executeRelayTransfer(userId: number, chatId: number, user: any): Promise<void> {
  const rawQuote = user.stateData?.quote;
  const destination = user.stateData?.destination;
  if (!rawQuote || !destination) { await showMainMenu(userId, chatId); return; }
  const quote = reviveRelayQuote(rawQuote);

  user.state = 'idle';
  user.stateData = {};
  await user.save();

  try {
    const operationId = await relayService.execute(userId, quote, destination);
    await toast(userId, chatId,
      `🚀 <b>Transfer relayed</b>\n\nOperation <code>${operationId.slice(0, 13)}</code>\nTrack it in 🧾 Relay History.`,
      keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
  } catch (err: any) {
    // Loud failure: full stack to the log so root causes are visible
    console.error('[Relay] execute failed:', err);
    await toast(userId, chatId,
      `❌ <b>Transfer failed</b>\n\n<i>${String(err.message).slice(0, 300)}</i>\n\nCheck 🧾 Relay History for state.`,
      keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
  }
}

export async function showRelayHistory(userId: number, chatId: number, user: any): Promise<void> {
  const { items } = await relayService.history(userId, 1);

  if (!items.length) {
    await toast(userId, chatId,
      `${terminalHeader('RELAY HISTORY')}\n<i>No relay transfers yet.</i>`,
      keyboards.relayMenuKeyboard(false));
    return;
  }

  const lines = items.map((op: any) =>
    `${op.state === 'COMPLETED' ? '🟢' : op.state === 'FAILED' || op.state === 'EXPIRED' ? '🔴' : '🟡'} ` +
    `<code>${Precision.fromBaseUnits(BigInt(op.requestedAmountNano), 9)} TON</code> → ` +
    `<code>${op.destinationAddress.slice(0, 6)}…${op.destinationAddress.slice(-4)}</code>\n` +
    `   <i>${op.state}</i> · ${op.createdAt.toLocaleDateString()}` +
    (op.outgoingTxHash ? `\n   🔗 <code>${op.outgoingTxHash.slice(0, 16)}…</code>` : '')
  );

  await toast(userId, chatId,
    `${terminalHeader('RELAY HISTORY')}\n${lines.join('\n\n')}`,
    keyboards.relayMenuKeyboard(true));
}

/* ═══════════════════════════════════════════════════════════
   PHASE 5 — ADMIN: TRANSFER RELAY DASHBOARD (Telegram view)
   ═══════════════════════════════════════════════════════════ */

export async function showAdminRelay(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const { RelayAddress } = await import('../../models/RelayAddress');
    const { TransferOperation } = await import('../../models/TransferOperation');

    const [totalAddresses, activeAddresses, recoveryRequired, inFlight] = await Promise.all([
      RelayAddress.countDocuments(),
      RelayAddress.countDocuments({ status: 'active' }),
      RelayAddress.countDocuments({ status: 'recovery_required' }),
      TransferOperation.countDocuments({
        state: { $in: ['FUNDING', 'FUNDED', 'SENDING', 'RECOVERY_REQUIRED'] },
      }),
    ]);

    await render(userId, chatId, [
      stepHeader('RELAY DASHBOARD'),
      '',
      `📋 total addresses  <b>${totalAddresses}</b>`,
      `├ active  <b>${activeAddresses}</b>`,
      `└ recovery required  <b>${recoveryRequired}</b>`,
      '',
      `⏳ in-flight operations  <b>${inFlight}</b>`,
      '',
      `<i>Full management lives in the web admin console → Relay.</i>`,
      `<i>Signing material is never displayed here.</i>`,
    ].join('\n'), keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    const m = await import('./admin-screens');
    await m.showAdminPanel(userId, chatId);
  }
}
  
