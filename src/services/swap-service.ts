import { User } from '../models/User';
import { Transaction } from '../models/Transaction';
import { WalletService } from './wallet-service';
import { STONFiAdapter } from './stonfi-adapter';
import { PriceService } from './price-service';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS, AFT_DECIMALS } from '../config';

export interface SwapRequest {
  userId: number;
  direction: 'ton_to_aft' | 'aft_to_ton';
  amount: string;
}

export interface SwapConfirmation {
  inputAmount: string;
  platformFee: string;
  netSwapAmount: string;
  expectedOutput: string;
  minOutput: string;
  dexCosts: string;
  rate: string;
  expiresAt: Date;
  quote: any;
}

export class SwapService {
  private walletService: WalletService;
  private stonfi: STONFiAdapter;
  private priceService: PriceService;

  constructor() {
    this.walletService = new WalletService();
    this.stonfi = new STONFiAdapter();
    this.priceService = PriceService.getInstance();
  }

  async prepareSwap(request: SwapRequest): Promise<SwapConfirmation> {
    const user = await User.findOne({ telegramId: request.userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    const inputDecimals = request.direction === 'ton_to_aft' ? TON_DECIMALS : AFT_DECIMALS;
    const outputDecimals = request.direction === 'ton_to_aft' ? AFT_DECIMALS : TON_DECIMALS;
    const amountBase = Precision.toBaseUnits(request.amount, inputDecimals);

    if (request.direction === 'ton_to_aft') {
      const minBase = Precision.toBaseUnits(config.minSwapTon.toString(), TON_DECIMALS);
      if (Precision.isLessThan(amountBase, minBase)) {
        throw new Error(`Minimum swap amount is ${config.minSwapTon} TON`);
      }
    }

    const balanceKey = request.direction === 'ton_to_aft' ? 'tonBalance' : 'aftBalance';
    const currentBalance = BigInt(user[balanceKey]);
    if (Precision.isLessThan(currentBalance, amountBase)) {
      throw new Error('Insufficient balance');
    }

    const feeBase = Precision.calculateFee(amountBase, config.platformSwapFeePercent);
    const netSwapBase = Precision.subtract(amountBase, feeBase);

    if (netSwapBase <= BigInt(0)) {
      throw new Error('Amount too small after platform fee');
    }

    const offerAddress = request.direction === 'ton_to_aft' ? 'ton' : config.aftJettonAddress;
    const askAddress = request.direction === 'ton_to_aft' ? config.aftJettonAddress : 'ton';

    const quote = await this.stonfi.getQuote(
      offerAddress,
      askAddress,
      netSwapBase.toString(),
      (config.maxSlippagePercent / 100).toString()
    );

    const inputDisplay = Precision.fromBaseUnits(amountBase, inputDecimals);
    const feeDisplay = Precision.fromBaseUnits(feeBase, inputDecimals);
    const netDisplay = Precision.fromBaseUnits(netSwapBase, inputDecimals);
    const outputDisplay = Precision.fromBaseUnits(BigInt(quote.askUnits), outputDecimals);
    const minOutputDisplay = Precision.fromBaseUnits(BigInt(quote.minAskUnits), outputDecimals);

    const rateValue = parseFloat(outputDisplay) / parseFloat(netDisplay);
    const rate = request.direction === 'ton_to_aft'
      ? `1 TON ≈ ${rateValue.toFixed(2)} AFT`
      : `1 AFT ≈ ${rateValue.toFixed(6)} TON`;

    return {
      inputAmount: inputDisplay,
      platformFee: feeDisplay,
      netSwapAmount: netDisplay,
      expectedOutput: outputDisplay,
      minOutput: minOutputDisplay,
      dexCosts: Precision.fromBaseUnits(BigInt(quote.feeUnits || '0'), TON_DECIMALS),
      rate,
      expiresAt: quote.expiresAt,
      quote,
    };
  }

  async executeSwap(
    userId: number,
    confirmation: SwapConfirmation,
    direction: 'ton_to_aft' | 'aft_to_ton'
  ): Promise<string> {
    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    if (new Date() > new Date(confirmation.expiresAt)) {
      throw new Error('Quote expired. Please request a new quote.');
    }

    const inputDecimals = direction === 'ton_to_aft' ? TON_DECIMALS : AFT_DECIMALS;
    const amountBase = Precision.toBaseUnits(confirmation.inputAmount, inputDecimals);
    const feeBase = Precision.calculateFee(amountBase, config.platformSwapFeePercent);
    const netSwapBase = Precision.subtract(amountBase, feeBase);

    const balanceKey = direction === 'ton_to_aft' ? 'tonBalance' : 'aftBalance';
    const currentBalance = BigInt(user[balanceKey]);
    if (Precision.isLessThan(currentBalance, amountBase)) {
      throw new Error('Insufficient balance');
    }

    user[balanceKey] = Precision.subtract(currentBalance, amountBase).toString();
    await user.save();

    const tx = await Transaction.create({
      userId: user._id,
      type: 'swap',
      asset: direction === 'ton_to_aft' ? 'TON' : 'AFT',
      amount: amountBase.toString(),
      fee: feeBase.toString(),
      feeAsset: direction === 'ton_to_aft' ? 'TON' : 'AFT',
      feePercentage: config.platformSwapFeePercent,
      feeWallet: config.adminFeeWalletAddress,
      feeStatus: 'pending',
      status: 'processing',
      metadata: {
        swapDirection: direction,
        inputAmount: confirmation.inputAmount,
        platformFee: confirmation.platformFee,
        netSwapAmount: confirmation.netSwapAmount,
        expectedOutput: confirmation.expectedOutput,
        minOutput: confirmation.minOutput,
        slippage: config.maxSlippagePercent,
        dexCosts: confirmation.dexCosts,
        expiresAt: confirmation.expiresAt,
        quote: confirmation.quote,
      },
    });

    try {
      const walletAddress = await this.walletService.getAddress(userId);
      if (!walletAddress) throw new Error('Wallet not found');

      const offerAddress = direction === 'ton_to_aft' ? 'ton' : config.aftJettonAddress;
      const askAddress = direction === 'ton_to_aft' ? config.aftJettonAddress : 'ton';

      const swapParams = await this.stonfi.buildSwapTransaction(
        walletAddress,
        confirmation.quote,
        offerAddress,
        askAddress
      );

      const txHash = await this.walletService.sendTon(
        userId,
        swapParams.to.toString(),
        BigInt(swapParams.value.toString())
      );

      tx.txHash = txHash;
      tx.status = 'processing';
      tx.toAddress = swapParams.to.toString(); // Store router address for verification
      await tx.save();

      this.transferFee(userId, feeBase, direction === 'ton_to_aft' ? 'TON' : 'AFT', tx._id.toString())
        .catch(err => console.error('Fee transfer async error:', err));

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

  private async transferFee(
    userId: number,
    feeAmount: bigint,
    asset: 'TON' | 'AFT',
    swapTxId: string
  ): Promise<void> {
    try {
      const user = await User.findOne({ telegramId: userId });
      if (!user) return;

      const feeTx = await Transaction.create({
        userId: user._id,
        type: 'fee_transfer',
        asset,
        amount: feeAmount.toString(),
        status: 'processing',
        toAddress: config.adminFeeWalletAddress,
        metadata: { swapTxId },
      });

      let txHash: string;
      if (asset === 'TON') {
        txHash = await this.walletService.sendTon(userId, config.adminFeeWalletAddress, feeAmount);
      } else {
        txHash = await this.walletService.sendJetton(
          userId,
          config.adminFeeWalletAddress,
          config.aftJettonAddress,
          feeAmount
        );
      }

      feeTx.txHash = txHash;
      feeTx.status = 'processing';
      await feeTx.save();

      await Transaction.findByIdAndUpdate(swapTxId, { feeStatus: 'processing', feeTxHash: txHash });
    } catch (error) {
      console.error('Fee transfer failed:', error);
    }
  }
}
