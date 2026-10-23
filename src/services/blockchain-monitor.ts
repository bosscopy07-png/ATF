import cron from 'node-cron';
import { TonClient, Address, Cell } from '@ton/ton';
import { JettonMaster } from '@ton/ton';
import { config } from '../config';
import { User } from '../models/User';
import { Wallet } from '../models/Wallet';
import { Transaction } from '../models/Transaction';
import { Precision } from '../utils/precision';

const PROCESSED_TXS = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * FIX A: platform-internal inflows are NEVER user deposits.
 *
 * The admin gas advance arrives as an incoming TON transfer from the
 * platform treasury; the old code booked it (and anything else from
 * platform wallets) into the user's internal balance — which let users
 * withdraw money the platform had only LENT them.
 */
function isInternalSender(address: string): boolean {
  const internal = [
    config.adminFeeWalletAddress,
    (config as any).adminWalletAddress,
  ]
    .filter(Boolean)
    .map((a) =>
      Address.parse(a as string).toString({ bounceable: false })
    );

  try {
    return internal.includes(
      Address.parse(address).toString({ bounceable: false })
    );
  } catch {
    return false;
  }
}

/**
 * Concise, non-circular error logging for the deposit monitor.
 * - A 429 from toncenter is expected occasionally under load; log it as a
 *   short one-liner, not the raw Axios error (which has circular refs and
 *   floods the log with the entire request/socket object graph).
 * - An E11000 duplicate-key hit here means another check (a concurrent
 *   worker instance, or an overlapping tick) already recorded this exact
 *   deposit a moment earlier — the unique index did its job and prevented
 *   a double-credit. That's expected and benign, not a failure.
 */
function logMonitorError(context: string, address: string, error: any): void {
  
  if (error?.code === 11000) {
  // Duplicate deposit record prevented by the unique index.
  // Expected concurrency; no need to log every occurrence.
  return;
  }
  const status = error?.response?.status;
  if (status === 429) {
    console.warn(`${context} for ${address}: toncenter rate-limited (429). Will retry next cycle.`);
    return;
  }
  console.error(`${context} for ${address}:`, error?.message || error);
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

export class BlockchainMonitor {
  private client: TonClient;
  private isRunning = false;
  private depositJob: any;

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

    // NOTE: this class previously also ran a `monitorPendingTransactions`
    // cron job here that marked withdrawals/fee_transfers 'completed' purely
    // because they were more than 2 minutes old — with no on-chain check at
    // all. That was removed: `src/jobs/reconciler.ts` already reconciles
    // exactly these transaction types every 30s using real on-chain
    // verification (`OnChainVerifier`, checking bounce/compute/action phase
    // results), running in the same worker process. Keeping both meant two
    // different code paths could race to "complete" the same transaction —
    // one honestly, one by assumption. Age alone is never evidence of
    // success; only the reconciler's on-chain check is.

    console.log('Blockchain monitor schedules registered');
  }

  stop(): void {
    if (this.depositJob) this.depositJob.stop();
    console.log('Blockchain monitor stopped');
  }

  private async monitorAllDeposits(): Promise<void> {
    const wallets = await Wallet.find().populate('userId', 'telegramId');

    for (const walletDoc of wallets as any[]) {
      try {
        await this.checkTonDeposits(walletDoc);
        // Small pacing gap so a growing wallet list never fires a burst of
        // near-simultaneous requests at toncenter — this, combined with the
        // jetton-wallet-address caching below, is what actually fixes the
        // 429 'Ratelimit exceed' errors, rather than papering over them.
        await sleep(150);
        await this.checkAtfDeposits(walletDoc);
        await sleep(150);
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

        /**
         * FIX A: platform-internal inflows (admin gas advance, anything
         * from the fee/treasury wallets) are NEVER user deposits.
         */
        const depositSender = getInternalMessageSource(tx);
        if (depositSender && isInternalSender(depositSender)) {
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
    } catch (error: any) {
      logMonitorError(`TON deposit check`, walletDoc.address, error);
    }
    }
  
  private async checkAtfDeposits(walletDoc: any): Promise<void> {
    const ownerAddress = Address.parse(walletDoc.address);

    try {
      // The jetton-wallet address for a given owner+jetton is deterministic
      // and never changes, so cache it on the Wallet doc instead of paying
      // an RPC call for it on every single 30-second poll, forever. This is
      // the single biggest contributor to the toncenter 429 rate-limit
      // errors, since it was firing once per wallet per tick indefinitely.
      let expectedJettonWallet: Address;
      if (walletDoc.atfJettonWalletAddress) {
        expectedJettonWallet = Address.parse(walletDoc.atfJettonWalletAddress);
      } else {
        const jettonMaster = this.client.open(JettonMaster.create(Address.parse(config.atfJettonAddress)));
        expectedJettonWallet = await jettonMaster.getWalletAddress(ownerAddress);
        await Wallet.findByIdAndUpdate(walletDoc._id, {
          $set: { atfJettonWalletAddress: expectedJettonWallet.toString() },
        });
      }

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
    } catch (error: any) {
      logMonitorError(`ATF deposit check`, walletDoc.address, error);
    }
  }
}
