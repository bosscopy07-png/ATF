import crypto from 'crypto';

import { User } from '../models/User';
import { Transaction } from '../models/Transaction';
import { SwapIdempotency } from '../models/SwapIdempotency';

import { WalletService } from './wallet-service';
import { AdminWalletService } from './admin-wallet-service';
import { STONFiAdapter } from './stonfi-adapter';
import { PriceService } from './price-service';

import {
  GasRecoveryService,
  gasTonToNano,
} from './gas-recovery-service';

import { Precision } from '../utils/precision';
import { checkRateLimit } from '../utils/rate-limiter';
import { withLock } from '../utils/distributed-lock';

import {
  config,
  TON_DECIMALS,
  ATF_DECIMALS,
} from '../config';

// ── PHASE 2 addition: centralized fee engine ──
import { FeeEngine } from '../config/fees';

// ── PHASE 2 addition: on-chain jetton balance reads ──
import { Address } from '@ton/core';
import { TonClient, JettonMaster, JettonWallet } from '@ton/ton';

export interface SwapRequest {
  userId: number;
  direction: 'ton_to_atf' | 'atf_to_ton';
  amount: string;
}

export interface SwapConfirmation {
  confirmationId: string;
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

/* ─────────────────────────────────────────────
   QUEUE ITEM
   ───────────────────────────────────────────── */

interface QueuedSwap {
  userId: number;
  confirmation: SwapConfirmation;
  direction: 'ton_to_atf' | 'atf_to_ton';
  resolve: (value: string) => void;
  reject: (reason: any) => void;
  enqueuedAt: number;
}

/* ─────────────────────────────────────────────
   ATF → TON QUEUE
   ───────────────────────────────────────────── */

class AtfToTonQueue {
  private queue: QueuedSwap[] = [];
  private isRunning = false;
  private adminWallet: AdminWalletService;

  private executor: (
    userId: number,
    confirmation: SwapConfirmation,
    direction: 'ton_to_atf' | 'atf_to_ton'
  ) => Promise<string>;

  constructor(
    executor: (
      userId: number,
      confirmation: SwapConfirmation,
      direction: 'ton_to_atf' | 'atf_to_ton'
    ) => Promise<string>
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
        const now = Date.now();

        // Expire items waiting too long
        while (
          this.queue.length > 0 &&
          now - this.queue[0].enqueuedAt > 5 * 60 * 1000
        ) {
          const expired = this.queue.shift()!;
          expired.reject(
            new Error(
              'Swap queue timeout. Admin gas treasury busy. Please try again.'
            )
          );
        }

        if (this.queue.length === 0) break;

        await this.adminWallet.initialize();

        const adminBalance = await this.adminWallet.getBalance();
        const firstItem = this.queue[0];

        const gasPerSwap = firstItem.confirmation.gasTon
          ? gasTonToNano(firstItem.confirmation.gasTon)
          : gasTonToNano('0.3');

        const buffer = gasTonToNano('0.05');
        const requiredPerSwap = gasPerSwap + buffer;

        if (adminBalance < requiredPerSwap) {
          console.log(
            `[SwapQueue] Admin balance ${Precision.fromBaseUnits(adminBalance, 9)} TON < ${Precision.fromBaseUnits(requiredPerSwap, 9)} TON required. Waiting...`
          );
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        // Determine how many swaps fit in the admin balance (batch)
        let batchSize = 0;
        let totalRequired = 0n;

        for (let i = 0; i < this.queue.length; i++) {
          const itemGas = this.queue[i].confirmation.gasTon
            ? gasTonToNano(this.queue[i].confirmation.gasTon!)
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
              const result = await this.executor(
                item.userId,
                item.confirmation,
                item.direction
              );
              item.resolve(result);
            } catch (err) {
              item.reject(err);
            }
          })
        );

        if (this.queue.length > 0) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } catch (err) {
      console.error('[SwapQueue] Fatal queue error:', err);
    } finally {
      this.isRunning = false;
      if (this.queue.length > 0) this.process();
    }
  }
}

/* ─────────────────────────────────────────────
   SWAP SERVICE
   ───────────────────────────────────────────── */

export class SwapService {
  private walletService: WalletService;
  private adminWallet: AdminWalletService;
  private stonfi: STONFiAdapter;
  private priceService: PriceService;
  private atfQueue: AtfToTonQueue;
  private gasRecovery: GasRecoveryService;
  // ── PHASE 2 addition ──
  private tonClient: TonClient;

  constructor() {
    this.walletService = new WalletService();
    this.adminWallet = new AdminWalletService();
    this.stonfi = new STONFiAdapter();
    this.priceService = PriceService.getInstance();
    this.gasRecovery = new GasRecoveryService(this.walletService);
    // ── PHASE 2 addition ──
    this.tonClient = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });

    this.atfQueue = new AtfToTonQueue((userId, confirmation, direction) =>
      this.executeSwapDirect(userId, confirmation, direction)
    );
  }

  /* ─────────────────────────────────────────────
     PUBLIC SWAP EXECUTION
     ───────────────────────────────────────────── */

  async executeSwap(
    userId: number,
    confirmation: SwapConfirmation,
    direction: 'ton_to_atf' | 'atf_to_ton'
  ): Promise<string> {
    await checkRateLimit(
      'swap:execute',
      userId,
      config.swapExecuteRateLimit,
      config.swapExecuteRateWindowMs
    );

    if (!confirmation.confirmationId) {
      throw new Error('Invalid or expired quote. Please request a new quote.');
    }

    return withLock(`lock:swap:${userId}`, config.swapLockTtlMs, async () => {
      const idemKey = `swap:${userId}:${confirmation.confirmationId}`;

      const raw: any = await SwapIdempotency.findOneAndUpdate(
        { key: idemKey },
        {
          $setOnInsert: {
            key: idemKey,
            userId,
            confirmationId: confirmation.confirmationId,
            status: 'processing',
          },
        },
        { upsert: true, new: true, rawResult: true }
      );

      const alreadyExisted = raw?.lastErrorObject?.updatedExisting === true;

      if (alreadyExisted) {
        const existing = raw.value;

        if (existing.status === 'completed' && existing.transactionId) {
          return existing.transactionId;
        }

        if (existing.status === 'processing') {
          throw new Error(
            'This swap is already being processed. Please wait for it to finish.'
          );
        }

        throw new Error(
          existing.error ||
            'This swap already failed. Please request a new quote.'
        );
      }

      try {
        const txId =
          direction === 'atf_to_ton'
            ? await this.atfQueue.enqueue(userId, confirmation, direction)
            : await this.executeSwapDirect(userId, confirmation, direction);

        await SwapIdempotency.updateOne(
          { key: idemKey },
          {
            $set: {
              status: 'completed',
              transactionId: txId,
              updatedAt: new Date(),
            },
          }
        );

        return txId;
      } catch (error: any) {
        await SwapIdempotency.updateOne(
          { key: idemKey },
          {
            $set: {
              status: 'failed',
              error: error?.message || String(error),
              updatedAt: new Date(),
            },
          }
        );

        throw error;
      }
    });
  }

  /* ─────────────────────────────────────────────
     PREPARE QUOTE
     ───────────────────────────────────────────── */

  async prepareSwap(request: SwapRequest): Promise<SwapConfirmation> {
    if (!config.atfJettonAddress) {
      throw new Error('ATF jetton address not configured');
    }

    await checkRateLimit(
      'swap:prepare',
      request.userId,
      config.swapPrepareRateLimit,
      config.swapPrepareRateWindowMs
    );

    const user = await User.findOne({ telegramId: request.userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    const isTonToAtf = request.direction === 'ton_to_atf';

    const inputDecimals = isTonToAtf ? TON_DECIMALS : ATF_DECIMALS;
    const outputDecimals = isTonToAtf ? ATF_DECIMALS : TON_DECIMALS;

    const amountBase = Precision.toBaseUnits(request.amount, inputDecimals);

    const walletAddress = await this.walletService.getAddress(request.userId);
    if (!walletAddress) throw new Error('Wallet not found');

    const { ton: onChainTon, atf: onChainAtf } =
      await this.walletService.getBalance(walletAddress);

    const liveBalance = isTonToAtf ? onChainTon : onChainAtf;

    // ── Fee-on-top rule ──
    // The platform fee is settled from the wallet AFTER the swap, so the
    // user must hold amount + fee. Swapping the ENTIRE balance leaves
    // nothing to pay the platform fee and the flow fails. Reject upfront
    // with the concrete maximum the user CAN swap.
    const feePercentEarly = this.legacySwapPercent(request.direction);
    const feeBaseEarly = Precision.calculateFee(amountBase, feePercentEarly);
    const totalRequiredEarly = Precision.add(amountBase, feeBaseEarly);

    if (Precision.isLessThan(liveBalance, totalRequiredEarly)) {
      const pScaled = BigInt(Math.round(feePercentEarly * 100)); // percent → basis points
      const maxAmount =
        pScaled > 0n ? (liveBalance * 10_000n) / (10_000n + pScaled) : liveBalance;
      const inputSymbol = isTonToAtf ? 'TON' : 'ATF';

      throw new Error(
        `You can't swap your full balance — the platform fee must remain available.\n\n` +
        `Balance: <b>${Precision.fromBaseUnits(liveBalance, inputDecimals)} ${inputSymbol}</b>\n` +
        `Fee reserve: ~${Precision.fromBaseUnits(feeBaseEarly, inputDecimals)} ${inputSymbol}\n\n` +
        (maxAmount > 0n
          ? `Maximum you can swap: <b>${Precision.fromBaseUnits(maxAmount, inputDecimals)} ${inputSymbol}</b>`
          : `Your balance is too low to swap — deposit more ${inputSymbol} first.`)
      );
    }

    // Fee rate from the centralized policy (2% default per FEE_* env vars)
    const feePercent = feePercentEarly;
    const feeBase = feeBaseEarly;
    const netSwapBase = Precision.subtract(amountBase, feeBase);

    if (isTonToAtf) {
      const minBase = Precision.toBaseUnits(
        config.minSwapTon.toString(),
        TON_DECIMALS
      );
      if (Precision.isLessThan(netSwapBase, minBase)) {
        throw new Error(
          `Minimum swap amount is ${config.minSwapTon} TON (after fees)`
        );
      }
    } else {
      if (netSwapBase <= 0n) {
        throw new Error('Amount too small after platform fee');
      }
    }

    let gasTon: string | undefined;

    if (!isTonToAtf) {
      // Pre-fetch gas requirement for ATF → TON swaps
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

    const quote = await this.stonfi.getQuote(
      offerAddress,
      askAddress,
      netSwapBase.toString(),
      (config.maxSlippagePercent / 100).toString()
    );

    let txParams: any | undefined;
    if (walletAddress) {
      txParams = await this.stonfi.buildSwapTransaction(
        walletAddress,
        quote,
        offerAddress,
        askAddress
      );
    }

    // ── Upfront affordability (TON→ATF): STON.fi's tx value is the
    //    authoritative requirement; the optional reserve (default 0)
    //    covers the exact-balance edge. ──
    if (isTonToAtf && txParams) {
      const requiredTon =
        BigInt(txParams.value.toString()) + config.swapGasReserveNano;

      if (onChainTon < requiredTon) {
        const deficit = requiredTon - onChainTon;
        const suggestedMax = amountBase > deficit ? amountBase - deficit : 0n;

        throw new Error(
          `Insufficient TON for this swap.\n\n` +
          `Needed: ~${Precision.fromBaseUnits(requiredTon, TON_DECIMALS)} TON ` +
          `(amount + ${Precision.fromBaseUnits(feeBase, TON_DECIMALS)} fee + network gas)\n` +
          `Your balance: ${Precision.fromBaseUnits(onChainTon, TON_DECIMALS)} TON\n\n` +
          (suggestedMax > 0n
            ? `Try a smaller amount — roughly <b>${Precision.fromBaseUnits(suggestedMax, TON_DECIMALS)} TON</b> or less.`
            : `Your balance is too low to swap TON right now — deposit more TON first.`)
        );
      }
    }

    const inputDisplay = Precision.fromBaseUnits(amountBase, inputDecimals);
    const feeDisplay = Precision.fromBaseUnits(feeBase, inputDecimals);
    const netDisplay = Precision.fromBaseUnits(netSwapBase, inputDecimals);
    const outputDisplay = Precision.fromBaseUnits(
      BigInt(quote.askUnits),
      outputDecimals
    );
    const minOutputDisplay = Precision.fromBaseUnits(
      BigInt(quote.minAskUnits),
      outputDecimals
    );

    const rateValue =
      parseFloat(netDisplay) > 0
        ? parseFloat(outputDisplay) / parseFloat(netDisplay)
        : 0;

    const rate = isTonToAtf
      ? `1 TON ≈ ${rateValue.toFixed(2)} ATF`
      : `1 ATF ≈ ${rateValue.toFixed(6)} TON`;

    return {
      confirmationId: crypto.randomUUID(),
      inputAmount: inputDisplay,
      platformFee: feeDisplay,
      netSwapAmount: netDisplay,
      expectedOutput: outputDisplay,
      minOutput: minOutputDisplay,
      dexCosts: Precision.fromBaseUnits(
        BigInt(quote.feeUnits || '0'),
        TON_DECIMALS
      ),
      rate,
      expiresAt: quote.expiresAt,
      quote,
      txParams,
      gasTon,
    };
  }
    /* ═══════════════════════════════════════════════════════════
     PHASE 2 — GENERIC TOKEN SWAP (ton→token, token→ton, token→token)
     The TON↔ATF methods above are UNCHANGED.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Centralized fee % for the legacy TON↔ATF directions.
   * Reads from feePolicy so the FEE_* env vars are the single source.
   */
  private legacySwapPercent(direction: 'ton_to_atf' | 'atf_to_ton'): number {
    return direction === 'ton_to_atf'
      ? config.feePolicy.tonToTokenPercent
      : config.feePolicy.tokenToTonInputPercent;
  }

  /**
   * Resolve offer/ask pair for generic swap directions.
   * 'ton' is the STON.fi native alias handled by the adapter.
   * token→token requires the OUTPUT token master (tokenMasterOut);
   * no route is ever fabricated.
   */
  private resolvePair(
    direction: string,
    tokenMaster: string,
    tokenMasterOut?: string
  ): {
    offer: string;
    ask: string;
    kind: 'ton_to_token' | 'token_to_ton' | 'token_to_token';
  } {
    if (direction === 'ton_to_token') {
      return { offer: 'ton', ask: tokenMaster, kind: 'ton_to_token' };
    }
    if (direction === 'token_to_ton') {
      return { offer: tokenMaster, ask: 'ton', kind: 'token_to_ton' };
    }
    if (direction === 'token_to_token') {
      if (!tokenMasterOut) {
        throw new Error('Token → token requires the output token to be selected');
      }
      return { offer: tokenMaster, ask: tokenMasterOut, kind: 'token_to_token' };
    }
    throw new Error('Unsupported swap direction');
  }

  /**
   * PHASE 2 helper: read an arbitrary jetton balance on-chain.
   */
  private async readJettonBalance(
    walletAddress: string,
    masterAddress: string
  ): Promise<bigint> {
    const master = this.tonClient.open(
      JettonMaster.create(Address.parse(masterAddress))
    );
    const jettonWalletAddress = await master.getWalletAddress(
      Address.parse(walletAddress)
    );
    const jettonWallet = this.tonClient.open(
      JettonWallet.create(jettonWalletAddress)
    );
    return await jettonWallet.getBalance();
  }

  /**
   * Prepare a generic token swap quote.
   * Mirrors prepareSwap: rate-limit → frozen check → fee-on-top balance
   * rule → centralized fee plan → STON.fi quote → txParams.
   */
  async prepareTokenSwap(
    userId: number,
    direction: string,
    tokenMaster: string,
    tokenDecimals: number,
    amount: string,
    tokenMasterOut?: string,
    tokenOutDecimals?: number
  ): Promise<
    SwapConfirmation & {
      feePlan: any;
      tokenMaster: string;
      tokenMasterOut?: string;
      tokenDecimals: number;
      tokenOutDecimals?: number;
      direction: string;
    }
  > {
    if (!config.features.multiTokenSwap) {
      throw new Error('This feature is not enabled yet');
    }

    const pair = this.resolvePair(direction, tokenMaster, tokenMasterOut);
    const inputDecimals =
      pair.kind === 'ton_to_token' ? TON_DECIMALS : tokenDecimals;
    const outputDecimals =
      pair.kind === 'token_to_ton'
        ? TON_DECIMALS
        : (tokenOutDecimals ?? tokenDecimals);

    await checkRateLimit(
      'swap:prepare',
      userId,
      config.swapPrepareRateLimit,
      config.swapPrepareRateWindowMs
    );

    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    const amountBase = Precision.toBaseUnits(amount, inputDecimals);
    if (amountBase <= 0n) throw new Error('Invalid amount');

    const walletAddress = await this.walletService.getAddress(userId);
    if (!walletAddress) throw new Error('Wallet not found');

    /* ── Live balance check (input asset, on-chain) ── */
    let liveInput: bigint;
    if (pair.kind === 'ton_to_token') {
      const { ton } = await this.walletService.getBalance(walletAddress);
      liveInput = ton;
    } else {
      liveInput = await this.readJettonBalance(walletAddress, tokenMaster);
    }

    // ── Fee-on-top rule (same as prepareSwap): amount + input-side fee ──
    const feePctP = FeeEngine.platformPercentFor(pair.kind);
    const feeBaseP = FeeEngine.percentOf(amountBase, feePctP);
    const totalReqP = Precision.add(amountBase, feeBaseP);

    if (Precision.isLessThan(liveInput, totalReqP)) {
      const pScaled = BigInt(Math.round(feePctP * 100)); // percent → basis points
      const maxAmount =
        pScaled > 0n ? (liveInput * 10_000n) / (10_000n + pScaled) : liveInput;

      throw new Error(
        `You can't swap your full balance — the platform fee must remain available.\n\n` +
        `Maximum you can swap: <b>${Precision.fromBaseUnits(maxAmount, inputDecimals)}</b>`
      );
    }

    /* ── Centralized fee plan (input XOR output — never both) ── */
    const preQuote = await this.stonfi.getQuote(
      pair.offer,
      pair.ask,
      amountBase.toString(),
      (config.maxSlippagePercent / 100).toString()
    );

    const feePlan = FeeEngine.planSwapFees(
      pair.kind,
      amountBase,
      BigInt(preQuote.askUnits)
    );
    const dexInputBase = feePlan.netInputBase;

    if (dexInputBase <= 0n) {
      throw new Error('Amount too small after platform fee');
    }

    /* ── Final quote on the NET input ── */
    const quote = await this.stonfi.getQuote(
      pair.offer,
      pair.ask,
      dexInputBase.toString(),
      (config.maxSlippagePercent / 100).toString()
    );

    const finalPlan = FeeEngine.planSwapFees(
      pair.kind,
      amountBase,
      BigInt(quote.askUnits)
    );

    const txParams = await this.stonfi.buildSwapTransaction(
      walletAddress,
      quote,
      pair.offer,
      pair.ask
    );

    const netInputDisplay = Precision.fromBaseUnits(
      finalPlan.netInputBase,
      inputDecimals
    );
    const outputDisplay = Precision.fromBaseUnits(
      BigInt(quote.askUnits),
      outputDecimals
    );

    const rateValue =
      parseFloat(netInputDisplay) > 0
        ? parseFloat(outputDisplay) / parseFloat(netInputDisplay)
        : 0;

    return {
      confirmationId: crypto.randomUUID(),
      inputAmount: Precision.fromBaseUnits(amountBase, inputDecimals),
      platformFee: Precision.fromBaseUnits(
        finalPlan.platformFeeInputBase > 0n
          ? finalPlan.platformFeeInputBase
          : finalPlan.platformFeeOutputBase,
        finalPlan.feeBase === 'input' ? inputDecimals : outputDecimals
      ),
      netSwapAmount: netInputDisplay,
      expectedOutput: outputDisplay,
      minOutput: Precision.fromBaseUnits(
        BigInt(quote.minAskUnits),
        outputDecimals
      ),
      dexCosts: Precision.fromBaseUnits(
        BigInt(quote.feeUnits || '0'),
        TON_DECIMALS
      ),
      rate: `1 input ≈ ${rateValue.toFixed(6)} output`,
      expiresAt: quote.expiresAt,
      quote,
      txParams,
      gasTon: txParams.gasTon,
      feePlan: {
        kind: finalPlan.kind,
        feeBase: finalPlan.feeBase,
        platformPercent: finalPlan.platformPercent,
        grossInputBase: finalPlan.grossInputBase.toString(),
        platformFeeInputBase: finalPlan.platformFeeInputBase.toString(),
        platformFeeOutputBase: finalPlan.platformFeeOutputBase.toString(),
        tonOutputFeeBase: finalPlan.tonOutputFeeBase.toString(),
        netInputBase: finalPlan.netInputBase.toString(),
        netOutputBase: finalPlan.netOutputBase.toString(),
      },
      tokenMaster,
      tokenMasterOut,
      tokenDecimals,
      tokenOutDecimals,
      direction,
    };
  }

  /**
   * Execute a generic token swap THROUGH the existing idempotency and
   * locking engine (same pattern as executeSwap). A retried callback,
   * double tap, or worker restart converges on the SAME idempotency row.
   */
  async executeTokenSwap(
    userId: number,
    confirmation: SwapConfirmation & {
      tokenMaster: string;
      tokenMasterOut?: string;
      direction: string;
      feePlan?: any;
    },
    tokenDecimals: number
  ): Promise<string> {
    if (!config.features.multiTokenSwap) {
      throw new Error('This feature is not enabled yet');
    }

    return withLock(`lock:swap:${userId}`, config.swapLockTtlMs, async () => {
      const idemKey = `swap:${userId}:${confirmation.confirmationId}`;

      const raw: any = await SwapIdempotency.findOneAndUpdate(
        { key: idemKey },
        {
          $setOnInsert: {
            key: idemKey,
            userId,
            confirmationId: confirmation.confirmationId,
            status: 'processing',
          },
        },
        { upsert: true, new: true, rawResult: true }
      );

      const existed = raw?.lastErrorObject?.updatedExisting === true;
      if (existed) {
        const existing = raw.value;
        if (existing.status === 'completed' && existing.transactionId) {
          return existing.transactionId;
        }
        if (existing.status === 'processing') {
          throw new Error(
            'This swap is already being processed. Please wait for it to finish.'
          );
        }
        throw new Error(
          existing.error || 'This swap already failed. Request a new quote.'
        );
      }

      try {
        // Revalidate quote freshness at execution time
        if (new Date() > new Date(confirmation.expiresAt)) {
          throw new Error('Quote expired. Please request a new quote.');
        }

        const pair = this.resolvePair(
          confirmation.direction,
          confirmation.tokenMaster,
          confirmation.tokenMasterOut
        );
        const inputDecimals =
          pair.kind === 'ton_to_token' ? TON_DECIMALS : tokenDecimals;
        const outputDecimals =
          pair.kind === 'token_to_ton'
            ? TON_DECIMALS
            : ((confirmation as any).tokenOutDecimals ?? tokenDecimals);

        const user = await User.findOne({ telegramId: userId });
        if (!user) throw new Error('User not found');
        if (user.isFrozen) throw new Error('Account is frozen');

        const amountBase = Precision.toBaseUnits(
          confirmation.inputAmount,
          inputDecimals
        );
        const walletAddress = await this.walletService.getAddress(userId);
        if (!walletAddress) throw new Error('Wallet not found');

        // Fallback fee plan (defensive; normally present on confirmation)
        const feePlan = (confirmation as any).feePlan ?? {
          kind: pair.kind,
          feeBase: 'input',
          platformPercent: config.platformSwapFeePercent,
          platformFeeInputBase: Precision.calculateFee(
            amountBase,
            config.platformSwapFeePercent
          ).toString(),
          platformFeeOutputBase: '0',
          tonOutputFeeBase: '0',
          netInputBase: Precision.subtract(
            amountBase,
            Precision.calculateFee(amountBase, config.platformSwapFeePercent)
          ).toString(),
          netOutputBase: '0',
        };

        const platformFeeBase = BigInt(feePlan.platformFeeInputBase || '0');

        /* ── Record BEFORE broadcast (recoverable) ── */
        const tx = await Transaction.create({
          userId: user._id,
          type: 'swap',
          asset: pair.kind === 'ton_to_token' ? 'TON' : 'TOKEN',
          amount: amountBase.toString(),
          fee: Precision.fromBaseUnits(platformFeeBase, inputDecimals),
          feeAsset: pair.kind === 'ton_to_token' ? 'TON' : 'TOKEN',
          feePercentage: feePlan.platformPercent,
          feeWallet: config.adminFeeWalletAddress,
          feeStatus: 'pending',
          status: 'processing',
          txHash: provisionalTxHash('swap'),
          metadata: {
            swapDirection: confirmation.direction,
            tokenMaster: confirmation.tokenMaster,
            tokenMasterOut: confirmation.tokenMasterOut,
            tokenDecimals,
            tokenOutDecimals: (confirmation as any).tokenOutDecimals,
            tokenSymbol: (confirmation as any).tokenSymbol,
            tokenOutSymbol: (confirmation as any).tokenOutSymbol,
            inputAmount: confirmation.inputAmount,
            platformFee: confirmation.platformFee,
            netSwapAmount: confirmation.netSwapAmount,
            expectedOutput: confirmation.expectedOutput,
            minOutput: confirmation.minOutput,
            feePlan,
            tonOutputFee:
              pair.kind === 'token_to_ton'
                ? Precision.fromBaseUnits(
                    BigInt(feePlan.tonOutputFeeBase || '0'),
                    TON_DECIMALS
                  )
                : undefined,
            slippage: config.maxSlippagePercent,
            dexCosts: confirmation.dexCosts,
            expiresAt: confirmation.expiresAt,
            quote: confirmation.quote,
            gasTon: confirmation.gasTon,
            walletAddress,
            swapOutcome: 'unknown',
            swapBroadcasted: false,
            actualOutputBaseUnits: '0',
            minOutputBaseUnits: String(confirmation.quote?.minAskUnits || '0'),
            expectedOutputBaseUnits: String(confirmation.quote?.askUnits || '0'),
          },
        });

        const swapParams = await this.stonfi.buildSwapTransaction(
          walletAddress,
          confirmation.quote,
          pair.offer,
          pair.ask
        );

        /* ── Pre-broadcast funding requirements ── */
        if (pair.kind === 'ton_to_token') {
          const { ton } = await this.walletService.getBalance(walletAddress);
          // STON.fi's value is authoritative; optional reserve (default 0).
          const requiredTon =
            BigInt(swapParams.value.toString()) + config.swapGasReserveNano;
          if (ton < requiredTon) {
            throw new Error(
              `Insufficient TON for this swap (amount + network gas). ` +
              `Needed ~${Precision.fromBaseUnits(requiredTon, TON_DECIMALS)} TON. ` +
              `Reduce the amount or deposit more TON.`
            );
          }
        } else {
          // Token input: re-verify jetton balance covers amount + fee (fee-on-top)
          const live = await this.readJettonBalance(
            walletAddress,
            confirmation.tokenMaster
          );
          const feePctX = FeeEngine.platformPercentFor(pair.kind);
          const requiredToken = Precision.add(
            amountBase,
            FeeEngine.percentOf(amountBase, feePctX)
          );
          if (Precision.isLessThan(live, requiredToken)) {
            throw new Error(
              `Insufficient balance — the platform fee must remain available after your swap. Reduce the amount.`
            );
          }
        }

        const txHash = await this.walletService.sendTon(
          userId,
          swapParams.to,
          BigInt(swapParams.value.toString()),
          swapParams.body
        );

        // Atomic targeted update — NEVER tx.save() here (metadata clobber risk)
        await Transaction.updateOne(
          { _id: tx._id },
          {
            $set: {
              txHash,
              status: 'processing',
              toAddress: swapParams.to,
              'metadata.swapBroadcasted': true,
              'metadata.swapOutcome': 'pending',
              'metadata.broadcastedAt': new Date().toISOString(),
            },
          }
        );

        await SwapIdempotency.updateOne(
          { key: idemKey },
          {
            $set: {
              status: 'completed',
              transactionId: tx._id.toString(),
              updatedAt: new Date(),
            },
          }
        );

        return tx._id.toString();
      } catch (error: any) {
        await SwapIdempotency.updateOne(
          { key: idemKey },
          {
            $set: {
              status: 'failed',
              error: error?.message || String(error),
              updatedAt: new Date(),
            },
          }
        );
        throw error;
      }
    });
              }
            /* ─────────────────────────────────────────────
     DIRECT EXECUTION
     ───────────────────────────────────────────── */

  private async executeSwapDirect(
    userId: number,
    confirmation: SwapConfirmation,
    direction: 'ton_to_atf' | 'atf_to_ton'
  ): Promise<string> {
    if (!config.atfJettonAddress) {
      throw new Error('ATF jetton address not configured');
    }

    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    if (new Date() > new Date(confirmation.expiresAt)) {
      throw new Error('Quote expired. Please request a new quote.');
    }

    const isTonToAtf = direction === 'ton_to_atf';
    const inputDecimals = isTonToAtf ? TON_DECIMALS : ATF_DECIMALS;
    const amountBase = Precision.toBaseUnits(
      confirmation.inputAmount,
      inputDecimals
    );
    const feePercent = this.legacySwapPercent(direction);
    const feeBase = Precision.calculateFee(amountBase, feePercent);

    const balanceKey = isTonToAtf ? 'tonBalance' : 'atfBalance';

    const walletAddress = await this.walletService.getAddress(userId);
    if (!walletAddress) throw new Error('Wallet not found');

    const { ton: onChainTon, atf: onChainAtf } =
      await this.walletService.getBalance(walletAddress);

    const liveBalance = isTonToAtf ? onChainTon : onChainAtf;

    // ── Fee-on-top guard (execution time): balance may have dropped
    //    between quote and confirm. The fee must remain coverable. ──
    if (Precision.isLessThan(liveBalance, Precision.add(amountBase, feeBase))) {
      throw new Error(
        `Insufficient balance — the platform fee must remain available after your swap. Reduce the amount and try again.`
      );
    }

    let tx: any;
    let deducted = false;
    let gasAdvanced = false;
    let gasAdvanceTxId: string | null = null;
    let gasClawbackTxHash: string | null = null;

    try {
      /**
       * Deduct internal balance before blockchain execution.
       */
      const currentBalance = BigInt(user[balanceKey] || '0');
      user[balanceKey] = Precision.subtract(
        currentBalance,
        amountBase
      ).toString();
      await user.save();
      deducted = true;

      /**
       * Create the swap transaction BEFORE the gas advance.
       *
       * This is critical because the swap record is where the
       * gas-recovery audit state is stored.
       */
      tx = await Transaction.create({
        userId: user._id,
        type: 'swap',
        asset: isTonToAtf ? 'TON' : 'ATF',
        amount: amountBase.toString(),
        fee: feeBase.toString(),
        feeAsset: isTonToAtf ? 'TON' : 'ATF',
        feePercentage: feePercent,
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
          minOutputBaseUnits: String(confirmation.quote?.minAskUnits || '0'),
          expectedOutputBaseUnits: String(confirmation.quote?.askUnits || '0'),
          swapOutcome: 'unknown',
          walletAddress,
          actualOutputBaseUnits: '0',
          swapBroadcasted: false,
        },
      });

      /* ─────────────────────────────────────────
         ATF → TON:
         ADMIN ADVANCES GAS
         ───────────────────────────────────────── */

      if (!isTonToAtf && confirmation.gasTon) {
        const gasNano = gasTonToNano(confirmation.gasTon);
        await this.adminWallet.initialize();

        const adminBalance = await this.adminWallet.getBalance();
        if (adminBalance < gasNano) {
          throw new Error(
            'Platform gas treasury temporarily low. Please try again later.'
          );
        }

        /**
         * Capture the user's exact TON balance immediately
         * before the company gas is sent.
         */
        const { ton: preAdvanceBalanceRaw } =
          await this.walletService.getBalance(walletAddress);

        const preAdvanceBalanceNano = BigInt(preAdvanceBalanceRaw.toString());

        /**
         * Company sends gas to the EXACT wallet.
         */
        const gasTxHash = await this.adminWallet.sendTon(
          walletAddress,
          gasNano
        );

        /**
         * Audit the gas advance.
         */
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
            walletAddress,
          },
        });

        gasAdvanceTxId = gasTx._id.toString();
        gasAdvanced = true;

        /**
         * IMPORTANT:
         *
         * Store the EXACT wallet address in the swap's
         * gas-recovery record.
         */
        await this.gasRecovery.recordAdvance({
          swapTransactionId: tx._id.toString(),
          walletAddress,
          tonBalanceBeforeGasAdvanceNano: preAdvanceBalanceNano,
          gasAdvanceAmountNano: gasNano,
          gasAdvanceTxHash: gasTxHash,
        });

        /**
         * Give the gas transfer a moment to settle before
         * constructing/broadcasting the swap.
         */
        await new Promise((r) => setTimeout(r, 3000));
      }

      const offerAddress = isTonToAtf ? 'ton' : config.atfJettonAddress;
      const askAddress = isTonToAtf ? config.atfJettonAddress : 'ton';

      const swapParams = await this.stonfi.buildSwapTransaction(
        walletAddress,
        confirmation.quote,
        offerAddress,
        askAddress
      );

      /**
       * TON → ATF: STON.fi's tx value is the authoritative requirement
       * (amount + DEX fees); the optional reserve (default 0) covers the
       * exact-balance edge.
       */
      if (isTonToAtf) {
        const { ton: onChainTonCheck } = await this.walletService.getBalance(
          walletAddress
        );
        const requiredTon =
          BigInt(swapParams.value.toString()) + config.swapGasReserveNano;

        if (onChainTonCheck < requiredTon) {
          throw new Error(
            `Insufficient TON for this swap.\n\n` +
            `Needed: ~${Precision.fromBaseUnits(requiredTon, TON_DECIMALS)} TON (amount + network gas)\n` +
            `Your balance: ${Precision.fromBaseUnits(onChainTonCheck, TON_DECIMALS)} TON\n\n` +
            `Reduce the amount or deposit more TON.`
          );
        }
      } else {
        // ATF → TON: the freshly gas-advanced wallet must cover the swap
        // message value. STON.fi's gasTon/value are authoritative; the
        // optional reserve defaults to 0 (original behavior).
        const { ton: tonNow } = await this.walletService.getBalance(walletAddress);
        const requiredTon =
          BigInt(swapParams.value.toString()) + config.swapGasReserveNano;

        if (tonNow < requiredTon) {
          throw new Error(
            `Insufficient TON for this swap.\n\n` +
            `Needed: ~${Precision.fromBaseUnits(requiredTon, TON_DECIMALS)} TON (network gas)\n` +
            `Available: ${Precision.fromBaseUnits(tonNow, TON_DECIMALS)} TON\n\n` +
            `The swap was NOT sent — your ATF is untouched. Try a smaller amount or deposit more TON.`
          );
        }
      }

      /**
       * Capture the exact on-chain balances immediately before the DEX
       * transaction. These are used later to distinguish user-owned swap
       * output from the platform gas advance.
       */
      const preSwapBalances = await this.walletService.getBalance(
        walletAddress
      );

      await Transaction.updateOne(
        { _id: tx._id },
        {
          $set: {
            'metadata.preSwapTonBalanceNano':
              preSwapBalances.ton.toString(),
            'metadata.preSwapAtfBalanceNano':
              preSwapBalances.atf.toString(),
            'metadata.swapRouterAddress': confirmation.quote?.routerAddress,
            'metadata.swapValueNano':
              BigInt(swapParams.value.toString()).toString(),
            'metadata.swapMinOutputBaseUnits': String(
              confirmation.quote?.minAskUnits || '0'
            ),
          },
        }
      );

      /**
       * BROADCAST THE ACTUAL SWAP.
       */
      const txHash = await this.walletService.sendTon(
        userId,
        swapParams.to,
        BigInt(swapParams.value.toString()),
        swapParams.body
      );

      /**
       * The swap has now actually been broadcast.
       *
       * IMPORTANT:
       *
       * Do NOT call tx.save() here.
       *
       * The in-memory `tx` document was created BEFORE
       * GasRecoveryService.recordAdvance() wrote the recovery audit fields
       * directly into the database.
       *
       * tx.save() would replace the whole metadata subdocument with this
       * stale in-memory copy, ERASING the recovery state. The recovery claim
       * (metadata.gasRecoveryStatus ∈ pending/partial/failed) would then
       * never match, and the platform's gas advance would never be
       * recovered after a successful swap.
       *
       * Use a targeted atomic update that only writes the swap result
       * fields and leaves the recovery metadata intact.
       */
      await Transaction.updateOne(
        { _id: tx._id },
        {
          $set: {
            txHash,
            status: 'processing',
            toAddress: swapParams.to,
            'metadata.swapBroadcasted': true,
            'metadata.swapOutcome': 'pending',
            'metadata.broadcastedAt': new Date().toISOString(),
          },
        }
      );

      /**
       * Keep the in-memory copy consistent for the
       * catch-path broadcasted check.
       *
       * This in-memory document is NEVER persisted again.
       */
      tx.txHash = txHash;
      tx.status = 'processing';
      tx.toAddress = swapParams.to;
      tx.metadata = {
        ...tx.metadata,
        swapBroadcasted: true,
        swapOutcome: 'pending',
      };

      /**
       * Gas recovery is intentionally NOT attempted here.
       *
       * The swap has only been broadcast at this point. The DEX may still
       * succeed, refund, or fail after the wallet transaction is consumed.
       * The reconciler now determines the real swap outcome first and then
       * invokes GasRecoveryService with the correct outcome.
       */

      /**
       * Platform swap fee.
       *
       * Existing behavior retained.
       */
      // Platform fee transfer is triggered by the reconciler only after the
      // swap outcome is confirmed. Charging/transferring a fee immediately
      // after broadcast would make a failed swap harder to unwind safely.

      return tx._id.toString();
    } catch (error) {
      /**
       * Explicit broadcast flag is authoritative.
       */
      const broadcasted = tx?.metadata?.swapBroadcasted === true;

      /* ─────────────────────────────────────────
         FAILED ATF → TON BEFORE BROADCAST
         ───────────────────────────────────────── */

      if (gasAdvanced && !broadcasted && tx) {
        try {
          const result = await this.gasRecovery.recoverAdminGasSafely({
            swapTransactionId: tx._id.toString(),
            userId,
            walletAddress,
          });

          gasClawbackTxHash = result.txHash || null;

          console.log(
            `[SwapService] Gas recovery for user ${userId} on swap ${tx._id}: ` +
              `status=${result.status}, ` +
              `recovered=${Precision.fromBaseUnits(result.totalRecoveredNano, TON_DECIMALS)} TON, ` +
              `pending=${Precision.fromBaseUnits(result.pendingNano, TON_DECIMALS)} TON` +
              (result.skippedReason ? ` (${result.skippedReason})` : '')
          );
        } catch (recoveryErr: any) {
          console.error(
            `[SwapService] Gas recovery FAILED for user ${userId}:`,
            recoveryErr
          );
        }
      }

      /* ─────────────────────────────────────────
         ROLLBACK INTERNAL BALANCE
         ───────────────────────────────────────── */

      if (deducted && !broadcasted) {
        try {
          const currentUser = await User.findById(user._id);

          if (currentUser) {
            currentUser[balanceKey] = Precision.add(
              BigInt(currentUser[balanceKey] || '0'),
              amountBase
            ).toString();

            await currentUser.save();

            console.log(
              `[SwapService] Rollback complete: restored ${Precision.fromBaseUnits(amountBase, inputDecimals)} ${
                isTonToAtf ? 'TON' : 'ATF'
              } (includes ${Precision.fromBaseUnits(feeBase, inputDecimals)} fee) to user ${userId}`
            );
          }
        } catch (rollbackErr) {
          console.error('[SwapService] Balance rollback failed:', rollbackErr);
        }
      }

      /* ─────────────────────────────────────────
         FINAL TRANSACTION UPDATE
         ───────────────────────────────────────── */

      if (tx) {
        try {
          /**
           * IMPORTANT:
           *
           * Recovery service writes directly to MongoDB.
           *
           * Therefore refetch the latest transaction before
           * saving the final swap state.
           */
          const latest = await Transaction.findById(tx._id);

          if (latest) {
            latest.status = broadcasted ? 'processing' : 'failed';

            latest.metadata = {
              ...latest.metadata,
              error: (error as Error).message,
              broadcasted,
              gasAdvanceTxId: gasAdvanceTxId || undefined,
              gasClawbackTxHash: gasClawbackTxHash || undefined,
              // FIX A: preserve the numeric counter written by
              // recordAdvance — gas-recovery-retry $inc's this field;
              // a boolean here crashes every future recovery attempt
              // for this swap (TypeMismatch, stuck gas forever).
              gasRecoveryAttempted:
                typeof latest?.metadata?.gasRecoveryAttempted === 'number'
                  ? latest.metadata.gasRecoveryAttempted
                  : 0,
              swapOutcome: broadcasted ? 'pending' : 'failed',
            };

            await latest.save();
          }
        } catch {
          // Preserve original error.
        }
      }

      throw error;
    }
  }
    /* ─────────────────────────────────────────────
     FEE TRANSFER
     ───────────────────────────────────────────── */

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
        txHash = await this.walletService.sendTon(
          userId,
          config.adminFeeWalletAddress,
          feeAmount
        );
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

      await Transaction.findByIdAndUpdate(swapTxId, {
        feeStatus: 'completed',
        feeTxHash: txHash,
      });
    } catch (error) {
      console.error('[SwapService] Fee transfer failed:', error);
    }
  }
}
