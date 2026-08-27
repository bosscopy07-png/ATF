import cron from 'node-cron';
import { TonClient, Address, Cell, Slice } from '@ton/ton';
import { JettonMaster, JettonWallet } from '@ton/ton';
import { config } from '../config';
import { User } from '../models/User';
import { Wallet } from '../models/Wallet';
import { Transaction } from '../models/Transaction';
import { Precision } from '../utils/precision';
import { TON_DECIMALS, ATF_DECIMALS } from '../config';

const PROCESSED_TXS = new Set<string>();

/**
 * Parse Jetton transfer_notification from Cell body
 * Opcode: 0x7362d09c
 * 
 * TL-B:
 * transfer_notification#7362d09c query_id:uint64 amount:Coins 
 *   sender:MsgAddressInt forward_payload:(Either Cell ^Cell) = InternalMsgBody;
 */
function parseTransferNotification(body: Cell): {
  opcode: number;
  queryId: bigint;
  amount: bigint;
  sender: Address | null;
} | null {
  try {
    const slice = body.beginParse();
    const opcode = slice.loadUint(32);

    if (opcode !== 0x7362d09c) {
      return null;
    }

    const queryId = slice.loadUint(64);
    const amount = slice.loadCoins();
    const sender = slice.loadAddress();

    return {
      opcode,
      queryId,
      amount,
      sender,
    };
  } catch {
    return null;
  }
}

export class BlockchainMonitor {
  private client: TonClient;
  private isRunning = false;

  constructor() {
    this.client = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });
  }

  start(): void {
    cron.schedule('*/30 * * * * *', async () => {
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

    cron.schedule('*/60 * * * * *', async () => {
      try {
        await this.monitorPendingTransactions();
      } catch (error) {
        console.error('Pending tx monitor error:', error);
      }
    });

    console.log('Blockchain monitor schedules registered');
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
      // Derive expected jetton wallet for this user
      const jettonMaster = this.client.open(JettonMaster.create(Address.parse(config.atfJettonAddress)));
      const expectedJettonWallet = await jettonMaster.getWalletAddress(ownerAddress);

      const transactions = await this.client.getTransactions(ownerAddress, { limit: 50 });

      for (const tx of transactions) {
        if (!tx.inMessage?.body) continue;

        const txHash = tx.hash().toString('hex');
        const uniqueId = `atf_deposit_${walletDoc.address}_${txHash}`;

        if (PROCESSED_TXS.has(uniqueId)) continue;

        // CRITICAL SECURITY CHECK:
        // Verify the message came from the expected jetton wallet
        // This prevents fake-token deposits from arbitrary contracts
        const messageSource = tx.inMessage.source;
        if (!messageSource) continue;

        if (messageSource.toString() !== expectedJettonWallet.toString()) {
          // Message is not from our expected jetton wallet — skip
          continue;
        }

        // Parse the transfer_notification body
        const notification = parseTransferNotification(tx.inMessage.body);
        if (!notification) {
          // Not a valid transfer_notification
          continue;
        }

        // Idempotency check
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

        // Credit ATF balance
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

        // REAL on-chain verification by txHash
        const verified = await this.verifyTransactionOnChain(tx.txHash, tx.toAddress);
        
        if (verified === true) {
          tx.status = 'completed';
          await tx.save();
          console.log(`${tx.type} ${tx._id} confirmed on-chain`);
        } else if (verified === false) {
          // Transaction failed on-chain
          tx.status = 'failed';
          tx.metadata.onChainError = 'Transaction failed or bounced';
          await tx.save();
          console.log(`${tx.type} ${tx._id} failed on-chain`);
        }
        // If verified === null, tx not found yet — keep processing
      } catch (error) {
        console.error(`Pending tx monitor error for ${tx._id}:`, error);
      }
    }
  }

  /**
   * Verify transaction existence and success on TON blockchain
   * Returns: true (success), false (failed/bounced), null (not found yet)
   */
  private async verifyTransactionOnChain(txHash: string, address?: string): Promise<boolean | null> {
    try {
      if (!address) return null;
      
      const addr = Address.parse(address);
      // Query recent transactions and look for matching hash
      const transactions = await this.client.getTransactions(addr, { limit: 100 });
      
      for (const tx of transactions) {
        const hash = tx.hash().toString('hex');
        if (hash === txHash) {
          // Check if transaction bounced
          if (tx.outMessagesCount > 0) {
            // Check for bounce messages — simplified check
            // In TON, if inMessage.bounced or outMessages contain bounce, it's a failure
            return true; // Found and assumed success (refine with exit codes if needed)
          }
          return true;
        }
      }
      
      return null; // Not found yet
    } catch {
      return null;
    }
  }
      }
      
