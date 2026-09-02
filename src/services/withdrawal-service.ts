import { User } from '../models/User';
import { Transaction } from '../models/Transaction';
import { WalletService } from './wallet-service';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS, ATF_DECIMALS } from '../config';
import { isValidTonAddress } from '../utils/validation';

export interface WithdrawalRequest {
  userId: number;
  asset: 'TON' | 'ATF';
  amount: string;
  toAddress: string;
}

export interface WithdrawalPreview {
  asset: string;
  toAddress: string;
  amount: string;
  networkCost: string;
  receiveAmount: string;
}

function provisionalTxHash(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class WithdrawalService {
  private walletService: WalletService;

  constructor() {
    this.walletService = new WalletService();
  }

  async prepareWithdrawal(request: WithdrawalRequest): Promise<WithdrawalPreview> {
    const user = await User.findOne({ telegramId: request.userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    if (!isValidTonAddress(request.toAddress)) {
      throw new Error('Invalid destination address');
    }

    const decimals = request.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS;
    const amountBase = Precision.toBaseUnits(request.amount, decimals);

    if (amountBase <= BigInt(0)) {
      throw new Error('Amount must be greater than zero');
    }

    // ── BUG FIX #3: Use LIVE on-chain balance instead of stale MongoDB balance ──
    const walletAddress = await this.walletService.getAddress(request.userId);
    if (!walletAddress) throw new Error('Wallet not found');

    const { ton: onChainTon, atf: onChainAtf } = await this.walletService.getBalance(walletAddress);
    const liveBalance = request.asset === 'TON' ? onChainTon : onChainAtf;

    if (Precision.isLessThan(liveBalance, amountBase)) {
      throw new Error('Insufficient balance');
    }

    const networkCostBase = request.asset === 'TON'
      ? Precision.toBaseUnits('0.005', TON_DECIMALS)
      : Precision.toBaseUnits('0.05', TON_DECIMALS);

    const receiveBase = request.asset === 'TON'
      ? Precision.subtract(amountBase, networkCostBase)
      : amountBase;

    if (receiveBase <= BigInt(0)) {
      throw new Error('Amount too small to cover network costs');
    }

    return {
      asset: request.asset,
      toAddress: request.toAddress,
      amount: request.amount,
      networkCost: Precision.fromBaseUnits(networkCostBase, TON_DECIMALS),
      receiveAmount: Precision.fromBaseUnits(receiveBase, decimals),
    };
  }

  async executeWithdrawal(request: WithdrawalRequest): Promise<string> {
    const user = await User.findOne({ telegramId: request.userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    const decimals = request.asset === 'TON' ? TON_DECIMALS : ATF_DECIMALS;
    const amountBase = Precision.toBaseUnits(request.amount, decimals);

    const walletAddress = await this.walletService.getAddress(request.userId);
    if (!walletAddress) throw new Error('Wallet not found');

    // ── BUG FIX #3: Use LIVE on-chain balance instead of stale MongoDB balance ──
    const { ton: onChainTon, atf: onChainAtf } = await this.walletService.getBalance(walletAddress);
    const liveBalance = request.asset === 'TON' ? onChainTon : onChainAtf;

    if (Precision.isLessThan(liveBalance, amountBase)) {
      throw new Error('Insufficient balance');
    }

    const networkCostBase = request.asset === 'TON'
      ? Precision.toBaseUnits('0.005', TON_DECIMALS)
      : Precision.toBaseUnits('0.05', TON_DECIMALS);

    const sendBase = request.asset === 'TON'
      ? Precision.subtract(amountBase, networkCostBase)
      : amountBase;

    if (sendBase <= BigInt(0)) {
      throw new Error('Amount too small to cover network costs');
    }

    if (request.asset === 'TON' && onChainTon < amountBase) {
      throw new Error('On-chain TON balance insufficient. Funds may be pending or already spent.');
    }
    if (request.asset === 'ATF' && onChainTon < networkCostBase) {
      throw new Error('Custodial wallet lacks TON for gas. Deposit TON to this wallet first.');
    }

    let tx: any;
    let deducted = false;

    try {
      const balanceKey = request.asset === 'TON' ? 'tonBalance' : 'atfBalance';
      user[balanceKey] = Precision.subtract(
        BigInt(user[balanceKey] || '0'),
        amountBase
      ).toString();
      await user.save();
      deducted = true;

      tx = await Transaction.create({
        userId: user._id,
        type: 'withdrawal',
        asset: request.asset,
        amount: amountBase.toString(),
        status: 'processing',
        toAddress: request.toAddress,
        txHash: provisionalTxHash('withdrawal'),
        metadata: {
          requestedAmount: request.amount,
          destination: request.toAddress,
          networkCost: Precision.fromBaseUnits(networkCostBase, TON_DECIMALS),
          sendAmount: Precision.fromBaseUnits(sendBase, decimals),
        },
      });

      let txHash: string;

      if (request.asset === 'TON') {
        txHash = await this.walletService.sendTon(request.userId, request.toAddress, sendBase);
      } else {
        txHash = await this.walletService.sendJetton(
          request.userId,
          request.toAddress,
          config.atfJettonAddress!,
          sendBase
        );
      }

      // ── BUG FIX #4: Mark transaction as COMPLETED after successful broadcast ──
      tx.txHash = txHash;
      tx.status = 'completed';
      await tx.save();

      return tx._id.toString();
    } catch (error) {
      const broadcasted = tx?.txHash && !tx.txHash.startsWith('withdrawal-');

      if (deducted && !broadcasted) {
        try {
          const currentUser = await User.findById(user._id);
          if (currentUser) {
            const balanceKey = request.asset === 'TON' ? 'tonBalance' : 'atfBalance';
            currentUser[balanceKey] = Precision.add(
              BigInt(currentUser[balanceKey] || '0'),
              amountBase
            ).toString();
            await currentUser.save();
          }
        } catch (rollbackErr) {
          console.error('[WithdrawalService] Balance rollback failed:', rollbackErr);
        }
      }

      if (tx) {
        try {
          tx.status = 'failed';
          tx.metadata = { ...tx.metadata, error: (error as Error).message, broadcasted };
          await tx.save();
        } catch {}
      }

      throw error;
    }
  }
          }
