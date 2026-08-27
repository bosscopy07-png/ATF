import { TonClient, Address, Cell } from '@ton/ton';
import { JettonMaster } from '@ton/ton';
import { User } from '../models/User';
import { Wallet } from '../models/Wallet';
import { Transaction } from '../models/Transaction';
import { Precision } from '../utils/precision';
import { config } from '../config';

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
    const queryId = slice.loadUint(64);
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

export class DepositService {
  private client: TonClient;

  constructor() {
    this.client = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });
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
      });

      PROCESSED_TXS.add(uniqueId);
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
          },
        });

        PROCESSED_TXS.add(uniqueId);
      }
    } catch (error) {
      console.error('ATF deposit check error:', error);
    }
  }
                                                                }
