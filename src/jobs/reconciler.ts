import mongoose from 'mongoose';
import { TonClient, Address } from '@ton/ton';
import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS, AFT_DECIMALS } from '../config';

const RECONCILE_INTERVAL_MS = 30000;
const MAX_CONFIRMATION_WAIT_MS = 3600000;

interface ReconcileResult {
  processed: number;
  confirmed: number;
  failed: number;
  feesRecovered: number;
}

class OnChainVerifier {
  private client: TonClient;

  constructor() {
    this.client = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });
  }

  /**
   * Verify a transaction on-chain by querying the destination address
   * Returns: true (confirmed success), false (failed/bounced), null (not yet visible)
   */
  async verifyTransaction(txHash: string, toAddress?: string): Promise<boolean | null> {
    try {
      if (!toAddress) return null;

      const addr = Address.parse(toAddress);
      const transactions = await this.client.getTransactions(addr, { limit: 100 });

      for (const tx of transactions) {
        const hash = tx.hash().toString('hex');
        if (hash === txHash) {
          // Check for bounce — if inMessage.bounced exists or outMessages indicate failure
          if (tx.inMessage && 'bounced' in tx.inMessage && tx.inMessage.bounced) {
            return false;
          }

          // Check transaction description for compute phase success
          // @ts-ignore — raw TON access
          if (tx.description?.computePhase?.success === false) {
            return false;
          }

          return true;
        }
      }

      return null; // Not found yet
    } catch (error) {
      console.error(`On-chain verification error for ${txHash}:`, error);
      return null;
    }
  }
}

const verifier = new OnChainVerifier();

async function reconcileSwaps(): Promise<ReconcileResult> {
  const result: ReconcileResult = { processed: 0, confirmed: 0, failed: 0, feesRecovered: 0 };

  const pendingSwaps = await Transaction.find({
    type: 'swap',
    status: { $in: ['pending', 'processing'] },
    createdAt: { $gte: new Date(Date.now() - MAX_CONFIRMATION_WAIT_MS) },
  }).limit(50);

  for (const swap of pendingSwaps) {
    result.processed++;

    if (!swap.txHash) continue;

    try {
      // REAL on-chain verification instead of time-based guessing
      const verified = await verifier.verifyTransaction(swap.txHash, swap.toAddress || undefined);

      if (verified === true) {
        // Swap succeeded on-chain — credit user output
        const user = await User.findById(swap.userId);
        if (user) {
          const outputAsset = swap.metadata?.swapDirection === 'ton_to_aft' ? 'aftBalance' : 'tonBalance';
          const outputAmount = swap.metadata?.expectedOutput || '0';
          user[outputAsset] = Precision.add(BigInt(user[outputAsset]), BigInt(outputAmount)).toString();
          await user.save();
        }

        swap.status = 'completed';
        await swap.save();
        result.confirmed++;

        // ─── FINALIZE GAS FUNDING TX IF PRESENT (AFT→TON seamless) ─────────
        if (swap.metadata?.gasTon) {
          await Transaction.updateMany(
            {
              type: 'fee_transfer',
              'metadata.swapTxId': swap._id.toString(),
              'metadata.purpose': 'swap_gas_funding',
            },
            { status: 'completed' }
          );
          console.log(`Gas funding finalized for swap ${swap._id}`);
        }

        // Handle fee transfer
        if (swap.feeStatus === 'pending' || swap.feeStatus === 'processing') {
          const feeTx = await Transaction.findOne({
            type: 'fee_transfer',
            'metadata.swapTxId': swap._id.toString(),
          });

          if (feeTx && feeTx.status === 'completed') {
            swap.feeStatus = 'completed';
            await swap.save();
          } else if (!feeTx || feeTx.status === 'failed') {
            await recoverFeeTransfer(swap);
            result.feesRecovered++;
          }
        }
      } else if (verified === false) {
        // Swap failed on-chain — rollback
        await rollbackSwap(swap);
        swap.status = 'failed';
        swap.metadata.onChainFailure = true;
        await swap.save();
        result.failed++;
      }
      // If verified === null, keep waiting
    } catch (error) {
      console.error(`Reconcile error for swap ${swap._id}:`, error);
      const ageMs = Date.now() - swap.createdAt.getTime();
      if (ageMs > MAX_CONFIRMATION_WAIT_MS) {
        await rollbackSwap(swap);
        swap.status = 'failed';
        swap.metadata.reconcileTimeout = true;
        await swap.save();
        result.failed++;
      }
    }
  }

  return result;
}

async function recoverFeeTransfer(swap: any): Promise<void> {
  try {
    const feeAmount = BigInt(swap.fee || '0');
    if (feeAmount <= BigInt(0)) return;

    const feeTx = await Transaction.findOneAndUpdate(
      { type: 'fee_transfer', 'metadata.swapTxId': swap._id.toString() },
      {
        $setOnInsert: {
          userId: swap.userId,
          type: 'fee_transfer',
          asset: swap.feeAsset,
          amount: feeAmount.toString(),
          status: 'pending',
          toAddress: config.adminFeeWalletAddress,
          metadata: { swapTxId: swap._id.toString(), recovery: true },
        },
      },
      { upsert: true, new: true }
    );

    feeTx.status = 'processing';
    await feeTx.save();

    console.log(`Fee recovery initiated for swap ${swap._id}`);
  } catch (error) {
    console.error(`Fee recovery failed for swap ${swap._id}:`, error);
  }
}

async function rollbackSwap(swap: any): Promise<void> {
  try {
    const user = await User.findById(swap.userId);
    if (!user) return;

    const inputAsset = swap.metadata?.swapDirection === 'ton_to_aft' ? 'tonBalance' : 'aftBalance';
    const inputAmount = BigInt(swap.amount);

    user[inputAsset] = Precision.add(BigInt(user[inputAsset]), inputAmount).toString();
    await user.save();

    console.log(`Swap ${swap._id} rolled back for user ${user.telegramId}`);
  } catch (error) {
    console.error(`Rollback failed for swap ${swap._id}:`, error);
  }
}

async function reconcileWithdrawals(): Promise<void> {
  const pendingWithdrawals = await Transaction.find({
    type: 'withdrawal',
    status: 'processing',
    createdAt: { $gte: new Date(Date.now() - MAX_CONFIRMATION_WAIT_MS) },
  }).limit(50);

  for (const tx of pendingWithdrawals) {
    try {
      if (!tx.txHash) continue;

      // REAL on-chain verification
      const verified = await verifier.verifyTransaction(tx.txHash, tx.toAddress || undefined);

      if (verified === true) {
        tx.status = 'completed';
        await tx.save();
        console.log(`Withdrawal ${tx._id} confirmed on-chain`);
      } else if (verified === false) {
        tx.status = 'failed';
        tx.metadata.onChainFailure = true;
        await tx.save();

        // ROLLBACK: Return funds to user since withdrawal failed
        const user = await User.findById(tx.userId);
        if (user) {
          const balanceKey = tx.asset === 'TON' ? 'tonBalance' : 'aftBalance';
          user[balanceKey] = Precision.add(BigInt(user[balanceKey]), BigInt(tx.amount)).toString();
          await user.save();
        }

        console.log(`Withdrawal ${tx._id} failed on-chain — funds returned to user`);
      }
    } catch (error) {
      console.error(`Withdrawal reconcile error ${tx._id}:`, error);
    }
  }
}

async function reconcileFeeTransfers(): Promise<void> {
  const pendingFees = await Transaction.find({
    type: 'fee_transfer',
    status: 'processing',
    createdAt: { $gte: new Date(Date.now() - MAX_CONFIRMATION_WAIT_MS) },
  }).limit(50);

  for (const tx of pendingFees) {
    try {
      if (!tx.txHash) continue;

      const verified = await verifier.verifyTransaction(tx.txHash, config.adminFeeWalletAddress);

      if (verified === true) {
        tx.status = 'completed';
        await tx.save();

        if (tx.metadata?.swapTxId) {
          await Transaction.findByIdAndUpdate(tx.metadata.swapTxId, {
            feeStatus: 'completed',
            feeTxHash: tx.txHash,
          });
        }
        console.log(`Fee transfer ${tx._id} confirmed on-chain`);
      } else if (verified === false) {
        tx.status = 'failed';
        tx.metadata.onChainFailure = true;
        await tx.save();
        console.log(`Fee transfer ${tx._id} failed on-chain`);
      }
    } catch (error) {
      console.error(`Fee reconcile error ${tx._id}:`, error);
    }
  }
}

async function reconcileDeposits(): Promise<void> {
  const orphanedDeposits = await Transaction.find({
    type: 'deposit',
    status: 'pending',
    createdAt: { $lte: new Date(Date.now() - 86400000) },
  }).limit(50);

  for (const tx of orphanedDeposits) {
    tx.status = 'failed';
    tx.metadata.reconcileNote = 'Orphaned deposit — no blockchain confirmation within 24h';
    await tx.save();
    console.log(`Orphaned deposit ${tx._id} marked failed`);
  }
}

async function runReconciliation(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Starting reconciliation...`);

  try {
    const swapResult = await reconcileSwaps();
    await reconcileWithdrawals();
    await reconcileFeeTransfers();
    await reconcileDeposits();

    console.log(
      `[${new Date().toISOString()}] Reconciliation complete: ` +
      `swaps processed=${swapResult.processed}, confirmed=${swapResult.confirmed}, ` +
      `failed=${swapResult.failed}, feesRecovered=${swapResult.feesRecovered}`
    );
  } catch (error) {
    console.error('Reconciliation error:', error);
  }
}

async function startReconciler(): Promise<void> {
  await mongoose.connect(config.mongodbUri);
  console.log('Reconciler connected to MongoDB');

  await runReconciliation();

  setInterval(runReconciliation, RECONCILE_INTERVAL_MS);

  console.log(`Reconciler running every ${RECONCILE_INTERVAL_MS}ms`);
}

process.on('SIGINT', async () => {
  console.log('Reconciler shutting down...');
  await mongoose.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Reconciler shutting down...');
  await mongoose.disconnect();
  process.exit(0);
});

if (require.main === module) {
  startReconciler().catch(console.error);
}

export { startReconciler, runReconciliation };
              
