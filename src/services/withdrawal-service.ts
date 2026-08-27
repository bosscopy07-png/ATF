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

    const balanceKey = request.asset === 'TON' ? 'tonBalance' : 'atfBalance';
    const currentBalance = BigInt(user[balanceKey]);

    if (Precision.isLessThan(currentBalance, amountBase)) {
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

    const balanceKey = request.asset === 'TON' ? 'tonBalance' : 'aftBalance';
    const currentBalance = BigInt(user[balanceKey]);

    if (Precision.isLessThan(currentBalance, amountBase)) {
      throw new Error('Insufficient balance');
    }

    user[balanceKey] = Precision.subtract(currentBalance, amountBase).toString();
    await user.save();

    const tx = await Transaction.create({
      userId: user._id,
      type: 'withdrawal',
      asset: request.asset,
      amount: amountBase.toString(),
      status: 'processing',
      toAddress: request.toAddress,
      metadata: {
        requestedAmount: request.amount,
        destination: request.toAddress,
      },
    });

    try {
      let txHash: string;

      if (request.asset === 'TON') {
        txHash = await this.walletService.sendTon(request.userId, request.toAddress, amountBase);
      } else {
        txHash = await this.walletService.sendJetton(
          request.userId,
          request.toAddress,
          config.aftJettonAddress,
          amountBase
        );
      }

      tx.txHash = txHash;
      tx.status = 'processing';
      await tx.save();

      return tx._id.toString();
    } catch (error) {
      user[balanceKey] = Precision.add(BigInt(user[balanceKey]), amountBase).toString();
      await user.save();

      tx.status = 'failed';
      tx.metadata.error = (error as Error).message;
      await tx.save();

      throw error;
    }
  }
}
