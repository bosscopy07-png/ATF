import { TonClient, Address, Cell } from '@ton/ton';
import { JettonMaster } from '@ton/ton';
import { User } from '../models/User';
import { Wallet } from '../models/Wallet';
import { Transaction } from '../models/Transaction';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS } from '../config';

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
        await this.checkAftDeposits(walletDoc);
      } catch (error) {
        console.error(`Deposit check failed for ${walletDoc.address}:`, error);
      }
    }
  }

  private async checkTonDeposits(walletDoc: any): Promise<void> {
    const address = Address.parse(walletDoc.address);
    const transactions = await this.client.getTransactions(address, { limit: 20 });

    for (const tx of transactions) {
      if (!tx.inMessage?.value || tx.inMessage.value === BigInt(0)) continue;

      const txHash = tx.hash().toString('hex');
      const uniqueId = `ton_deposit_${walletDoc.address}_${txHash}`;

      if (PROCESSED_TXS.has(uniqueId)) continue;

      const existing = await Transaction.findOne({ txHash, type: 'deposit', asset: 'TON' });
      if (existing) {
        PROCESSED_TXS.add(uniqueId);
        continue;
      }

      const amount = tx.inMessage.value;
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
        fromAddress: tx.inMessage.source?.toString(),
      });

      PROCESSED_TXS.add(uniqueId);
    }
  }

  private async checkAftDeposits(walletDoc: any): Promise<void> {
    const ownerAddress = Address.parse(walletDoc.address);

    try {
      const jettonMaster = this.client.open(JettonMaster.create(Address.parse(config.aftJettonAddress)));
      const expectedJettonWallet = await jettonMaster.getWalletAddress(ownerAddress);

      const transactions = await this.client.getTransactions(ownerAddress, { limit: 50 });

      for (const tx of transactions) {
        if (!tx.inMessage?.body) continue;

        const txHash = tx.hash().toString('hex');
        const uniqueId = `aft_deposit_${walletDoc.address}_${txHash}`;

        if (PROCESSED_TXS.has(uniqueId)) continue;

        const messageSource = tx.inMessage.source;
        if (!messageSource) continue;

        // SECURITY: Verify source is expected jetton wallet
        if (messageSource.toString() !== expectedJettonWallet.toString()) continue;

        const notification = parseTransferNotification(tx.inMessage.body);
        if (!notification) continue;

        const existing = await Transaction.findOne({ 
          txHash, 
          type: 'deposit', 
          asset: 'AFT',
          'metadata.queryId': notification.queryId.toString(),
        });
        
        if (existing) {
          PROCESSED_TXS.add(uniqueId);
          continue;
        }

        const user = await User.findById(walletDoc.userId);
        if (!user) continue;

        user.aftBalance = Precision.add(BigInt(user.aftBalance), notification.amount).toString();
        await user.save();

        await Transaction.create({
          userId: user._id,
          type: 'deposit',
          asset: 'AFT',
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
      console.error('AFT deposit check error:', error);
    }
  }
}
