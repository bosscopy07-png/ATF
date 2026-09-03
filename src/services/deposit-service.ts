import { TonClient, Address, Cell } from '@ton/ton';
import { JettonMaster } from '@ton/ton';
import TelegramBot from 'node-telegram-bot-api';
import { User } from '../models/User';
import { Wallet } from '../models/Wallet';
import { Transaction } from '../models/Transaction';
import { WalletService } from './wallet-service';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS, ATF_DECIMALS } from '../config';

const PROCESSED_TXS = new Set<string>();
const MAX_PROCESSED_CACHE = 10_000;

let botInstance: TelegramBot | null = null;

export function setDepositBot(bot: TelegramBot): void {
  botInstance = bot;
}

function parseTransferNotification(body: Cell): {
  opcode: number;
  queryId: bigint;
  amount: bigint;
  sender: Address | null;
} | null {
  try {
    const slice = body.beginParse();
    const opcode = slice.loadUint(32);
    if (opcode !== 0x7362d09c) return null;
    const queryId = BigInt(slice.loadUint(64));
    const amount = slice.loadCoins();
    const sender = slice.loadAddress();
    return { opcode, queryId, amount, sender };
  } catch {
    return null;
  }
}

function getInternalMessageValue(tx: any): bigint {
  if (!tx.inMessage) return BigInt(0);
  const info = tx.inMessage.info;
  if (info && info.type === 'internal' && info.value && typeof info.value.coins === 'bigint') {
    return info.value.coins;
  }
  return BigInt(0);
}

function getInternalMessageSource(tx: any): string | undefined {
  if (!tx.inMessage) return undefined;
  const info = tx.inMessage.info;
  if (info && info.type === 'internal' && info.src) {
    return info.src.toString();
  }
  return undefined;
}

function explorerLink(txHash: string): string {
  return `https://tonscan.org/tx/${txHash}`;
}

function trimProcessedCache(): void {
  if (PROCESSED_TXS.size > MAX_PROCESSED_CACHE) {
    const toDelete = PROCESSED_TXS.size - MAX_PROCESSED_CACHE;
    let i = 0;
    for (const key of PROCESSED_TXS) {
      if (i >= toDelete) break;
      PROCESSED_TXS.delete(key);
      i++;
    }
  }
}

export class DepositService {
  private client: TonClient;
  private walletService: WalletService;

  constructor() {
    this.client = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });
    this.walletService = new WalletService();
  }

  async monitorDeposits(): Promise<void> {
    const wallets = await Wallet.find();

    for (const walletDoc of wallets) {
      try {
        await this.checkTonDeposits(walletDoc);
        await this.checkAtfDeposits(walletDoc);
      } catch (error) {
        console.error(`Deposit check failed for ${walletDoc.address}:`, error);
      }
    }
  }

  private async checkTonDeposits(walletDoc: any): Promise<void> {
    const address = Address.parse(walletDoc.address);
    const transactions = await this.client.getTransactions(address, { limit: 20 });

    for (const tx of transactions) {
      const amount = getInternalMessageValue(tx);
      if (amount === BigInt(0)) continue;

      const txHash = tx.hash().toString('hex');
      const uniqueId = `ton_deposit_${walletDoc.address}_${txHash}`;

      if (PROCESSED_TXS.has(uniqueId)) continue;

      const existing = await Transaction.findOne({ txHash, type: 'deposit', asset: 'TON' });
      if (existing) {
        PROCESSED_TXS.add(uniqueId);
        continue;
      }

      const user = await User.findById(walletDoc.userId);
      if (!user) continue;

      // ── Calculate platform fee ──
      const feeBase = Precision.calculateFee(amount, config.platformDepositFeePercent || 0);
      const netBase = Precision.subtract(amount, feeBase);

      const displayGross = Precision.fromBaseUnits(amount, TON_DECIMALS);
      const displayNet = Precision.fromBaseUnits(netBase, TON_DECIMALS);
      const displayFee = Precision.fromBaseUnits(feeBase, TON_DECIMALS);

      // ── Credit user balance (net amount) ──
      user.tonBalance = Precision.add(
        BigInt(user.tonBalance || '0'),
        netBase
      ).toString();
      await user.save();

      const depositTx = await Transaction.create({
        userId: user._id,
        type: 'deposit',
        asset: 'TON',
        amount: amount.toString(),
        fee: feeBase.toString(),
        feeAsset: 'TON',
        feePercentage: config.platformDepositFeePercent || 0,
        feeWallet: config.adminFeeWalletAddress,
        feeStatus: feeBase > BigInt(0) ? 'pending' : 'completed',
        status: 'completed',
        txHash,
        toAddress: walletDoc.address,
        fromAddress: getInternalMessageSource(tx),
        metadata: {
          lt: tx.lt?.toString(),
          blockTime: tx.now ? new Date(tx.now * 1000).toISOString() : undefined,
          netCredited: displayNet,
          platformFee: displayFee,
        },
      });

      PROCESSED_TXS.add(uniqueId);
      trimProcessedCache();

      // ── Send fee to admin wallet ──
      if (feeBase > BigInt(0)) {
        try {
          const feeTxHash = await this.walletService.sendTon(
            user.telegramId,
            config.adminFeeWalletAddress,
            feeBase
          );
          depositTx.feeTxHash = feeTxHash;
          depositTx.feeStatus = 'completed';
          await depositTx.save();
        } catch (feeErr) {
          console.error(`[DepositService] TON fee transfer failed for ${walletDoc.address}:`, feeErr);
          depositTx.feeStatus = 'failed';
          depositTx.metadata = {
            ...depositTx.metadata,
            feeError: (feeErr as Error).message,
          };
          await depositTx.save();
        }
      }

      await this.notifyDeposit(user.telegramId, 'TON', displayNet, txHash, displayFee);
    }
  }

  private async checkAtfDeposits(walletDoc: any): Promise<void> {
    const ownerAddress = Address.parse(walletDoc.address);

    try {
      const jettonMaster = this.client.open(JettonMaster.create(Address.parse(config.atfJettonAddress)));
      const expectedJettonWallet = await jettonMaster.getWalletAddress(ownerAddress);

      const transactions = await this.client.getTransactions(ownerAddress, { limit: 50 });

      for (const tx of transactions) {
        if (!tx.inMessage?.body) continue;

        const txHash = tx.hash().toString('hex');
        const uniqueId = `atf_deposit_${walletDoc.address}_${txHash}`;

        if (PROCESSED_TXS.has(uniqueId)) continue;

        const messageSource = getInternalMessageSource(tx);
        if (!messageSource) continue;

        if (messageSource !== expectedJettonWallet.toString()) continue;

        const notification = parseTransferNotification(tx.inMessage.body);
        if (!notification) continue;

        const existing = await Transaction.findOne({
          txHash,
          type: 'deposit',
          asset: 'ATF',
          'metadata.queryId': notification.queryId.toString(),
        });

        if (existing) {
          PROCESSED_TXS.add(uniqueId);
          continue;
        }

        const user = await User.findById(walletDoc.userId);
        if (!user) continue;

        // ── Calculate platform fee ──
        const feeBase = Precision.calculateFee(notification.amount, config.platformDepositFeePercent || 0);
        const netBase = Precision.subtract(notification.amount, feeBase);

        const displayGross = Precision.fromBaseUnits(notification.amount, ATF_DECIMALS);
        const displayNet = Precision.fromBaseUnits(netBase, ATF_DECIMALS);
        const displayFee = Precision.fromBaseUnits(feeBase, ATF_DECIMALS);

        // ── Credit user balance (net amount) ──
        user.atfBalance = Precision.add(
          BigInt(user.atfBalance || '0'),
          netBase
        ).toString();
        await user.save();

        const depositTx = await Transaction.create({
          userId: user._id,
          type: 'deposit',
          asset: 'ATF',
          amount: notification.amount.toString(),
          fee: feeBase.toString(),
          feeAsset: 'ATF',
          feePercentage: config.platformDepositFeePercent || 0,
          feeWallet: config.adminFeeWalletAddress,
          feeStatus: feeBase > BigInt(0) ? 'pending' : 'completed',
          status: 'completed',
          txHash,
          toAddress: walletDoc.address,
          fromAddress: notification.sender?.toString(),
          metadata: {
            queryId: notification.queryId.toString(),
            jettonWallet: expectedJettonWallet.toString(),
            lt: tx.lt?.toString(),
            blockTime: tx.now ? new Date(tx.now * 1000).toISOString() : undefined,
            netCredited: displayNet,
            platformFee: displayFee,
          },
        });

        PROCESSED_TXS.add(uniqueId);
        trimProcessedCache();

        // ── Send fee to admin wallet ──
        if (feeBase > BigInt(0)) {
          try {
            const feeTxHash = await this.walletService.sendJetton(
              user.telegramId,
              config.adminFeeWalletAddress,
              config.atfJettonAddress!,
              feeBase
            );
            depositTx.feeTxHash = feeTxHash;
            depositTx.feeStatus = 'completed';
            await depositTx.save();
          } catch (feeErr) {
            console.error(`[DepositService] ATF fee transfer failed for ${walletDoc.address}:`, feeErr);
            depositTx.feeStatus = 'failed';
            depositTx.metadata = {
              ...depositTx.metadata,
              feeError: (feeErr as Error).message,
            };
            await depositTx.save();
          }
        }

        await this.notifyDeposit(user.telegramId, 'ATF', displayNet, txHash, displayFee);
      }
    } catch (error) {
      console.error('ATF deposit check error:', error);
    }
  }

  private async notifyDeposit(
    telegramId: number,
    asset: string,
    amount: string,
    txHash: string,
    fee?: string
  ): Promise<void> {
    if (!botInstance || !telegramId) return;

    try {
      const shortHash = txHash.slice(0, 6) + '…' + txHash.slice(-4);
      const link = explorerLink(txHash);

      const lines = [
        `✅ <b>Deposit Received</b>`,
        ``,
        `Asset: <b>${asset}</b>`,
        `Amount: <b>${Precision.formatDisplay(amount)} ${asset}</b>`,
      ];

      if (fee && fee !== '0') {
        lines.push(`Fee: <b>${Precision.formatDisplay(fee)} ${asset}</b>`);
      }

      lines.push(
        `Speed: <b>~3s</b>`,
        ``,
        `<a href="${link}">View on Explorer</a>`
      );

      await botInstance.sendMessage(telegramId, lines.join('\n'), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.error(`Failed to notify user ${telegramId} about deposit:`, err);
    }
  }
         }
         
