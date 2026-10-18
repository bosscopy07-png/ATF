/**
 * PHASE 4 — Transfer Relay UI (auto-funded from the user's custodial wallet)
 * + PHASE 5 admin relay dashboard.
 *
 * Flow: amount → confirm debit → bot sends (amount+fee+reserve) from the
 * user's wallet to the relay → destination → confirm → one relay tx
 * (fee → admin wallet, amount → destination) → verified completion.
 * Imports context + main-menu (static). No cycles.
 */
import {
  TelegramBot, User, Precision, config, TON_DECIMALS,
  relayService,
  render, toast,
  terminalHeader, stepHeader,
  isValidTonAddress, isValidAmount, formatAddressShort,
  requireAdmin, requireSuperAdmin,
  reviveRelayQuote,
} from '../context';
import type { RelayQuote } from '../context';
import { showMainMenu } from './main-menu';
import * as keyboards from '../keyboards';

/* ───────────────────────────────────────────────────────────────────────────
   🚀 TRANSFER RELAY UI (user-facing)
   ─────────────────────────────────────────────────────────────────────────── */

export async function showRelayHome(userId: number, chatId: number, user: any): Promise<void> {
  if (!config.features.transferRelay) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n⏳ coming soon`,
      keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin));
    return;
  }

  try {
    await relayService.ensureAddresses(userId);
  } catch (err: any) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n⚠️ unavailable: ${String(err.message).slice(0, 200)}`,
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
      `▸ <b>HOW IT WORKS</b>`,
      `1️⃣ pick an address &amp; amount`,
      `2️⃣ we move the TON to the relay (from your wallet)`,
      `3️⃣ enter the destination — we relay it`,
      '',
      `├ used addresses rest <code>${config.relay.reuseCooldownDays}</code> days before reuse`,
      `└ platform-managed — reliable, but <b>not</b> anonymous`,
      '',
      `Select an address below to start.`,
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
    `${stepHeader('SELECT RELAY ADDRESS')}\n⏳ = cooling down (${config.relay.reuseCooldownDays}-day reuse rule)`,
    { inline_keyboard: rows });
}

/* ── Step 1: amount → debit preview ── */

export async function startRelayAmount(userId: number, chatId: number, user: any, relayId: string): Promise<void> {
  user.state = 'relay_amount';
  user.stateData = { relayId };
  await user.save();

  await toast(userId, chatId,
    `${stepHeader('TRANSFER RELAY', 'step 1/3 · amount')}\nHow much <b>TON</b> should reach the destination?`,
    keyboards.cancelKeyboard('transfer_relay'));
}

export async function handleRelayAmount(userId: number, chatId: number, user: any, text: string): Promise<void> {
  const relayId = user.stateData?.relayId;
  if (!relayId) { await showMainMenu(userId, chatId); return; }

  if (!isValidAmount(text)) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n❌ Invalid amount — enter a positive number.`,
      keyboards.cancelKeyboard('transfer_relay'));
    return;
  }

  let quote: RelayQuote;
  try {
    quote = await relayService.prepareQuote(userId, relayId, text.trim());
  } catch (err: any) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n❌ ${String(err.message).slice(0, 300)}`,
      keyboards.backKeyboard('transfer_relay'));
    return;
  }

  user.state = 'relay_fundconfirm';
  user.stateData = { relayId, quote };
  await user.save();

  await toast(userId, chatId,
    [
      stepHeader('CONFIRM DEBIT', 'step 2/3 · from your custodial wallet'),
      '',
      `▸ <b>DESTINATION RECEIVES</b>`,
      `💎 <code>${Precision.fromBaseUnits(quote.requestedNano, 9)} TON</code>`,
      '',
      `├ platform fee (${config.feePolicy.relayTransferPercent}%)  <code>${Precision.fromBaseUnits(quote.platformFeeNano, 9)} TON</code>`,
      `└ est. network reserve  <code>${Precision.fromBaseUnits(quote.forwardFeeEstimateNano, 9)} TON</code>`,
      '',
      `▸ <b>TOTAL DEBITED FROM YOUR WALLET</b>`,
      `💰 <code>${Precision.fromBaseUnits(quote.fundingAmountNano, 9)} TON</code>`,
      '',
      `Moves TON from your custodial wallet to relay <code>${formatAddressShort(quote.relayAddress)}</code>. Unused reserve stays on the relay.`,
    ].join('\n'),
    { inline_keyboard: [
      [{ text: '✅ Continue — Debit My Wallet', callback_data: 'relay_fundgo' }],
      [{ text: '❌ Cancel', callback_data: 'transfer_relay' }],
    ] });
}

/* ── Step 2: execute the debit (idempotent, re-checkable) ── */

export async function fundRelayFromWallet(userId: number, chatId: number, user: any): Promise<void> {
  const rawQuote = user.stateData?.quote;
  if (!rawQuote) { await showMainMenu(userId, chatId); return; }
  const quote = reviveRelayQuote(rawQuote);

  await render(userId, chatId,
    `🔄 <b>Moving TON to your relay…</b>\n\ndebiting <code>${Precision.fromBaseUnits(quote.fundingAmountNano, 9)} TON</code> from your wallet ⛓️`,
    { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'back_main' }]] }, { withImage: true });

  try {
    await relayService.fundRelay(userId, quote);

    user.state = 'relay_address';
    await user.save();

    await toast(userId, chatId,
      [
        `✅ <b>FUNDS IN PLACE</b>`,
        '',
        `<code>${Precision.fromBaseUnits(quote.fundingAmountNano, 9)} TON</code> on relay <code>${formatAddressShort(quote.relayAddress)}</code>`,
        '',
        `Now enter the <b>destination TON address</b>:`,
      ].join('\n'),
      keyboards.cancelKeyboard('transfer_relay'));
  } catch (err: any) {
    console.error('[Relay] fundRelay failed:', err);
    await toast(userId, chatId,
      `❌ <b>Could not fund the relay</b>\n\n${String(err.message).slice(0, 300)}`,
      { inline_keyboard: [
        [{ text: '⟳ Retry', callback_data: 'relay_fundgo' }],
        [{ text: '♻️ Reclaim TON', callback_data: 'relay_reclaim' }],
        [{ text: '‹ Relay', callback_data: 'transfer_relay' }],
      ] });
  }
}

/* ── Step 3: destination → confirm → execute ── */

export async function handleRelayAddress(userId: number, chatId: number, user: any, text: string): Promise<void> {
  const rawQuote = user.stateData?.quote;
  if (!rawQuote) { await showMainMenu(userId, chatId); return; }
  const quote = reviveRelayQuote(rawQuote);

  const destination = text.trim();

  if (!isValidTonAddress(destination)) {
    await toast(userId, chatId,
      `${terminalHeader('TRANSFER RELAY')}\n❌ Invalid TON address — check and re-enter.`,
      keyboards.cancelKeyboard('transfer_relay'));
    return;
  }

  user.state = 'relay_confirm';
  user.stateData = { ...user.stateData, destination };
  await user.save();

  await toast(userId, chatId,
    [
      stepHeader('CONFIRM TRANSFER', 'step 3/3'),
      '',
      `🏁 destination  <code>${formatAddressShort(destination)}</code>`,
      `📤 via relay    <code>${formatAddressShort(quote.relayAddress)}</code>`,
      '',
      `▸ <b>DISTRIBUTION</b>`,
      `💎 to destination  <code>${Precision.fromBaseUnits(quote.requestedNano, 9)} TON</code>`,
      `├ platform fee (${config.feePolicy.relayTransferPercent}%)  <code>${Precision.fromBaseUnits(quote.platformFeeNano, 9)} TON</code> → admin`,
      `└ network costs  from relay reserve (est. ${Precision.fromBaseUnits(quote.forwardFeeEstimateNano, 9)} TON)`,
      '',
      `One on-chain transaction from the relay pays the platform fee and your transfer together.`,
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

  // Immediate feedback — this exact message auto-edits when done
  await render(userId, chatId,
    `🚀 <b>RELAY TRANSFER PROCESSING…</b>\n\n⛓ Broadcasting from the relay — usually under 30 seconds.\nThis message updates automatically. Please wait.`,
    { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'back_main' }]] }, { withImage: true });

  try {
    const operationId = await relayService.execute(userId, quote, destination);

    const { TransferOperation } = await import('../../models/TransferOperation');
    const op = await TransferOperation.findOne({ operationId });
    const txHash = op?.outgoingTxHash || '';
    const link = txHash && !txHash.includes('_') ? `https://tonscan.org/tx/${txHash}` : '';

    await render(userId, chatId,
      [
        `✅ <b>TRANSFER RELAYED</b>`,
        ``,
        `💎 Amount: <code>${Precision.fromBaseUnits(quote.requestedNano, 9)} TON</code>`,
        `🏁 Destination: <code>${destination}</code>`,
        `📤 Via relay: <code>${formatAddressShort(quote.relayAddress)}</code>`,
        link ? `🔗 <a href="${link}">View on Tonscan</a>` : (txHash ? `🔗 Tx: <code>${txHash.slice(0, 20)}…</code>` : ''),
        ``,
        `Operation: <code>${operationId.slice(0, 13)}</code>`,
      ].filter(Boolean).join('\n'),
      keyboards.mainMenuKeyboard(user.isAdmin || user.isSuperAdmin), { withImage: true });
  } catch (err: any) {
    console.error('[Relay] execute failed:', err);
    await render(userId, chatId,
      `❌ <b>Transfer failed</b>\n\n${String(err.message).slice(0, 300)}`,
      { inline_keyboard: [
        [{ text: '♻️ Reclaim TON', callback_data: 'relay_reclaim' }],
        [{ text: '🧾 Relay History', callback_data: 'relay_history' }],
        [{ text: '🏠 Main Menu', callback_data: 'back_main' }],
      ] }, { withImage: true });
  }
}

export async function showRelayHistory(userId: number, chatId: number, user: any): Promise<void> {
  const { items } = await relayService.history(userId, 1);

  if (!items.length) {
    await toast(userId, chatId,
      `${terminalHeader('RELAY HISTORY')}\nNo relay transfers yet.`,
      keyboards.relayMenuKeyboard(false));
    return;
  }

  const lines = items.map((op: any) =>
    `${op.state === 'COMPLETED' ? '🟢' : op.state === 'FAILED' || op.state === 'EXPIRED' ? '🔴' : '🟡'} ` +
    `<code>${Precision.fromBaseUnits(BigInt(op.requestedAmountNano), 9)} TON</code> → ` +
    `<code>${op.destinationAddress.slice(0, 6)}…${op.destinationAddress.slice(-4)}</code>\n` +
    `   ${op.state} · ${op.createdAt.toLocaleDateString()}` +
    (op.outgoingTxHash ? `\n   🔗 <code>${op.outgoingTxHash.slice(0, 16)}…</code>` : '')
  );

  await toast(userId, chatId,
    `${terminalHeader('RELAY HISTORY')}\n${lines.join('\n\n')}`,
    keyboards.backKeyboard('transfer_relay'));
}

/* ── ♻️ Reclaim (error/abandoned funding recovery) ── */

export async function showRelayReclaim(userId: number, chatId: number, user: any): Promise<void> {
  if (!config.features.transferRelay) { await showMainMenu(userId, chatId); return; }

  // Instant feedback — auto-edits to the result so the tap never feels dead
  await render(userId, chatId,
    `♻️ <b>CHECKING RECLAIMABLE FUNDS…</b>\n\nThis message updates automatically.`,
    { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'back_main' }]] }, { withImage: true });

  try {
    const r = await relayService.getReclaimable(userId);

    if (!r) {
      await render(userId, chatId,
        `${terminalHeader('RECLAIM')}\nNo reclaimable funds right now — this appears when a relay holds funds outside an active transfer (error, expiry, or leftover).`,
        keyboards.backKeyboard('transfer_relay'), { withImage: true });
      return;
    }

    await toast(userId, chatId,
      [
        stepHeader('RECLAIM TON', formatAddressShort(r.address)),
        '',
        `💎 on relay  <code>${Precision.fromBaseUnits(r.balanceNano, 9)} TON</code>`,
        `├ platform fee kept  <code>${Precision.fromBaseUnits(r.feeNano, 9)} TON</code>`,
        `└ network reserve    <code>${Precision.fromBaseUnits(config.relay.forwardFeeEstimateNano, 9)} TON</code>`,
        '',
        `♻️ <b>you receive  <code>${Precision.fromBaseUnits(r.reclaimNano, 9)} TON</code></b>`,
        '',
        `Reclaimed from the actual balance — the platform fee stays per policy, the reserve stays on the address.`,
      ].join('\n'),
      { inline_keyboard: [
        [{ text: `♻️ Reclaim ${Precision.fromBaseUnits(r.reclaimNano, 9)} TON`, callback_data: `relay_reclaimgo_${r.relayId}` }],
        [{ text: '❌ Cancel', callback_data: 'transfer_relay' }],
      ] });
  } catch (err: any) {
    await toast(userId, chatId,
      `❌ ${String(err.message).slice(0, 300)}`,
      keyboards.backKeyboard('transfer_relay'));
  }
}

export async function executeRelayReclaim(userId: number, chatId: number, user: any, relayId: string): Promise<void> {
  // Immediate feedback — auto-edits when done
  await render(userId, chatId,
    `♻️ <b>RECLAIM PROCESSING…</b>\n\n⛓ Returning funds from the relay — usually under 30 seconds.\nThis message updates automatically.`,
    { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'back_main' }]] }, { withImage: true });

  try {
    const result = await relayService.reclaimFunds(userId, relayId);

    const link = result.txHash && !result.txHash.includes('_')
      ? `https://tonscan.org/tx/${result.txHash}`
      : '';

    await render(userId, chatId,
      [
        terminalHeader('RECLAIM COMPLETE ✅'),
        `♻️ Returned to your wallet: <code>${Precision.fromBaseUnits(BigInt(result.reclaimNano), 9)} TON</code>`,
        `🧾 Platform fee → admin wallet: <code>${Precision.fromBaseUnits(BigInt(result.feeNano), 9)} TON</code>`,
        link ? `🔗 <a href="${link}">View on Tonscan</a>` : `🔗 Tx: <code>${result.txHash.slice(0, 20)}…</code>`,
      ].filter(Boolean).join('\n'),
      keyboards.backKeyboard('transfer_relay'));
  } catch (err: any) {
    console.error('[Relay] reclaim failed:', err);
    await render(userId, chatId,
      `❌ <b>Reclaim failed</b>\n\n${String(err.message).slice(0, 300)}`,
      keyboards.backKeyboard('transfer_relay'));
  }
}

/* ═══════════════════════════════════════════════════════════
   PHASE 5 — ADMIN: TRANSFER RELAY DASHBOARD (interactive)
   ═══════════════════════════════════════════════════════════ */

const RELAY_ADMIN_PAGE_SIZE = 5;

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
      `Signing material is never displayed here.`,
    ].join('\n'), {
      inline_keyboard: [
        [{ text: '📋 Addresses & Balances', callback_data: 'admin_relay_addrs' }],
        [{ text: '⟳ Refresh', callback_data: 'admin_relay' }],
        [{ text: '‹ Admin Console', callback_data: 'admin_panel' }],
      ],
    }, { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

/** Paginated admin list: every relay address with live on-chain balance. */
export async function showAdminRelayAddresses(userId: number, chatId: number, page: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const { RelayAddress } = await import('../../models/RelayAddress');

    const pageSize = RELAY_ADMIN_PAGE_SIZE;
    const [items, total] = await Promise.all([
      RelayAddress.find().sort({ createdAt: 1 }).skip((page - 1) * pageSize).limit(pageSize),
      RelayAddress.countDocuments(),
    ]);

    // Live balances (sequential; 5 per page keeps it snappy)
    const enriched: Array<{ id: string; label: string; address: string; status: string; balanceTon: string }> = [];
    for (const a of items) {
      const balNano = await relayService.getAddressBalance(a.address).catch(() => 0n);
      enriched.push({
        id: a._id.toString(),
        label: a.label,
        address: a.address,
        status: a.status,
        balanceTon: Precision.fromBaseUnits(balNano, TON_DECIMALS),
      });
    }

    const rows: TelegramBot.InlineKeyboardButton[][] = enriched.map((e) => [
      {
        text: `${e.status === 'active' ? '🟢' : e.status === 'recovery_required' ? '🛠' : '⚪'} ${e.label} · ${e.balanceTon} TON`,
        callback_data: `radm_addr_${e.id}`,
      },
    ]);

    const nav: TelegramBot.InlineKeyboardButton[] = [];
    if (page > 1) nav.push({ text: '‹ Prev', callback_data: `admin_relay_addrs_page_${page - 1}` });
    if (page * pageSize < total) nav.push({ text: 'Next ›', callback_data: `admin_relay_addrs_page_${page + 1}` });
    if (nav.length) rows.push(nav);

    rows.push([{ text: '⟳ Refresh', callback_data: `admin_relay_addrs_page_${page}` }]);
    rows.push([{ text: '‹ Dashboard', callback_data: 'admin_relay' }]);

    const lines = enriched.map((e) =>
      `<code>${e.address.slice(0, 8)}…${e.address.slice(-6)}</code>  <b>${e.balanceTon} TON</b>  ${e.status}`
    );

    await render(userId, chatId, [
      stepHeader('RELAY ADDRESSES', `page ${page} · ${total} total`),
      '',
      ...lines,
    ].join('\n'), { inline_keyboard: rows }, { withImage: true });
  } catch {
    await showAdminRelay(userId, chatId);
  }
}

/** Per-address detail: balance, status, pending ops, recovery sweep. */
export async function showAdminRelayAddressDetail(userId: number, chatId: number, relayId: string): Promise<void> {
  try {
    await requireAdmin(userId);
    const { RelayAddress } = await import('../../models/RelayAddress');
    const { TransferOperation } = await import('../../models/TransferOperation');

    const relay = await RelayAddress.findById(relayId);
    if (!relay) {
      await toast(userId, chatId, '❌ Relay address not found.', { inline_keyboard: [[{ text: '‹ Addresses', callback_data: 'admin_relay_addrs' }]] });
      return;
    }

        const [balanceNano, inFlight, unresolved] = await Promise.all([
      relayService.getAddressBalance(relay.address).catch(() => 0n),
      TransferOperation.countDocuments({
        relayAddressId: relay._id,
        state: { $in: ['CREATED', 'VALIDATED', 'AWAITING_CONFIRMATION', 'FUNDING', 'FUNDED', 'SENDING'] },
      }),
      TransferOperation.countDocuments({
        relayAddressId: relay._id,
        state: { $in: ['RECOVERY_REQUIRED'] },
      }),
    ]);

    const balanceTon = Precision.fromBaseUnits(balanceNano, 9);
    const sweepable = balanceNano - config.relay.forwardFeeEstimateNano;
    const canSweep = sweepable > 0n && inFlight === 0;

    const caption = [
      stepHeader('RELAY ADDRESS', relay.label),
      '',
      `<code>${relay.address}</code>`,
      `${relay.walletVersion.toUpperCase()} · ${relay.status}`,
      '',
      `▸ <b>BALANCE</b>`,
      `💎 on address  <code>${balanceTon} TON</code>`,
      `├ reserve kept  <code>${Precision.fromBaseUnits(config.relay.forwardFeeEstimateNano, 9)} TON</code>`,
      `└ sweepable     <code>${sweepable > 0n ? Precision.fromBaseUnits(sweepable, 9) : '0'} TON</code>`,
      '',
      `⏳ in-flight ops  <b>${inFlight}</b>`,
      `🛠 recovery-required ops  <b>${unresolved}</b>`,
      relay.nextEligibleAt ? `⏸ cooldown until  ${relay.nextEligibleAt.toLocaleDateString()}` : '',
    ].filter(Boolean).join('\n');

    const rows: TelegramBot.InlineKeyboardButton[][] = [];
    if (canSweep) {
      rows.push([{ text: `🧹 Sweep ${Precision.fromBaseUnits(sweepable, 9)} TON to Admin`, callback_data: `radm_sweep_${relayId}` }]);
    } else if (inFlight > 0) {
      rows.push([{ text: '⏳ In-flight operations — sweep locked', callback_data: `radm_addr_${relayId}` }]);
    }
    rows.push([{ text: '⟳ Refresh', callback_data: `radm_addr_${relayId}` }]);
    rows.push([{ text: '‹ Addresses', callback_data: 'admin_relay_addrs' }]);

    await render(userId, chatId, caption, { inline_keyboard: rows }, { withImage: true });
  } catch {
    await showAdminRelay(userId, chatId);
  }
}

/** Sweep confirmation screen (explicit second step — no accidental sweeps). */
export async function confirmRelayAddressSweep(userId: number, chatId: number, relayId: string): Promise<void> {
  try {
    await requireSuperAdmin(userId);   // sweeping moves funds — super admin only
    const { RelayAddress } = await import('../../models/RelayAddress');

    const relay = await RelayAddress.findById(relayId);
    if (!relay) {
      await toast(userId, chatId, '❌ Relay address not found.', { inline_keyboard: [[{ text: '‹ Addresses', callback_data: 'admin_relay_addrs' }]] });
      return;
    }

    const balanceNano = await relayService.getAddressBalance(relay.address).catch(() => 0n);
    const sweepable = balanceNano - config.relay.forwardFeeEstimateNano;
    if (sweepable <= 0n) {
      await toast(userId, chatId, 'Nothing to sweep — balance below network-fee threshold.', { inline_keyboard: [[{ text: '‹ Back', callback_data: `radm_addr_${relayId}` }]] });
      return;
    }

    await render(userId, chatId, [
      stepHeader('CONFIRM RECOVERY SWEEP', relay.label),
      '',
      `├ from  <code>${formatAddressShort(relay.address)}</code>`,
      `├ amount  <code>${Precision.fromBaseUnits(sweepable, 9)} TON</code>`,
      `└ to admin fee wallet  <code>${formatAddressShort(config.adminFeeWalletAddress)}</code>`,
      '',
      `The network reserve (${Precision.fromBaseUnits(config.relay.forwardFeeEstimateNano, 9)} TON) stays on the address.`,
    ].join('\n'), {
      inline_keyboard: [
        [{ text: '✅ Confirm Sweep', callback_data: `radm_sweepyes_${relayId}` }],
        [{ text: '❌ Cancel', callback_data: `radm_addr_${relayId}` }],
      ],
    }, { withImage: true });
  } catch {
    await showAdminRelay(userId, chatId);
  }
}

/** Execute the sweep. */
export async function executeRelayAddressSweep(userId: number, chatId: number, relayId: string): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    const result = await relayService.sweepAddressToAdmin(relayId, userId);

    await render(userId, chatId, [
      `✅ <b>SWEEP COMPLETED</b>`,
      '',
      `├ address  <code>${formatAddressShort(result.address)}</code>`,
      `├ swept  <code>${Precision.fromBaseUnits(BigInt(result.amountNano), 9)} TON</code>`,
      `└ tx  <code>${result.txHash}</code>`,
      '',
      `Funds recovered to admin fee wallet.`,
    ].join('\n'), {
      inline_keyboard: [
        [{ text: '‹ Address Detail', callback_data: `radm_addr_${relayId}` }],
        [{ text: '‹ Addresses', callback_data: 'admin_relay_addrs' }],
      ],
    }, { withImage: true });
  } catch (err: any) {
    console.error('[Relay] admin sweep failed:', err);
    await toast(userId, chatId,
      `❌ <b>Sweep failed</b>\n\n${String(err.message).slice(0, 300)}`,
      { inline_keyboard: [[{ text: '‹ Back', callback_data: `radm_addr_${relayId}` }]] });
  }
}
