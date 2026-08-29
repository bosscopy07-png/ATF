import cron from 'node-cron';
import { TonClient, Address, Cell } from '@ton/ton';
import { JettonMaster } from '@ton/ton';
import { config } from '../config';
import { User } from '../models/User';
import { Wallet } from '../models/Wallet';
import { Transaction } from '../models/Transaction';
import { Precision } from '../utils/precision';

const PROCESSED_TXS = new Set<string>();

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

export class BlockchainMonitor {
  private client: TonClient;
  private isRunning = false;
  private depositJob: any;
  private txJob: any;

  constructor() {
    this.client = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });
  }

  start(): void {
    this.depositJob = cron.schedule('*/30 * * * * *', async () => {
      if (this.isRunning) return;
      this.isRunning = true;
      try {
        await this.monitorAllDeposits();
      } catch (error) {
        console.error('Deposit monitor error:', error);
      } finally {
        this.isRunning = false;
      }
    });

    this.txJob = cron.schedule('*/60 * * * * *', async () => {
      try {
        await this.monitorPendingTransactions();
      } catch (error) {
        console.error('Pending tx monitor error:', error);
      }
    });

    console.log('Blockchain monitor schedules registered');
  }

  stop(): void {
    if (this.depositJob) this.depositJob.stop();
    if (this.txJob) this.txJob.stop();
    console.log('Blockchain monitor stopped');
  }

  private async monitorAllDeposits(): Promise<void> {
    const wallets = await Wallet.find().populate('userId', 'telegramId');

    for (const walletDoc of wallets as any[]) {
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

    try {
      const transactions = await this.client.getTransactions(address, { limit: 30 });

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

        user.tonBalance = Precision.add(BigInt(user.tonBalance), amount).toString();
        await user.save();

        await Transaction.create({
          userId: user._id,
          type: 'deposit',
          asset: 'TON',
          amount: amount.toString(),
          status: 'completed',
          txHash,
          toAddress: walletDoc.address,
          fromAddress: getInternalMessageSource(tx),
          metadata: {
            lt: tx.lt.toString(),
            blockTime: new Date(tx.now * 1000).toISOString(),
          },
        });

        PROCESSED_TXS.add(uniqueId);
        console.log(`TON deposit credited: ${amount.toString()} nanoTON to user ${user.telegramId}`);
      }
    } catch (error) {
      console.error(`TON deposit check error for ${walletDoc.address}:`, error);
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

        if (messageSource !== expectedJettonWallet.toString()) {
          continue;
        }

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

        user.atfBalance = Precision.add(BigInt(user.atfBalance), notification.amount).toString();
        await user.save();

        await Transaction.create({
          userId: user._id,
          type: 'deposit',
          asset: 'ATF',
          amount: notification.amount.toString(),
          status: 'completed',
          txHash,
          toAddress: walletDoc.address,
          fromAddress: notification.sender?.toString(),
          metadata: {
            queryId: notification.queryId.toString(),
            jettonWallet: expectedJettonWallet.toString(),
            lt: tx.lt.toString(),
            blockTime: new Date(tx.now * 1000).toISOString(),
          },
        });

        PROCESSED_TXS.add(uniqueId);
        console.log(`ATF deposit credited: ${notification.amount.toString()} nanoATF to user ${user.telegramId}`);
      }
    } catch (error) {
      console.error(`ATF deposit check error for ${walletDoc.address}:`, error);
    }
  }

  private async monitorPendingTransactions(): Promise<void> {
    const pending = await Transaction.find({
      status: { $in: ['pending', 'processing'] },
      txHash: { $exists: true, $ne: null },
      createdAt: { $gte: new Date(Date.now() - 3600000) },
    }).limit(50);

    for (const tx of pending) {
      try {
        if (!tx.txHash) continue;
        const ageMs = Date.now() - tx.createdAt.getTime();

        if (tx.type === 'withdrawal' && ageMs > 120000) {
          tx.status = 'completed';
          await tx.save();
          console.log(`Withdrawal ${tx._id} auto-confirmed`);
        }

        if (tx.type === 'fee_transfer' && ageMs > 120000) {
          tx.status = 'completed';
          await tx.save();

          if (tx.metadata?.swapTxId) {
            await Transaction.findByIdAndUpdate(tx.metadata.swapTxId, {
              feeStatus: 'completed',
              feeTxHash: tx.txHash,
            });
          }
          console.log(`Fee transfer ${tx._id} auto-confirmed`);
        }
      } catch (error) {
        console.error(`Pending tx monitor error for ${tx._id}:`, error);
      }
    }
  }
          }
                                            
