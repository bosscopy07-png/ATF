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

// ─── Queue item for ATF→TON swaps ───────────────────────────────────────────
interface QueuedSwap {
  userId: number;
  confirmation: SwapConfirmation;
  direction: 'ton_to_atf' | 'atf_to_ton';
  resolve: (value: string) => void;
  reject: (reason: any) => void;
  enqueuedAt: number;
}

// ─── Smart queue: batches ATF→TON swaps based on admin TON balance ─────────
class AtfToTonQueue {
  private queue: QueuedSwap[] = [];
  private isRunning = false;
  private adminWallet: AdminWalletService;
  private executor: (userId: number, confirmation: SwapConfirmation, direction: 'ton_to_atf' | 'atf_to_ton') => Promise<string>;

  constructor(
    executor: (userId: number, confirmation: SwapConfirmation, direction: 'ton_to_atf' | 'atf_to_ton') => Promise<string>
  ) {
    this.adminWallet = new AdminWalletService();
    this.executor = executor;
  }

  async enqueue(
    userId: number,
    confirmation: SwapConfirmation,
    direction: 'ton_to_atf' | 'atf_to_ton'
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        userId,
        confirmation,
        direction,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });
      this.process();
    });
  }

  private async process() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      while (this.queue.length > 0) {
        // Reject expired items (5 min timeout)
        const now = Date.now();
        while (this.queue.length > 0 && now - this.queue[0].enqueuedAt > 5 * 60 * 1000) {
          const expired = this.queue.shift()!;
          expired.reject(new Error('Swap queue timeout. Admin gas treasury busy. Please try again.'));
        }

        if (this.queue.length === 0) break;

        await this.adminWallet.initialize();
        const adminBalance = await this.adminWallet.getBalance();

        // Gas required per swap + 0.05 TON safety buffer
        const firstItem = this.queue[0];
        const gasPerSwap = firstItem.confirmation.gasTon
          ? BigInt(Math.round(parseFloat(firstItem.confirmation.gasTon) * 1e9))
          : BigInt(Math.round(0.3 * 1e9));
        const buffer = BigInt(Math.round(0.05 * 1e9));
        const requiredPerSwap = gasPerSwap + buffer;

        if (adminBalance < requiredPerSwap) {
          console.log(
            `[SwapQueue] Admin balance ${Precision.fromBaseUnits(adminBalance, 9)} TON < ${Precision.fromBaseUnits(requiredPerSwap, 9)} TON required. Waiting...`
          );
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        // Calculate batch size: how many can we fund concurrently?
        let batchSize = 0;
        let totalRequired = BigInt(0);
        for (let i = 0; i < this.queue.length; i++) {
          const itemGas = this.queue[i].confirmation.gasTon
            ? BigInt(Math.round(parseFloat(this.queue[i].confirmation.gasTon!) * 1e9))
            : gasPerSwap;
          const itemRequired = itemGas + buffer;
          if (totalRequired + itemRequired > adminBalance) break;
          totalRequired += itemRequired;
          batchSize++;
        }

        batchSize = Math.max(1, batchSize);
        const batch = this.queue.splice(0, batchSize);

        console.log(
          `[SwapQueue] Processing batch of ${batchSize} swap(s). Queue remaining: ${this.queue.length}. Admin: ${Precision.fromBaseUnits(adminBalance, 9)} TON`
        );

        await Promise.all(
          batch.map(async (item) => {
            try {
              const result = await this.executor(item.userId, item.confirmation, item.direction);
              item.resolve(result);
            } catch (err) {
              item.reject(err);
            }
          })
        );

        // Brief pause for gas recoveries to settle before next batch check
        if (this.queue.length > 0) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    } catch (err) {
      console.error('[SwapQueue] Fatal queue error:', err);
    } finally {
      this.isRunning = false;
      if (this.queue.length > 0) {
        this.process();
      }
    }
  }
  }
  // ─── Swap Service ───────────────────────────────────────────────────────────
export class SwapService {
  private walletService: WalletService;
  private adminWallet: AdminWalletService;
  private stonfi: STONFiAdapter;
  private priceService: PriceService;
  private atfQueue: AtfToTonQueue;

  constructor() {
    this.walletService = new WalletService();
    this.adminWallet = new AdminWalletService();
    this.stonfi = new STONFiAdapter();
    this.priceService = PriceService.getInstance();
    this.atfQueue = new AtfToTonQueue((userId, confirmation, direction) =>
      this.executeSwapDirect(userId, confirmation, direction)
    );
  }

  // Public entry point — routes ATF→TON through queue, TON→ATF goes direct
  async executeSwap(
    userId: number,
    confirmation: SwapConfirmation,
    direction: 'ton_to_atf' | 'atf_to_ton'
  ): Promise<string> {
    if (direction === 'atf_to_ton') {
      return this.atfQueue.enqueue(userId, confirmation, direction);
    }
    return this.executeSwapDirect(userId, confirmation, direction);
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
                // ─── Direct execution (used by queue for ATF→TON and directly for TON→ATF) ───
  private async executeSwapDirect(
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
    let gasAdvanced = false;
    let gasAdvanceTxId: string | null = null;
    let gasClawbackTxHash: string | null = null;

    try {
      // Deduct FULL input amount (swap principal + platform fee) from user's DB balance
      const currentBalance = BigInt(user[balanceKey] || '0');
      user[balanceKey] = Precision.subtract(currentBalance, amountBase).toString();
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

        const gasTx = await Transaction.create({
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
        gasAdvanceTxId = gasTx._id.toString();
        gasAdvanced = true;

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
      if (!isTonToAtf && gasAdvanced && confirmation.gasTon) {
        this.recoverGasTon(
          userId,
          user._id,
          confirmation.gasTon,
          tx._id.toString()
        ).catch(err => console.error('[SwapService] Post-success gas recovery failed:', err));
      }

      // Transfer platform fee to admin wallet (async, only on success)
      this.transferFee(userId, feeBase, isTonToAtf ? 'TON' : 'ATF', tx._id.toString())
        .catch(err => console.error('[SwapService] Fee transfer async error:', err));

      return tx._id.toString();
    } catch (error) {
      const broadcasted = tx?.txHash && !tx.txHash.startsWith('swap-');

      // ═══════════════════════════════════════════════════════════════════════
      // 🚨 AUTOMATIC ON-CHAIN GAS CLAWBACK (BEFORE DB ROLLBACK)
      // ═══════════════════════════════════════════════════════════════════════
      if (gasAdvanced && !broadcasted && confirmation.gasTon) {
        try {
          const gasNano = BigInt(Math.round(parseFloat(confirmation.gasTon) * 1e9));

          // Check what the user still has on-chain RIGHT NOW
          const { ton: userTonNow } = await this.walletService.getBalance(walletAddress);
          const recoverable = userTonNow < gasNano ? userTonNow : gasNano;

          if (recoverable > BigInt(Math.round(0.01 * 1e9))) {
            // Must leave ~0.01 TON for fees so the clawback itself can broadcast
            const clawbackAmount = recoverable - BigInt(Math.round(0.01 * 1e9));
            
            if (clawbackAmount > BigInt(0)) {
              gasClawbackTxHash = await this.walletService.sendTon(
                userId,
                config.adminFeeWalletAddress,
                clawbackAmount
              );

              await Transaction.create({
                userId: user._id,
                type: 'fee_transfer',
                asset: 'TON',
                amount: clawbackAmount.toString(),
                status: 'completed',
                toAddress: config.adminFeeWalletAddress,
                txHash: gasClawbackTxHash,
                metadata: {
                  purpose: 'gas_clawback',
                  description: 'Automatic clawback of advanced gas TON after failed ATF→TON swap',
                  swapTxId: tx?._id?.toString() || gasAdvanceTxId || 'unknown',
                  requestedGas: confirmation.gasTon,
                  recoveredAmount: Precision.fromBaseUnits(clawbackAmount, TON_DECIMALS),
                  reason: (error as Error).message,
                },
              });

              console.log(
                `[SwapService] Gas clawback SUCCESS: ${Precision.fromBaseUnits(clawbackAmount, TON_DECIMALS)} TON ` +
                `from user ${userId} → admin. Tx: ${gasClawbackTxHash}`
              );
            }
          } else {
            console.log(`[SwapService] Gas clawback SKIPPED: user ${userId} has < 0.01 TON left.`);
          }
        } catch (clawbackErr: any) {
          console.error(
            `[SwapService] Gas clawback FAILED for user ${userId}: ${clawbackErr.message}. ` +
            `User may have already spent the gas TON.`
          );
          // Do NOT throw — we must proceed to DB rollback regardless
        }
      }

      // ── ROLLBACK: Restore BOTH swap principal AND platform fee to user DB balance ──
      if (deducted && !broadcasted) {
        try {
          const currentUser = await User.findById(user._id);
          if (currentUser) {
            const restoredBalance = Precision.add(
              BigInt(currentUser[balanceKey] || '0'),
              amountBase
            ).toString();
            currentUser[balanceKey] = restoredBalance;
            await currentUser.save();
            console.log(
              `[SwapService] Rollback complete: restored ${Precision.fromBaseUnits(amountBase, inputDecimals)} ` +
              `${isTonToAtf ? 'TON' : 'ATF'} (includes ${Precision.fromBaseUnits(feeBase, inputDecimals)} platform fee) to user ${userId}`
            );
          }
        } catch (rollbackErr) {
          console.error('[SwapService] Balance rollback failed:', rollbackErr);
        }
      }

      if (tx) {
        try {
          tx.status = 'failed';
          tx.metadata = {
            ...tx.metadata,
            error: (error as Error).message,
            broadcasted,
            gasClawbackTxHash: gasClawbackTxHash || undefined,
            gasClawbackAttempted: gasAdvanced && !broadcasted,
          };
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
      console.error('[SwapService] Fee transfer failed:', error);
    }
  }
}

