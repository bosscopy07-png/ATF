
import { User } from '../models/User';
import { Transaction } from '../models/Transaction';
import { WalletService } from './wallet-service';
import { AdminWalletService } from './admin-wallet-service';
import { STONFiAdapter } from './stonfi-adapter';
import { PriceService } from './price-service';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS, ATF_DECIMALS } from '../config';

export interface SwapRequest {
  userId: number;
  direction: 'ton_to_atf' | 'atf_to_ton';
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
  txParams?: any;
  gasTon?: string;
  gasAtfEquivalent?: string;
  trueNetSwapAmount?: string;
}

function provisionalTxHash(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SwapService {
  private walletService: WalletService;
  private adminWallet: AdminWalletService;
  private stonfi: STONFiAdapter;
  private priceService: PriceService;

  constructor() {
    this.walletService = new WalletService();
    this.adminWallet = new AdminWalletService();
    this.stonfi = new STONFiAdapter();
    this.priceService = PriceService.getInstance();
  }

  async prepareSwap(request: SwapRequest): Promise<SwapConfirmation> {
    if (!config.atfJettonAddress) throw new Error('ATF jetton address not configured');

    const user = await User.findOne({ telegramId: request.userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    const isTonToAtf = request.direction === 'ton_to_atf';
    const inputDecimals = isTonToAtf ? TON_DECIMALS : ATF_DECIMALS;
    const outputDecimals = isTonToAtf ? ATF_DECIMALS : TON_DECIMALS;
    const amountBase = Precision.toBaseUnits(request.amount, inputDecimals);

    // ── BUG FIX #2: Use LIVE on-chain balance instead of stale MongoDB balance ──
    const walletAddress = await this.walletService.getAddress(request.userId);
    if (!walletAddress) throw new Error('Wallet not found');

    const { ton: onChainTon, atf: onChainAtf } = await this.walletService.getBalance(walletAddress);
    const liveBalance = isTonToAtf ? onChainTon : onChainAtf;

    if (Precision.isLessThan(liveBalance, amountBase)) {
      throw new Error('Insufficient balance');
    }

    const feeBase = Precision.calculateFee(amountBase, config.platformSwapFeePercent);
    let netSwapBase = Precision.subtract(amountBase, feeBase);

    if (isTonToAtf) {
      const minBase = Precision.toBaseUnits(config.minSwapTon.toString(), TON_DECIMALS);
      if (Precision.isLessThan(netSwapBase, minBase)) {
        throw new Error(`Minimum swap amount is ${config.minSwapTon} TON (after fees)`);
      }
    } else {
      if (netSwapBase <= BigInt(0)) {
        throw new Error('Amount too small after platform fee');
      }
    }

    let gasTon: string | undefined;
    let gasAtfEquivalentBase = BigInt(0);
    let trueNetSwapBase = netSwapBase;

    if (!isTonToAtf) {
      const prelimQuote = await this.stonfi.getQuote(
        config.atfJettonAddress,
        'ton',
        netSwapBase.toString(),
        (config.maxSlippagePercent / 100).toString()
      );

      const txParams = await this.stonfi.buildSwapTransaction(
        walletAddress,
        prelimQuote,
        config.atfJettonAddress,
        'ton'
      );

      gasTon = txParams.gasTon;
      const gasTonBase = txParams.value;

      const [tonPrice, atfPrice] = await Promise.all([
        this.priceService.getTonPriceUsd(),
        this.priceService.getAtfPriceUsd(),
      ]);

      if (!tonPrice || !atfPrice) {
        throw new Error('Price unavailable for gas estimation');
      }

      const gasUsd = parseFloat(gasTon) * tonPrice.price;
      const gasAtfFloat = gasUsd / atfPrice.price;
      gasAtfEquivalentBase = Precision.toBaseUnits(gasAtfFloat.toFixed(ATF_DECIMALS), ATF_DECIMALS);

      trueNetSwapBase = Precision.subtract(netSwapBase, gasAtfEquivalentBase);

      if (trueNetSwapBase <= BigInt(0)) {
        throw new Error('Amount too small after platform fee and network costs');
      }

      netSwapBase = trueNetSwapBase;
    }

    const offerAddress = isTonToAtf ? 'ton' : config.atfJettonAddress;
    const askAddress = isTonToAtf ? config.atfJettonAddress : 'ton';

    const quote = await this.stonfi.getQuote(
      offerAddress,
      askAddress,
      netSwapBase.toString(),
      (config.maxSlippagePercent / 100).toString()
    );

    let txParams: any;
    if (walletAddress) {
      txParams = await this.stonfi.buildSwapTransaction(walletAddress, quote, offerAddress, askAddress);
    }

    const inputDisplay = Precision.fromBaseUnits(amountBase, inputDecimals);
    const feeDisplay = Precision.fromBaseUnits(feeBase, inputDecimals);
    const netDisplay = Precision.fromBaseUnits(netSwapBase, inputDecimals);
    const outputDisplay = Precision.fromBaseUnits(BigInt(quote.askUnits), outputDecimals);
    const minOutputDisplay = Precision.fromBaseUnits(BigInt(quote.minAskUnits), outputDecimals);

    const rateValue = parseFloat(outputDisplay) / parseFloat(netDisplay);
    const rate = isTonToAtf
      ? `1 TON ≈ ${rateValue.toFixed(2)} ATF`
      : `1 ATF ≈ ${rateValue.toFixed(6)} TON`;

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
      txParams,
      gasTon,
      gasAtfEquivalent: gasAtfEquivalentBase > BigInt(0)
        ? Precision.fromBaseUnits(gasAtfEquivalentBase, ATF_DECIMALS)
        : undefined,
      trueNetSwapAmount: !isTonToAtf
        ? Precision.fromBaseUnits(trueNetSwapBase, ATF_DECIMALS)
        : undefined,
    };
  }

  async executeSwap(
    userId: number,
    confirmation: SwapConfirmation,
    direction: 'ton_to_atf' | 'atf_to_ton'
  ): Promise<string> {
    if (!config.atfJettonAddress) throw new Error('ATF jetton address not configured');

    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    if (new Date() > new Date(confirmation.expiresAt)) {
      throw new Error('Quote expired. Please request a new quote.');
    }

    const isTonToAtf = direction === 'ton_to_atf';
    const inputDecimals = isTonToAtf ? TON_DECIMALS : ATF_DECIMALS;
    const amountBase = Precision.toBaseUnits(confirmation.inputAmount, inputDecimals);
    const feeBase = Precision.calculateFee(amountBase, config.platformSwapFeePercent);

    let gasAtfBase = BigInt(0);
    if (!isTonToAtf && confirmation.gasAtfEquivalent) {
      gasAtfBase = Precision.toBaseUnits(confirmation.gasAtfEquivalent, ATF_DECIMALS);
    }

    // ── BUG FIX #2: Use LIVE on-chain balance instead of stale MongoDB balance ──
    const walletAddress = await this.walletService.getAddress(userId);
    if (!walletAddress) throw new Error('Wallet not found');

    const { ton: onChainTon, atf: onChainAtf } = await this.walletService.getBalance(walletAddress);
    const liveBalance = isTonToAtf ? onChainTon : onChainAtf;

    if (Precision.isLessThan(liveBalance, amountBase)) {
      throw new Error('Insufficient balance');
    }

    let tx: any;
    let deducted = false;

    try {
      user[balanceKey(isTonToAtf)] = Precision.subtract(
        BigInt(user[balanceKey(isTonToAtf)] || '0'),
        amountBase
      ).toString();
      await user.save();
      deducted = true;

      tx = await Transaction.create({
        userId: user._id,
        type: 'swap',
        asset: isTonToAtf ? 'TON' : 'ATF',
        amount: amountBase.toString(),
        fee: feeBase.toString(),
        feeAsset: isTonToAtf ? 'TON' : 'ATF',
        feePercentage: config.platformSwapFeePercent,
        feeWallet: config.adminFeeWalletAddress,
        feeStatus: 'pending',
        status: 'processing',
        txHash: provisionalTxHash('swap'),
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
          gasTon: confirmation.gasTon,
          gasAtfEquivalent: confirmation.gasAtfEquivalent,
          trueNetSwapAmount: confirmation.trueNetSwapAmount,
        },
      });

      if (!isTonToAtf && confirmation.gasTon) {
        const gasNano = BigInt(Math.round(parseFloat(confirmation.gasTon) * 1e9));
        await this.adminWallet.initialize();

        const adminBalance = await this.adminWallet.getBalance();
        if (adminBalance < gasNano) {
          throw new Error('Platform gas treasury temporarily low. Please try again later.');
        }

        const gasTxHash = await this.adminWallet.sendTon(walletAddress, gasNano);

        await Transaction.create({
          userId: user._id,
          type: 'fee_transfer',
          asset: 'TON',
          amount: gasNano.toString(),
          status: 'processing',
          toAddress: walletAddress,
          txHash: gasTxHash,
          metadata: {
            purpose: 'swap_gas_funding',
            fromAdmin: true,
            swapTxId: tx._id.toString(),
          },
        });

        await new Promise(r => setTimeout(r, 3000));
      }

      const offerAddress = isTonToAtf ? 'ton' : config.atfJettonAddress;
      const askAddress = isTonToAtf ? config.atfJettonAddress : 'ton';

      const swapParams = await this.stonfi.buildSwapTransaction(
        walletAddress,
        confirmation.quote,
        offerAddress,
        askAddress
      );

      if (isTonToAtf) {
        const { ton: onChainTonCheck } = await this.walletService.getBalance(walletAddress);
        const requiredTon = BigInt(swapParams.value.toString());
        if (onChainTonCheck < requiredTon) {
          throw new Error(
            `Wallet needs ~${Precision.fromBaseUnits(requiredTon, TON_DECIMALS)} TON for this swap ` +
            `(includes gas). Excess is returned. Deposit more TON.`
          );
        }
      }

      const txHash = await this.walletService.sendTon(
        userId,
        swapParams.to,
        BigInt(swapParams.value.toString()),
        swapParams.body
      );

      // ── BUG FIX #4: Mark transaction as COMPLETED after successful broadcast ──
      tx.txHash = txHash;
      tx.status = 'completed';
      tx.toAddress = swapParams.to;
      await tx.save();

      // Also update fee status to completed
      await Transaction.updateOne(
        { 'metadata.swapTxId': tx._id.toString(), type: 'fee_transfer' },
        { $set: { status: 'completed' } }
      );

      this.transferFee(userId, feeBase, isTonToAtf ? 'TON' : 'ATF', tx._id.toString())
        .catch(err => console.error('Fee transfer async error:', err));

      return tx._id.toString();
    } catch (error) {
      const broadcasted = tx?.txHash && !tx.txHash.startsWith('swap-');

      if (deducted && !broadcasted) {
        try {
          const currentUser = await User.findById(user._id);
          if (currentUser) {
            currentUser[balanceKey(isTonToAtf)] = Precision.add(
              BigInt(currentUser[balanceKey(isTonToAtf)] || '0'),
              amountBase
            ).toString();
            await currentUser.save();
          }
        } catch (rollbackErr) {
          console.error('[SwapService] Balance rollback failed:', rollbackErr);
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

  private async transferFee(
    userId: number,
    feeAmount: bigint,
    asset: 'TON' | 'ATF',
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
        txHash: provisionalTxHash('fee'),
        metadata: { swapTxId },
      });

      let txHash: string;
      if (asset === 'TON') {
        txHash = await this.walletService.sendTon(userId, config.adminFeeWalletAddress, feeAmount);
      } else {
        txHash = await this.walletService.sendJetton(
          userId,
          config.adminFeeWalletAddress,
          config.atfJettonAddress!,
          feeAmount
        );
      }

      // ── BUG FIX #4: Mark fee transfer as COMPLETED after successful broadcast ──
      feeTx.txHash = txHash;
      feeTx.status = 'completed';
      await feeTx.save();

      await Transaction.findByIdAndUpdate(swapTxId, { feeStatus: 'completed', feeTxHash: txHash });
    } catch (error) {
      console.error('Fee transfer failed:', error);
    }
  }
}

function balanceKey(isTonToAtf: boolean): string {
  return isTonToAtf ? 'tonBalance' : 'atfBalance';
    }
  
