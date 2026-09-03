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

    // ── LIVE on-chain balance check ──
    const walletAddress = await this.walletService.getAddress(request.userId);
    if (!walletAddress) throw new Error('Wallet not found');

    const { ton: onChainTon, atf: onChainAtf } = await this.walletService.getBalance(walletAddress);
    const liveBalance = isTonToAtf ? onChainTon : onChainAtf;

    if (Precision.isLessThan(liveBalance, amountBase)) {
      throw new Error('Insufficient balance');
    }

    // Platform fee deducted from INPUT asset only
    const feeBase = Precision.calculateFee(amountBase, config.platformSwapFeePercent);
    const netSwapBase = Precision.subtract(amountBase, feeBase);

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

    // ── ATF→TON: estimate gas TON needed (display only, not deducted from swap) ──
    let gasTon: string | undefined;

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
    }

    const offerAddress = isTonToAtf ? 'ton' : config.atfJettonAddress;
    const askAddress = isTonToAtf ? config.atfJettonAddress : 'ton';

    // Quote built for FULL netSwapBase (after platform fee only)
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

    const rateValue = parseFloat(netDisplay) > 0 ? parseFloat(outputDisplay) / parseFloat(netDisplay) : 0;
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
    const balanceKey = isTonToAtf ? 'tonBalance' : 'atfBalance';

    // ── LIVE on-chain balance check ──
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
      // Deduct full input amount from user's DB balance
      user[balanceKey] = Precision.subtract(
        BigInt(user[balanceKey] || '0'),
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
        },
      });

      // ── ATF→TON: Admin sends gas TON to user's wallet ──
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
          status: 'completed',
          toAddress: walletAddress,
          txHash: gasTxHash,
          metadata: {
            purpose: 'gas_advance',
            description: 'Gas TON advanced by admin for ATF→TON swap',
            fromAdmin: true,
            swapTxId: tx._id.toString(),
          },
        });

        // Wait for balance to settle on-chain
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

      // TON→ATF: ensure user has enough TON for the swap + gas
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

      // Execute the swap on-chain
      const txHash = await this.walletService.sendTon(
        userId,
        swapParams.to,
        BigInt(swapParams.value.toString()),
        swapParams.body
      );

      // Mark as COMPLETED after successful broadcast
      tx.txHash = txHash;
      tx.status = 'completed';
      tx.toAddress = swapParams.to;
      await tx.save();

      // ── RECOVER GAS: Send the advanced TON back to admin ──
      if (!isTonToAtf && confirmation.gasTon) {
        this.recoverGasTon(
          userId,
          user._id,
          confirmation.gasTon,
          tx._id.toString()
        ).catch(err => console.error('[SwapService] Gas recovery failed:', err));
      }

      // Transfer platform fee to admin wallet (async)
      this.transferFee(userId, feeBase, isTonToAtf ? 'TON' : 'ATF', tx._id.toString())
        .catch(err => console.error('Fee transfer async error:', err));

      return tx._id.toString();
    } catch (error) {
      const broadcasted = tx?.txHash && !tx.txHash.startsWith('swap-');

      if (deducted && !broadcasted) {
        try {
          const currentUser = await User.findById(user._id);
          if (currentUser) {
            currentUser[balanceKey] = Precision.add(
              BigInt(currentUser[balanceKey] || '0'),
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

  // ─── Send advanced gas TON back to admin after swap succeeds ───
  private async recoverGasTon(
    userId: number,
    userObjectId: any,
    gasTon: string,
    swapTxId: string
  ): Promise<void> {
    // Give the swap time to settle on-chain before recovering
    await new Promise(r => setTimeout(r, 8000));

    const gasNano = BigInt(Math.round(parseFloat(gasTon) * 1e9));

    try {
      const recoveryTxHash = await this.walletService.sendTon(
        userId,
        config.adminFeeWalletAddress,
        gasNano
      );

      await Transaction.create({
        userId: userObjectId,
        type: 'fee_transfer',
        asset: 'TON',
        amount: gasNano.toString(),
        status: 'completed',
        toAddress: config.adminFeeWalletAddress,
        txHash: recoveryTxHash,
        metadata: {
          purpose: 'gas_recovery',
          description: 'Recovery of gas TON advanced by admin for ATF→TON swap',
          swapTxId,
          gasTon,
        },
      });

      // Link recovery to original swap tx
      await Transaction.findByIdAndUpdate(swapTxId, {
        $set: { 'metadata.gasRecovered': true, 'metadata.gasRecoveryTxHash': recoveryTxHash },
      });

      console.log(`[SwapService] Gas recovery completed: ${recoveryTxHash}`);
    } catch (error) {
      console.error('[SwapService] Gas recovery failed:', error);
      // Don't throw — swap already succeeded, this is just cleanup
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
        type: 'fee',
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

      feeTx.txHash = txHash;
      feeTx.status = 'completed';
      await feeTx.save();

      await Transaction.findByIdAndUpdate(swapTxId, { feeStatus: 'completed', feeTxHash: txHash });
    } catch (error) {
      console.error('Fee transfer failed:', error);
    }
  }
          }
        
