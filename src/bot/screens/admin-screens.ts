/**
 * Admin screens — panel, admin management, user management, emergency
 * sweep, transaction views, configs, broadcast, platform stats.
 * Imports context + main-menu (static). No cycles.
 */
import {
  TelegramBot, User, Transaction, AdminAction, Precision, config, TON_DECIMALS, ATF_DECIMALS,
  walletService, getBot,
  render, toast, clearState,
  terminalHeader, stepHeader,
  formatAddressShort,
  isValidTonAddress, isValidAmount, isValidTelegramId,
  requireAdmin, requireSuperAdmin,
  premiumEmojiOptions,
} from '../context';
import { showMainMenu } from './main-menu';
import * as keyboards from '../keyboards';

/* ───────────────────────────────────────────────────────────────────────────
   🛡️ ADMIN PANEL
   ─────────────────────────────────────────────────────────────────────────── */

export async function showAdminPanel(userId: number, chatId: number): Promise<void> {
  try {
    const user = await requireAdmin(userId);
    user.lastAction = 'admin_panel';
    await user.save();

    await render(userId, chatId, [
      terminalHeader('ADMIN', `signed in as ${user.firstName || 'admin'}`),
      '',
      `Select a section below.`,
    ].join('\n'), keyboards.adminPanelKeyboard(user.isSuperAdmin), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function showAdminManagement(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    await render(userId, chatId, stepHeader('ADMIN MANAGEMENT'), keyboards.adminManagementKeyboard(), { withImage: true });
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

export async function startGiveAdmin(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    user.state = 'admin_give_input';
    await user.save();

    await render(userId, chatId, `${stepHeader('GIVE ADMIN')}\n\nEnter the Telegram ID:`, keyboards.cancelKeyboard('admin_management'), { withImage: true });
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

export async function handleGiveAdmin(userId: number, chatId: number, text: string): Promise<void> {
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
    await toast(userId, chatId, '❌ User not found — they must start the bot first.', keyboards.cancelKeyboard('admin_management'));
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
  await toast(userId, chatId, `✅ <b>Admin granted</b>\n\n<code>${targetId}</code> is now an administrator.`, keyboards.backKeyboard('admin_management'));
}

export async function startRemoveAdmin(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    user.state = 'admin_remove_input';
    await user.save();

    await render(userId, chatId, `${stepHeader('REMOVE ADMIN')}\n\nEnter the Telegram ID:`, keyboards.cancelKeyboard('admin_management'), { withImage: true });
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

export async function handleRemoveAdmin(userId: number, chatId: number, text: string): Promise<void> {
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
    await toast(userId, chatId, '⛔ Cannot remove the super admin.', keyboards.cancelKeyboard('admin_management'));
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
  await toast(userId, chatId, `✅ <b>Admin removed</b>\n\n<code>${targetId}</code> is no longer an administrator.`, keyboards.backKeyboard('admin_management'));
}

export async function showAdminList(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    const admins = await User.find({ isAdmin: true }).sort({ createdAt: -1 });
    const lines = admins.map((a: any) => `• <code>${a.telegramId}</code>${a.isSuperAdmin ? ' · <b>super</b>' : ''}`);

    await render(userId, chatId, [
      stepHeader('ADMIN LIST'),
      '',
      ...(lines.length ? lines : ['<i>No admins found.</i>']),
    ].join('\n'), keyboards.backKeyboard('admin_management'), { withImage: true });
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   👤 USER MANAGEMENT
   ─────────────────────────────────────────────────────────────────────────── */

export async function showUserList(userId: number, chatId: number, page: number): Promise<void> {
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
    const total = await User.countDocuments();

    await render(userId, chatId, [
      stepHeader('USERS', `${total} total · page ${page}`),
    ].join('\n'), keyboards.userListKeyboard(display, page, hasMore), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function showUserDetail(userId: number, chatId: number, targetId: number): Promise<void> {
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
      stepHeader('USER DETAIL'),
      '',
      `🆔 <code>${target.telegramId}</code>`,
      `👤 ${target.firstName || 'N/A'} ${target.lastName || ''}${target.username ? ` · @${target.username}` : ''}`,
      `📊 ${target.isFrozen ? '❄️ frozen' : '✅ active'} · joined ${target.createdAt.toLocaleDateString()}`,
      '',
      `▸ <b>BALANCES</b>`,
      `💎 TON  <code>${Precision.formatDisplay(tonBalance)}</code>`,
      `🔷 ATF  <code>${Precision.formatDisplay(atfBalance)}</code>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.userActionKeyboard(targetId, target.isFrozen), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function showAdminUserBalance(userId: number, chatId: number, targetId: number): Promise<void> {
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
      stepHeader('ON-CHAIN BALANCE', `user ${targetId}`),
      '',
      `💎 TON  <code>${Precision.formatDisplay(ton)}</code>`,
      `🔷 ATF  <code>${Precision.formatDisplay(atf)}</code>`,
      '',
      `👛 <code>${formatAddressShort(wallet.address)}</code>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard(`admin_user_${targetId}`), { withImage: true });
  } catch (error: any) {
    await toast(userId, chatId, `❌ ${error.message}`, keyboards.backKeyboard('admin_users'));
  }
}

export async function showAdminUserTransactions(userId: number, chatId: number, targetId: number): Promise<void> {
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
      return `${icon} <code>${tx.type}</code>  <code>${Precision.formatDisplay(amt)} ${tx.asset}</code> · ${tx.status}`;
    });

    const caption = [
      stepHeader('USER TRANSACTIONS', `user ${targetId} · last ${txs.length}`),
      '',
      ...(lines.length ? lines : ['<i>No transactions.</i>']),
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard(`admin_user_${targetId}`), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function toggleFreeze(userId: number, chatId: number, targetId: number, action: 'freeze' | 'unfreeze'): Promise<void> {
  try {
    await requireAdmin(userId);
    const target = await User.findOne({ telegramId: targetId });
    if (!target) {
      await toast(userId, chatId, '❌ User not found.', keyboards.backKeyboard('admin_users'));
      return;
    }

    if (target.isSuperAdmin) {
      await toast(userId, chatId, '⛔ Cannot modify the super admin.', keyboards.backKeyboard('admin_users'));
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

export async function showAuditLogs(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const logs = await AdminAction.find().sort({ createdAt: -1 }).limit(15);
    const lines = logs.map((l: any) => {
      const date = new Date(l.createdAt).toLocaleString();
      return `<code>${date}</code> <b>${l.action}</b> by <code>${l.adminId}</code>`;
    });

    await render(userId, chatId, [
      stepHeader('AUDIT LOGS', 'last 15 actions'),
      '',
      ...(lines.length ? lines : ['<i>No logs.</i>']),
    ].join('\n'), keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function showSystemSettings(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const caption = [
      stepHeader('SYSTEM SETTINGS'),
      '',
      `▸ <b>CORE</b>`,
      `├ network  <code>${config.tonNetwork || 'mainnet'}</code>`,
      `├ min swap  <code>${config.minSwapTon} TON</code>`,
      `└ max slippage  <code>${config.maxSlippagePercent}%</code>`,
      '',
      `▸ <b>FEES</b>`,
      `├ platform  <code>${config.platformSwapFeePercent}%</code>`,
      `└ fee wallet  <code>${formatAddressShort(config.adminFeeWalletAddress)}</code>`,
      '',
      `<i>Configured via environment variables.</i>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   🚨 EMERGENCY ASSET SWEEP BY WALLET ADDRESS (Super Admin Only)
   ─────────────────────────────────────────────────────────────────────────── */

export async function startSweepByAddress(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    user.state = 'sweep_address_input';
    user.stateData = {};
    await user.save();

    await render(userId, chatId, [
      stepHeader('EMERGENCY SWEEP', 'super admin only'),
      '',
      `Enter the target wallet address:`,
      '',
      `<i>EQD… / UQD…</i>`,
      '',
      `Assets move to the admin fee wallet.`,
    ].join('\n'), keyboards.cancelKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

export async function handleSweepAddressInput(userId: number, chatId: number, text: string): Promise<void> {
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

  const WalletModel = (await import('../../models/Wallet')).Wallet;
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
    stepHeader('EMERGENCY SWEEP', formatAddressShort(address)),
    '',
    `🆔 owner  <code>${targetId}</code>`,
    '',
    `▸ <b>BALANCES ON WALLET</b>`,
    `💎 TON  <code>${Precision.formatDisplay(tonBal)}</code>`,
    `🔷 ATF  <code>${Precision.formatDisplay(atfBal)}</code>`,
    '',
    `Select the asset to sweep:`,
  ].join('\n'), {
    inline_keyboard: [
      [{ text: '💎 Sweep TON', callback_data: 'sweep_asset_ton' }],
      [{ text: '🔷 Sweep ATF', callback_data: 'sweep_asset_atf' }],
      [{ text: '❌ Cancel', callback_data: 'admin_panel' }],
    ],
  }, { withImage: true });
}

export async function handleSweepAssetSelect(userId: number, chatId: number, asset: 'TON' | 'ATF'): Promise<void> {
  try {
    await requireSuperAdmin(userId);
  } catch {
    await showMainMenu(userId, chatId);
    return;
  }

  const user = await User.findOne({ telegramId: userId });
  if (!user || user.state !== 'sweep_asset_select') return;

  const { tonBal, atfBal } = user.stateData;
  const balance = asset === 'TON' ? tonBal : atfBal;

  user.state = 'sweep_amount_input';
  user.stateData = { ...user.stateData, sweepAsset: asset };
  await user.save();

  await render(userId, chatId, [
    stepHeader(`SWEEP ${asset}`, formatAddressShort(user.stateData.walletAddress)),
    '',
    `💳 available  <code>${Precision.formatDisplay(balance)} ${asset}</code>`,
    '',
    `Enter the amount, or type <b>ALL</b>:`,
  ].join('\n'), keyboards.cancelKeyboard('admin_panel'), { withImage: true });
}

export async function handleSweepAmountInput(userId: number, chatId: number, text: string): Promise<void> {
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
    await toast(userId, chatId, '❌ Invalid amount — enter a number or ALL.', keyboards.cancelKeyboard('admin_panel'));
    return;
  }

  const amountBase = Precision.toBaseUnits(amountStr, sweepAsset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
  const maxBase = Precision.toBaseUnits(maxBal, sweepAsset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);

  if (amountBase <= BigInt(0) || amountBase > maxBase) {
    await toast(userId, chatId, `❌ Amount exceeds balance or is invalid. Max: ${Precision.formatDisplay(maxBal)} ${sweepAsset}`, keyboards.cancelKeyboard('admin_panel'));
    return;
  }

  await render(userId, chatId, `🚨 <b>Sweeping ${sweepAsset}…</b>\n\n<i>moving funds from ${formatAddressShort(walletAddress)} to admin wallet</i>`, { inline_keyboard: [] }, { withImage: true });

  try {
    let txHash: string;

    if (sweepAsset === 'TON') {
      const feeBuffer = BigInt(Math.round(0.02 * 1e9));
      const sweepable = amountBase > feeBuffer ? amountBase - feeBuffer : BigInt(0);

      if (sweepable <= BigInt(0)) {
        await toast(userId, chatId, `❌ Balance too low to sweep after leaving the gas buffer (0.02 TON).`, keyboards.cancelKeyboard('admin_panel'));
        return;
      }

      txHash = await walletService.sendTon(targetId, config.adminFeeWalletAddress, sweepable);

      const sweptDisplay = Precision.fromBaseUnits(sweepable, TON_DECIMALS);
      console.log(`[Sweep] TON: swept ${sweptDisplay} TON from ${walletAddress}, left ~0.02 TON for fees`);

    } else {
      const tonBalBase = Precision.toBaseUnits(tonBal, TON_DECIMALS);
      const minGas = BigInt(Math.round(0.05 * 1e9));

      if (tonBalBase < minGas) {
        await toast(userId, chatId, [
          `❌ <b>Cannot sweep ATF</b>`,
          '',
          `This wallet has <b>${Precision.formatDisplay(tonBal)} TON</b> left.`,
          `Jetton transfers need ~0.05 TON for gas.`,
          '',
          `Options:`,
          `├ sweep the remaining TON first`,
          `└ or deposit ~0.05 TON, then sweep ATF`,
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
      '',
      `<code>${Precision.formatDisplay(amountStr)} ${sweepAsset}</code> recovered`,
      `├ from  <code>${formatAddressShort(walletAddress)}</code>`,
      `└ owner <code>${targetId}</code>`,
      '',
      `Tx: <code>${txHash}</code>`,
      sweepAsset === 'TON' ? `<i>~0.02 TON left in wallet for fees.</i>` : '',
    ].filter(Boolean).join('\n'), keyboards.backKeyboard('admin_panel'), { withImage: true });

  } catch (error: any) {
    console.error(`[Sweep] Blockchain failure for ${walletAddress}:`, error);
    await toast(userId, chatId, [
      `❌ <b>Sweep failed on-chain</b>`,
      '',
      `${error.message}`,
      '',
      `Common causes:`,
      `├ TON sweep — not enough left for tx fees`,
      `└ ATF sweep — wallet needs ~0.05 TON for Jetton gas`,
      '',
      `Try sweeping TON first, then ATF.`,
    ].join('\n'), keyboards.cancelKeyboard('admin_panel'));
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   📊 ADMIN TRANSACTION VIEWS
   ─────────────────────────────────────────────────────────────────────────── */

const txLine = (tx: any, prefix: string): string => {
  const icon = tx.type === 'deposit' ? '📥' : tx.type === 'withdrawal' ? '📤' : '🔄';
  const amt = Precision.fromBaseUnits(BigInt(tx.amount), tx.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
  const statusIcon = tx.status === 'completed' ? '✅' : tx.status === 'pending' ? '⏳' : '❌';
  return `${icon} ${prefix ? `${prefix} ` : ''}<code>${Precision.formatDisplay(amt)} ${tx.asset}</code> · ${statusIcon} ${tx.status}`;
};

export async function showAdminTransactions(userId: number, chatId: number, page: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const limit = 5;
    const skip = (page - 1) * limit;

    const txs = await Transaction.find().sort({ createdAt: -1 }).skip(skip).limit(limit + 1);
    const hasMore = txs.length > limit;
    const display = hasMore ? txs.slice(0, limit) : txs;

    const lines = display.map((tx: any) => txLine(tx, `<code>${tx.userId}</code>`));
    const caption = [stepHeader('ALL TRANSACTIONS', `page ${page}`), '', ...lines].join('\n');
    await render(userId, chatId, caption, keyboards.adminPaginationKeyboard('admin_transactions', page, hasMore), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function showAdminDeposits(userId: number, chatId: number, page: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const limit = 5;
    const skip = (page - 1) * limit;

    const txs = await Transaction.find({ type: 'deposit' }).sort({ createdAt: -1 }).skip(skip).limit(limit + 1);
    const hasMore = txs.length > limit;
    const display = hasMore ? txs.slice(0, limit) : txs;

    const lines = display.map((tx: any) => txLine(tx, `<code>${tx.userId}</code>`));
    const caption = [stepHeader('DEPOSITS', `page ${page}`), '', ...lines].join('\n');
    await render(userId, chatId, caption, keyboards.adminPaginationKeyboard('admin_deposits', page, hasMore), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function showAdminWithdrawals(userId: number, chatId: number, page: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const limit = 5;
    const skip = (page - 1) * limit;

    const txs = await Transaction.find({ type: 'withdrawal' }).sort({ createdAt: -1 }).skip(skip).limit(limit + 1);
    const hasMore = txs.length > limit;
    const display = hasMore ? txs.slice(0, limit) : txs;

    const lines = display.map((tx: any) => txLine(tx, `<code>${tx.userId}</code>`));
    const caption = [stepHeader('WITHDRAWALS', `page ${page}`), '', ...lines].join('\n');
    await render(userId, chatId, caption, keyboards.adminPaginationKeyboard('admin_withdrawals', page, hasMore), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function showAdminSwaps(userId: number, chatId: number, page: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const limit = 5;
    const skip = (page - 1) * limit;

    const txs = await Transaction.find({ type: 'swap' }).sort({ createdAt: -1 }).skip(skip).limit(limit + 1);
    const hasMore = txs.length > limit;
    const display = hasMore ? txs.slice(0, limit) : txs;

    const lines = display.map((tx: any) => txLine(tx, `<code>${tx.userId}</code>`));
    const caption = [stepHeader('SWAPS', `page ${page}`), '', ...lines].join('\n');
    await render(userId, chatId, caption, keyboards.adminPaginationKeyboard('admin_swaps', page, hasMore), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   ⚙️ CONFIG VIEWS
   ─────────────────────────────────────────────────────────────────────────── */

export async function showAdminTokenConfig(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const caption = [
      stepHeader('TOKEN CONFIG'),
      '',
      `🔷 ATF jetton  <code>${formatAddressShort(config.atfJettonAddress)}</code>`,
      `└ decimals  <code>${ATF_DECIMALS}</code>`,
      '',
      `<i>Edit via environment variables.</i>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function showAdminDexConfig(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const caption = [
      stepHeader('DEX CONFIG'),
      '',
      `🔀 STON.fi API  <code>${config.stonfiApiUrl}</code>`,
      `└ slippage  <code>${config.maxSlippagePercent}%</code>`,
      '',
      `<i>Edit via environment variables.</i>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function showAdminFeeConfig(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const caption = [
      stepHeader('FEE CONFIG'),
      '',
      `├ swap  <code>${config.platformSwapFeePercent}%</code>`,
      `├ TON→token  <code>${config.feePolicy.tonToTokenPercent}%</code> · base <code>${config.feePolicy.platformFeeBase}</code>`,
      `├ token→TON  <code>${config.feePolicy.tokenToTonInputPercent}%</code> in + <code>${config.feePolicy.tokenToTonOutputPercent}%</code> TON out`,
      `├ token→token  <code>${config.feePolicy.tokenToTokenPercent}%</code>`,
      `├ relay transfer  <code>${config.feePolicy.relayTransferPercent}%</code>`,
      `└ fee wallet  <code>${formatAddressShort(config.adminFeeWalletAddress)}</code>`,
      '',
      `<i>Edit via environment variables.</i>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function showAdminPriceProviders(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const caption = [
      stepHeader('PRICE PROVIDERS'),
      '',
      `💎 TON/USD  <code>${config.tonPriceApiUrl || 'auto-fallback'}</code>`,
      `🔷 ATF/USD  <code>${config.atfPriceApiUrl || 'auto-fallback'}</code>`,
      `🇳🇬 USD/NGN  <code>${config.usdNgnRateApiUrl || 'auto-fallback'}</code>`,
      '',
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

export async function startBroadcast(userId: number, chatId: number): Promise<void> {
  try {
    await requireSuperAdmin(userId);
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    user.state = 'broadcast_input';
    await user.save();

    await render(userId, chatId, `${stepHeader('BROADCAST')}\n\nType the message to send to <b>all</b> users:`, keyboards.cancelKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

export async function handleBroadcast(userId: number, chatId: number, text: string): Promise<void> {
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
      await getBot().sendMessage(u.telegramId, broadcastText, {
        parse_mode: 'HTML',
        ...premiumEmojiOptions(broadcastText),
      });
      sent++;
    } catch {
      failed++;
    }
    if (sent % 20 === 0) await new Promise(r => setTimeout(r, 1000));
  }

  await clearState(userId);
  await toast(userId, chatId, `✅ <b>Broadcast complete</b>\n\n├ sent  <b>${sent}</b>\n└ failed  <b>${failed}</b>`, keyboards.backKeyboard('admin_panel'));

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

export async function handleStats(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const totalUsers = await User.countDocuments();
    const totalTxs = await Transaction.countDocuments();
    const totalSwaps = await Transaction.countDocuments({ type: 'swap' });
    const totalDeposits = await Transaction.countDocuments({ type: 'deposit' });
    const totalWithdrawals = await Transaction.countDocuments({ type: 'withdrawal' });
    const totalRelayOps = await (await import('../../models/TransferOperation')).TransferOperation.countDocuments();

    const caption = [
      stepHeader('PLATFORM STATS'),
      '',
      `👥 users  <b>${totalUsers}</b>`,
      `📜 transactions  <b>${totalTxs}</b>`,
      '',
      `├ 🔄 swaps  <b>${totalSwaps}</b>`,
      `├ 📥 deposits  <b>${totalDeposits}</b>`,
      `├ 📤 withdrawals  <b>${totalWithdrawals}</b>`,
      `└ 🚀 relay transfers  <b>${totalRelayOps}</b>`,
    ].join('\n');

    await render(userId, chatId, caption, keyboards.backKeyboard('admin_panel'), { withImage: true });
  } catch {
    await showMainMenu(userId, chatId);
  }
    }
          
