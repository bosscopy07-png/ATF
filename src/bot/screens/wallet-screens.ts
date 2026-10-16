/**
 * Wallet screens — account dashboard, multi-wallet management,
 * wallet export (V4R2 / W5R1) and wallet import.
 * Imports context + main-menu (static). No cycles.
 */
import {
  TelegramBot, User, Wallet, AdminAction, Precision, config, TON_DECIMALS, ATF_DECIMALS,
  walletService,
  render, toast, clearState,
  terminalHeader, stepHeader,
  formatAddressShort,
  getActiveWallet, getUserWallets,
} from '../context';
import { showMainMenu } from './main-menu';
import * as keyboards from '../keyboards';

/* ───────────────────────────────────────────────────────────────────────────
   ▣ ACCOUNT DASHBOARD
   ─────────────────────────────────────────────────────────────────────────── */

export async function showAccount(userId: number, chatId: number): Promise<void> {
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
    terminalHeader('WALLET', 'balances · wallets · security'),
    '',
    `◉ 🗝 <b>ACTIVE WALLET</b>`,
    `<code>${active ? active.address : 'none'}</code>`,
    active?.walletVersion ? `<i>${active.walletVersion.toUpperCase()}</i>` : '',
    '',
    `▸ <b>BALANCES</b>`,
    `💎 TON  <code>${Precision.formatDisplay(tonBalance)}</code>`,
    `🔷 ATF  <code>${Precision.formatDisplay(atfBalance)}</code>`,
    '',
    `◉ <b>${wallets.length}</b> wallet${wallets.length !== 1 ? 's' : ''} linked`,
  ].filter(Boolean).join('\n'), keyboards.accountKeyboard(), { withImage: true });
}

/* ───────────────────────────────────────────────────────────────────────────
   ▣ MULTI-WALLET MANAGEMENT
   ─────────────────────────────────────────────────────────────────────────── */

export async function showMyWallets(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const wallets = await getUserWallets(userId);
  const activeId = user.activeWalletId?.toString() || '';

  await render(userId, chatId, [
    stepHeader('MY WALLETS', `${wallets.length} linked · tap to switch`),
  ].join('\n'), keyboards.walletListKeyboard(wallets, activeId), { withImage: true });
}

export async function switchWallet(userId: number, chatId: number, walletId: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  const wallet = await Wallet.findById(walletId);
  if (!wallet || !user.walletIds.map((id: any) => id.toString()).includes(walletId)) {
    await toast(userId, chatId, '❌ Wallet not found.', keyboards.backKeyboard('my_wallets'));
    return;
  }

  user.activeWalletId = wallet._id;
  await user.save();

  await toast(userId, chatId, [
    `✅ <b>Switched</b>`,
    '',
    `<code>${formatAddressShort(wallet.address)}</code> is now active.`,
  ].join('\n'), keyboards.backKeyboard('account'));
}

export async function createNewWallet(userId: number, chatId: number): Promise<void> {
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
    '',
    `<code>${wallet.address}</code>`,
    '',
    `<i>It is now your active wallet.</i>`,
  ].join('\n'), keyboards.backKeyboard('my_wallets'));
}

/* ───────────────────────────────────────────────────────────────────────────
   🔐 WALLET EXPORT
   ─────────────────────────────────────────────────────────────────────────── */

export async function showExportWarning(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.state = 'export_wallet';
    await user.save();
  }

  await render(userId, chatId, [
    stepHeader('EXPORT WALLET'),
    '',
    `⚠️ <b>You are about to reveal your recovery phrase.</b>`,
    '',
    `Anyone with these words controls <b>all funds</b> in this wallet.`,
    '',
    `├ only do this in a private chat`,
    `└ support will <b>never</b> ask for it`,
  ].join('\n'), keyboards.exportWarningKeyboard(), { withImage: true });
}

export async function exportWallet(userId: number, chatId: number): Promise<void> {
  try {
    const wallet = await getActiveWallet(userId);
    if (!wallet) {
      await toast(userId, chatId, '❌ No wallet found.', keyboards.backKeyboard('account'));
      return;
    }

    const { decrypt } = await import('../../utils/encryption');
    const phrase = decrypt(wallet.encryptedMnemonic, wallet.iv, wallet.tag);

    await render(userId, chatId, [
      `🔐 <b>RECOVERY PHRASE</b>`,
      '',
      `<code>${phrase}</code>`,
      '',
      `🗑️ <i>Copy it, then delete this message immediately.</i>`,
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

export async function startImportWallet(userId: number, chatId: number): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) return;

  user.state = 'import_version_select';
  user.stateData = {};
  await user.save();

  await render(userId, chatId, [
    stepHeader('IMPORT WALLET', 'adds a new wallet — nothing is replaced'),
    '',
    `Which version is your wallet?`,
    '',
    `🟦 <b>V4R2</b> — classic`,
    `🟪 <b>W5R1</b> — modern`,
    '',
    `<i>Unsure? Use auto-detect.</i>`,
  ].join('\n'), keyboards.importWalletVersionKeyboard(), { withImage: true });
}

export async function handleImportVersionSelect(
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
    stepHeader('IMPORT WALLET', 'step 2 — recovery phrase'),
    '',
    `Paste your 24-word recovery phrase below.`,
    '',
    `<i>This adds a NEW wallet — your existing wallets stay untouched.</i>`,
  ].join('\n'), keyboards.cancelKeyboard('account'), { withImage: true });
}

export async function handleImportMnemonic(userId: number, chatId: number, text: string): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || user.state !== 'import_mnemonic_input') return;

  const words = text.trim().split(/\s+/);
  if (words.length !== 24) {
    await toast(userId, chatId, `❌ That\u2019s ${words.length} words — the phrase needs exactly 24.`, keyboards.cancelKeyboard('account'));
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
            stepHeader('AUTO-DETECT', 'two wallets found on this phrase'),
            '',
            `🟦 <b>V4R2</b>  <code>${wallets.v4.address}</code>`,
            `🟪 <b>W5R1</b>  <code>${wallets.v5.address}</code>`,
            '',
            `Which one do you want to import?`,
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

export async function handleImportVersionConfirm(userId: number, chatId: number, version: WalletVersion): Promise<void> {
  const user = await User.findOne({ telegramId: userId });
  if (!user || user.state !== 'import_version_confirm') return;

  const mnemonic = getAndClearAutoDetectMnemonic(userId);
  if (!mnemonic) {
    await toast(userId, chatId, '⏳ Session expired — paste your phrase again.', keyboards.backKeyboard('account'));
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
      `ℹ️ <b>Already Imported</b>`,
      '',
      `<code>${formatAddressShort(existing.address)}</code> · <b>${versionTag}</b>`,
      '',
      `<i>Switched to it automatically.</i>`,
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
    '',
    `<code>${formatAddressShort(newWallet.address)}</code> · <b>${versionTag}</b>`,
    '',
    `<i>It is now your active wallet.</i>`,
  ].join('\n'), keyboards.backKeyboard('account'), { withImage: true });
    }
    
