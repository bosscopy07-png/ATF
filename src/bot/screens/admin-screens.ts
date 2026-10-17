/**
 * Admin screens — panel, admin management, user management, emergency
 * sweep, transaction views, configs, broadcast, platform stats.
 * Imports context + main-menu (static). No cycles.
 */
import {
  TelegramBot, User, Transaction, AdminAction, Precision, config, TON_DECIMALS, ATF_DECIMALS,
  walletService, getBot,
  render, toast, clearState,
  terminalHeader, stepHeader, txAmount,
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
   🔍 USER SEARCH + ✉️ ADMIN MESSAGING
   ─────────────────────────────────────────────────────────────────────────── */

export async function startUserSearch(userId: number, chatId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    user.state = 'admin_user_search';
    user.stateData = {};
    await user.save();

    await render(userId, chatId,
      `${stepHeader('SEARCH USER')}\n\nEnter a <b>Telegram ID</b> or a <b>TON wallet address</b>:`,
      keyboards.cancelKeyboard('admin_users'), { withImage: true });
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

export async function handleUserSearch(userId: number, chatId: number, text: string): Promise<void> {
  try {
    await requireAdmin(userId);
  } catch {
    await showMainMenu(userId, chatId);
    return;
  }

  const query = text.trim();

  try {
    let target: any = null;

    if (/^\d{4,15}$/.test(query)) {
      // Telegram ID
      target = await User.findOne({ telegramId: parseInt(query, 10) });
    } else {
      // Wallet address — canonicalize then look up owner
      try {
        const { Address } = await import('@ton/core');
        const canonical = Address.parse(query).toString();
        const { Wallet } = await import('../../models/Wallet');
        const walletDoc = await Wallet.findOne({ address: canonical });
        if (walletDoc) {
          target = await User.findOne({ walletIds: walletDoc._id });
        }
      } catch {
        await toast(userId, chatId, '❌ Invalid address or ID.', keyboards.cancelKeyboard('admin_users'));
        return;
      }
    }

    if (!target) {
      await toast(userId, chatId, '❌ No user found for that query.', keyboards.backKeyboard('admin_users'));
      return;
    }

    await clearState(userId);
    await showUserDetail(userId, chatId, target.telegramId);
  } catch {
    await showMainMenu(userId, chatId);
  }
}

export async function startAdminMessage(userId: number, chatId: number, targetId: number): Promise<void> {
  try {
    await requireAdmin(userId);
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    user.state = 'admin_msg_input';
    user.stateData = { targetId };
    await user.save();

    await render(userId, chatId,
      `${stepHeader('MESSAGE USER')}\n\nTo: <code>${targetId}</code>\n\nType the message to send:`,
      keyboards.cancelKeyboard(`admin_user_${targetId}`), { withImage: true });
  } catch {
    await showAdminPanel(userId, chatId);
  }
}

export async function handleAdminMessage(userId: number, chatId: number, user: any, text: string): Promise<void> {
  try {
    await requireAdmin(userId);
  } catch {
    await showMainMenu(userId, chatId);
    return;
  }

  const targetId = user.stateData?.targetId;
  if (!targetId) { await showAdminPanel(userId, chatId); return; }

  try {
    await getBot().sendMessage(
      targetId,
      `${stepHeader('MESSAGE FROM ADMIN')}\n\n${text}`,
      { parse_mode: 'HTML' }
    );

    await AdminAction.create({
      adminId: userId,
      action: 'ADMIN_MESSAGE_SENT',
      target: targetId.toString(),
      result: 'success',
    });

    await clearState(userId);
    await toast(userId, chatId,
      `✅ Message delivered to <code>${targetId}</code>.`,
      keyboards.backKeyboard(`admin_user_${targetId}`));
  } catch (err: any) {
    await toast(userId, chatId,
      `❌ Delivery failed: <i>${String(err.message).slice(0, 200)}</i>`,
      keyboards.backKeyboard(`admin_user_${targetId}`));
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
      const amt = txAmount(tx.amount, tx.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS);
      return `${icon} <code>${tx.type}</code>  <code>${amt} ${tx.asset}</code> · ${tx.status}`;
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

  const user = await User.findOne({ te
