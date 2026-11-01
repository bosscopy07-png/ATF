/**
 * MultiTokenSwapService — TON → TOKEN and TOKEN → TON swaps through STON.fi.
 *
 * ISOLATION
 *  - Does not touch SwapService or any ATF method, queue, fee percentage or
 *    state. Every swap it creates is tagged metadata.swapDirection =
 *    'ton_to_token' | 'token_to_ton' (never 'ton_to_atf' / 'atf_to_ton'), and
 *    owns its own idempotency namespace (`mtswap:`).
 *  - REUSES (does not duplicate): STONFiAdapter (quotes + tx builders),
 *    FeeEngine (the only place fee percentages live), WalletService,
 *    GasRecoveryService (the one recovery implementation — retried by the
 *    existing GasRecoveryRetryJob), FeeCollectionService (the one fee
 *    collector, driven by the reconciler), WalletAssetDiscoveryService.
 *
 * HONESTY
 *  - execute() only BROADCASTS. It never reports a swap as completed. The
 *    shared reconciler observes the chain, calls evaluateOutcome() below, and
 *    is the sole authority that marks a swap completed or failed.
 *  - An uncertain broadcast is never refunded, never retried, never recovered:
 *    it stays 'processing' until the chain says what happened.
 *
 * TON ADVANCE (TOKEN → TON only — same policy as ATF → TON)
 *  - Only the SHORTFALL the wallet needs is advanced, recorded against the
 *    exact receiving wallet and this swap via GasRecoveryService.recordAdvance.
 *  - TON → TOKEN is paid from the user's own TON and is never advanced.
 */
import crypto from 'crypto';
import { Address } from '@ton/core';
import { TonClient, JettonMaster, JettonWallet } from '@ton/ton';

import { User } from '../models/User';
import { Transaction } from '../models/Transaction';
import { SwapIdempotency } from '../models/SwapIdempotency';

import { WalletService, BroadcastOutcomeUnknownError } from './wallet-service';
import { AdminWalletService } from './admin-wallet-service';
import { STONFiAdapter, SwapQuote } from './stonfi-adapter';
import { GasRecoveryService } from './gas-recovery-service';
import { TokenRegistry, TokenRef } from './token-registry';
import {
  WalletAssetDiscoveryService,
  DiscoveredJetton,
} from './wallet-asset-discovery';

import { FeeEngine, SwapFeePlan } from '../config/fees';
import { Precision } from '../utils/precision';
import { checkRateLimit } from '../utils/rate-limiter';
import { withLock, acquireLock } from '../utils/distributed-lock';
import { config, TON_DECIMALS } from '../config';

import {
  MultiTokenDirection,
  MtOutcomeVerdict,
  MtWalletTxEvidence,
  computeAdvanceNano,
  evaluateMultiTokenOutcome,
  isMultiTokenDirection,
  isUncertainBroadcastMessage,
  parseDecimalToBase,
} from './multi-token-swap-policy';

/* ─────────────────────────────────────────────
   PUBLIC TYPES
   ───────────────────────────────────────────── */

export interface MtToken {
  masterAddress: string;
  symbol: string;
  name: string;
  decimals: number;
}

/** A token the user's wallet really holds (TOKEN → TON picker). */
export interface MtHolding extends MtToken {
  balanceBase: string;
  balanceDisplay: string;
}

export interface MtFeePlanJson {
  kind: SwapFeePlan['kind'];
  feeBase: 'input' | 'output';
  platformPercent: number;
  grossInputBase: string;
  platformFeeInputBase: string;
  platformFeeOutputBase: string;
  tonOutputFeeBase: string;
  netInputBase: string;
  netOutputBase: string;
}

export interface MtConfirmation {
  confirmationId: string;
  direction: MultiTokenDirection;
  token: MtToken;
  walletAddress: string;

  /** Gross amount the user entered, input-asset base units. */
  inputBase: string;
  inputDecimals: number;
  outputDecimals: number;
  inputSymbol: string;
  outputSymbol: string;

  quote: SwapQuote;
  feePlan: MtFeePlanJson;

  /** Where the platform fee is charged, in display terms. */
  platformFee: { amountBase: string; asset: 'TON' | 'TOKEN'; symbol: string; decimals: number };
  /** TON output fee (TOKEN → TON only), nanoTON string, '0' otherwise. */
  tonOutputFeeNano: string;

  expectedOutputBase: string;
  minOutputBase: string;
  /** Output after every disclosed fee, estimated from the DEX quote. */
  netExpectedOutputBase: string;
  netMinOutputBase: string;

  /** nanoTON attached to the swap message (includes DEX gas; for TON→TOKEN includes the offered TON). */
  swapValueNano: string;
  /** nanoTON the platform will advance (TOKEN → TON shortfall), '0' if none. */
  advanceNano: string;
  /** DEX protocol fee as reported by STON.fi, nanoTON-equivalent display only. */
  dexFeeUnits: string;

  rate: string;
  createdAt: string;
  expiresAt: Date;
}

export class SwapInProgressError extends Error {
  constructor() {
    super('This swap is already being processed. Please wait for it to finish.');
    this.name = 'SwapInProgressError';
  }
}

export class QuoteExpiredError extends Error {
  constructor() {
    super('Quote expired. Please request a new quote.');
    this.name = 'QuoteExpiredError';
  }
}

export class NoRouteError extends Error {
  constructor(symbol: string) {
    super(`No swap route is available for ${symbol} right now.`);
    this.name = 'NoRouteError';
  }
}

function provisionalTxHash(): string {
  return `swap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dec(base: bigint, decimals: number): string {
  return Precision.fromBaseUnits(base, decimals);
}

/** HTTP statuses / messages from STON.fi that mean "this pair has no route". */
function looksLikeNoRoute(message: string): boolean {
  return /HTTP 400|HTTP 404|no route|route not found|pair|not found|insufficient liquidity|unsupported/i.test(
    message || ''
  );
}

/* ─────────────────────────────────────────────
   SERVICE
   ───────────────────────────────────────────── */

export class MultiTokenSwapService {
  private readonly wallets = new WalletService(undefined, 'swap');
  private readonly stonfi = new STONFiAdapter();
  private readonly gasRecovery = new GasRecoveryService();
  private readonly discovery = WalletAssetDiscoveryService.getInstance();
  private readonly tonClient = new TonClient({
    endpoint: config.tonRpcUrlSwap,
    apiKey: config.tonApiKeySwap,
  });
  private admin: AdminWalletService | null = null;

  private adminWallet(): AdminWalletService {
    if (!this.admin) this.admin = new AdminWalletService();
    return this.admin;
  }

  private slippage(): string {
    return (config.maxSlippagePercent / 100).toString();
  }

  /* ═════════════ DISCOVERY ═════════════ */

  /** TON → TOKEN: search the provider registry (name / symbol / address). */
  async searchTokens(query: string): Promise<MtToken[]> {
    const refs = await TokenRegistry.searchAll(query, 60);
    return refs.map(this.toToken);
  }

  private toToken = (t: TokenRef): MtToken => ({
    masterAddress: t.masterAddress,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
  });

  /**
   * TOKEN → TON: the Jettons the user's ACTIVE wallet really holds.
   * Positive balances only; ATF, blacklisted/suspicious and zero balances
   * are excluded. Throws on indexer failure (an outage is not "no tokens").
   */
  async listWalletTokens(userId: number): Promise<{ walletAddress: string; holdings: MtHolding[] }> {
    const walletAddress = await this.wallets.getAddress(userId);
    if (!walletAddress) throw new Error('Wallet not found');

    const found: DiscoveredJetton[] = await this.discovery.discover(walletAddress, { fresh: true });
    const excluded = new Set(TokenRegistry.excludedAddresses());

    const holdings: MtHolding[] = [];
    for (const j of found) {
      const canonical = TokenRegistry.tryNormalize(j.masterAddress);
      if (!canonical || excluded.has(canonical)) continue;
      if (j.balanceBase <= 0n) continue;
      if (j.verification === 'blacklisted' || j.verification === 'suspicious') continue;

      holdings.push({
        masterAddress: canonical,
        symbol: j.symbol,
        name: j.name,
        decimals: j.decimals,
        balanceBase: j.balanceBase.toString(),
        balanceDisplay: dec(j.balanceBase, j.decimals),
      });
    }

    holdings.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return { walletAddress, holdings };
  }

  /* ═════════════ CHAIN READS ═════════════ */

  /**
   * Strict jetton balance read. A jetton wallet that does not exist yet is a
   * genuine 0; ANY other failure throws — an RPC problem must never look like
   * an empty balance (it would corrupt outcome decisions).
   */
  async readJettonBalanceStrict(ownerAddress: string, masterAddress: string): Promise<bigint> {
    const master = this.tonClient.open(JettonMaster.create(Address.parse(masterAddress)));
    const jettonWalletAddress = await master.getWalletAddress(Address.parse(ownerAddress));

    const state = await this.tonClient.getContractState(jettonWalletAddress);
    if (state.state === 'uninitialized') return 0n;

    const jw = this.tonClient.open(JettonWallet.create(jettonWalletAddress));
    return jw.getBalance();
  }

  /* ═════════════ ROUTE CHECK ═════════════ */

  /**
   * Authoritative executable-route check: a REAL STON.fi simulation. Listing
   * in the registry is not enough, and absence from any local database is
   * never a reason to refuse.
   *
   *  'ok'        — STON.fi produced a quote for this pair.
   *  'no_route'  — STON.fi rejected the pair.
   *  'unknown'   — provider/network problem; caller must not claim either.
   */
  async checkRoute(
    direction: MultiTokenDirection,
    token: MtToken,
    probeBase?: bigint
  ): Promise<'ok' | 'no_route' | 'unknown'> {
    // A modest probe: the minimum TON swap, or a tenth of what the user holds.
    // (Probing with a huge/tiny amount can fail for reasons unrelated to routing.)
    const probeUnits =
      probeBase && probeBase > 0n
        ? probeBase
        : direction === 'ton_to_token'
          ? Precision.toBaseUnits(config.minSwapTon.toString(), TON_DECIMALS)
          : 10n ** BigInt(Math.max(0, token.decimals));
    const { offer, ask } = this.pair(direction, token.masterAddress);

    try {
      await this.stonfi.getQuote(offer, ask, probeUnits.toString(), this.slippage());
      return 'ok';
    } catch (err: any) {
      const msg = String(err?.message || err);
      // A transport-level failure is not evidence about the route.
      if (/timeout|timed out|ECONN|ENOTFOUND|socket|HTTP 5\d\d|fetch failed|network/i.test(msg)) {
        return 'unknown';
      }
      return looksLikeNoRoute(msg) ? 'no_route' : 'unknown';
    }
  }

  private pair(direction: MultiTokenDirection, master: string): { offer: string; ask: string } {
    return direction === 'ton_to_token'
      ? { offer: 'ton', ask: master }
      : { offer: master, ask: 'ton' };
  }

  /* ═════════════ PREPARE (quote) ═════════════ */

  async prepare(args: {
    userId: number;
    direction: MultiTokenDirection;
    token: MtToken;
    amount: string;
  }): Promise<MtConfirmation> {
    if (!config.features.multiTokenSwap) throw new Error('This feature is not enabled yet');
    if (!isMultiTokenDirection(args.direction)) throw new Error('Unsupported swap direction');

    const { userId, direction, token } = args;

    if (TokenRegistry.isAtf(token.masterAddress)) {
      throw new Error('ATF has its own swap screen — use the TON ⇄ ATF swap.');
    }

    // Platform fees on the OUTPUT side need the token fee path, which is not
    // available for every pair. Refuse loudly instead of silently undercharging.
    if (config.feePolicy.platformFeeBase !== 'input') {
      throw new Error(
        'Multi-token swaps currently require FEE_PLATFORM_BASE=input. Contact support.'
      );
    }

    await checkRateLimit('swap:prepare', userId, config.swapPrepareRateLimit, config.swapPrepareRateWindowMs);

    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    const inputDecimals = direction === 'ton_to_token' ? TON_DECIMALS : token.decimals;
    const outputDecimals = direction === 'ton_to_token' ? token.decimals : TON_DECIMALS;
    const inputSymbol = direction === 'ton_to_token' ? 'TON' : token.symbol;
    const outputSymbol = direction === 'ton_to_token' ? token.symbol : 'TON';

    const amountBase = parseDecimalToBase(args.amount, inputDecimals);
    if (amountBase === null) {
      throw new Error(`Invalid amount (max ${inputDecimals} decimal places for ${inputSymbol}).`);
    }
    if (amountBase <= 0n) throw new Error('Invalid amount');

    if (direction === 'ton_to_token') {
      const min = Precision.toBaseUnits(config.minSwapTon.toString(), TON_DECIMALS);
      if (amountBase < min) throw new Error(`Minimum swap amount is ${config.minSwapTon} TON`);
    }

    const walletAddress = await this.wallets.getAddress(userId);
    if (!walletAddress) throw new Error('Wallet not found');

    // ── Live balances (strict — never read a failure as zero) ──
    const liveTon = await this.wallets.getTonBalanceStrict(walletAddress);
    const liveToken =
      direction === 'token_to_ton'
        ? await this.readJettonBalanceStrict(walletAddress, token.masterAddress)
        : 0n;

    if (direction === 'token_to_ton') {
      if (liveToken <= 0n) {
        throw new Error(`You hold no ${token.symbol} in this wallet.`);
      }
      if (liveToken < amountBase) {
        throw new Error(
          `Insufficient ${token.symbol}. Balance: ${dec(liveToken, token.decimals)}, ` +
            `requested: ${dec(amountBase, token.decimals)}.`
        );
      }
    }

    // ── Fee plan via the centralized engine (input-side platform fee) ──
    const slip = this.slippage();
    const { offer, ask } = this.pair(direction, token.masterAddress);

    // 1) pre-quote on the gross amount → learn the output so FeeEngine can
    //    size the TON-output fee; 2) final quote on the NET input.
    let preQuote: SwapQuote;
    try {
      preQuote = await this.stonfi.getQuote(offer, ask, amountBase.toString(), slip);
    } catch (err: any) {
      if (looksLikeNoRoute(String(err?.message))) throw new NoRouteError(token.symbol);
      throw err;
    }

    const prePlan = FeeEngine.planSwapFees(direction, amountBase, BigInt(preQuote.askUnits));

    const quote = await this.stonfi.getQuote(offer, ask, prePlan.netInputBase.toString(), slip);
    const plan = FeeEngine.planSwapFees(direction, amountBase, BigInt(quote.askUnits));

    // The net input the DEX will see must equal the plan (no drift).
    if (plan.netInputBase !== prePlan.netInputBase) {
      throw new Error('Quote changed while preparing. Please try again.');
    }

    const txParams = await this.stonfi.buildRoutedSwapTransaction(walletAddress, quote, offer, ask);
    const swapValueNano = BigInt(txParams.value.toString());

    // ── Funding checks ──
    const feeInput = plan.platformFeeInputBase;
    const reserve = config.tonTransferFeeReserveNano + config.swapGasReserveNano;

    let advanceNano = 0n;

    if (direction === 'ton_to_token') {
      // swapValue already contains the net offered TON + DEX gas. The platform
      // fee stays in the wallet and is sent afterwards, so it must also exist.
      const needed = swapValueNano + feeInput + reserve;
      if (liveTon < needed) {
        throw new Error(
          `Insufficient TON for this swap.\n\n` +
            `Needed: ~${dec(needed, TON_DECIMALS)} TON (swap + ${dec(feeInput, TON_DECIMALS)} fee + network gas)\n` +
            `Your balance: ${dec(liveTon, TON_DECIMALS)} TON\n\n` +
            `Try a smaller amount or deposit more TON.`
        );
      }
    } else {
      const adv = computeAdvanceNano({
        direction,
        swapValueNano,
        reserveNano: reserve,
        walletTonNano: liveTon,
        maxAdvanceNano: 500_000_000n, // 0.5 TON hard ceiling per swap
      });
      if (adv.error) throw new Error(adv.error);
      advanceNano = adv.advanceNano;

      if (advanceNano > 0n) {
        const adminBalance = await this.adminBalanceOrThrow();
        if (adminBalance < advanceNano + 50_000_000n) {
          throw new Error('Platform gas treasury temporarily low. Please try again later.');
        }
      }
    }

    const expectedOut = BigInt(quote.askUnits);
    const minOut = BigInt(quote.minAskUnits);
    const outFee = plan.tonOutputFeeBase; // 0 for TON → TOKEN

    const netExpected = expectedOut - outFee > 0n ? expectedOut - outFee : 0n;
    const netMin = minOut - outFee > 0n ? minOut - outFee : 0n;

    const netInDisplay = parseFloat(dec(plan.netInputBase, inputDecimals));
    const expDisplay = parseFloat(dec(expectedOut, outputDecimals));
    const rateValue = netInDisplay > 0 ? expDisplay / netInDisplay : 0;

    return {
      confirmationId: crypto.randomUUID(),
      direction,
      token,
      walletAddress,
      inputBase: amountBase.toString(),
      inputDecimals,
      outputDecimals,
      inputSymbol,
      outputSymbol,
      quote,
      feePlan: this.planJson(plan),
      platformFee: {
        amountBase: feeInput.toString(),
        asset: direction === 'ton_to_token' ? 'TON' : 'TOKEN',
        symbol: inputSymbol,
        decimals: inputDecimals,
      },
      tonOutputFeeNano: outFee.toString(),
      expectedOutputBase: expectedOut.toString(),
      minOutputBase: minOut.toString(),
      netExpectedOutputBase: netExpected.toString(),
      netMinOutputBase: netMin.toString(),
      swapValueNano: swapValueNano.toString(),
      advanceNano: advanceNano.toString(),
      dexFeeUnits: String(quote.feeUnits || '0'),
      rate: `1 ${inputSymbol} ≈ ${rateValue.toFixed(6)} ${outputSymbol}`,
      createdAt: new Date().toISOString(),
      expiresAt: quote.expiresAt,
    };
  }

  private planJson(p: SwapFeePlan): MtFeePlanJson {
    return {
      kind: p.kind,
      feeBase: p.feeBase,
      platformPercent: p.platformPercent,
      grossInputBase: p.grossInputBase.toString(),
      platformFeeInputBase: p.platformFeeInputBase.toString(),
      platformFeeOutputBase: p.platformFeeOutputBase.toString(),
      tonOutputFeeBase: p.tonOutputFeeBase.toString(),
      netInputBase: p.netInputBase.toString(),
      netOutputBase: p.netOutputBase.toString(),
    };
  }

  private async adminBalanceOrThrow(): Promise<bigint> {
    const admin = this.adminWallet();
    await admin.initialize();
    return admin.getBalance();
  }

  /* ═════════════ EXECUTE (broadcast only) ═════════════ */

  /**
   * Broadcast a confirmed swap. Returns the swap Transaction id. The swap is
   * NOT complete when this returns — only the reconciler can say so.
   *
   * Duplicate callbacks / retries / double taps converge on one idempotency
   * row: a repeat returns the same transaction id (or SwapInProgressError);
   * it can never produce a second on-chain payment.
   */
  async execute(userId: number, c: MtConfirmation): Promise<{ transactionId: string; replay: boolean }> {
    if (!config.features.multiTokenSwap) throw new Error('This feature is not enabled yet');
    if (!c?.confirmationId || !isMultiTokenDirection(c.direction)) {
      throw new Error('Invalid or expired quote. Please request a new quote.');
    }

    await checkRateLimit('swap:execute', userId, config.swapExecuteRateLimit, config.swapExecuteRateWindowMs);

     // Execution can wait on the treasury lock + advance confirmation (~80s), so the
    // per-user lock outlives the default 30s TTL.
    return withLock(`lock:swap:${userId}`, Math.max(config.swapLockTtlMs, 180_000), async () => {
      const idemKey = `mtswap:${userId}:${c.confirmationId}`;

      const raw: any = await SwapIdempotency.findOneAndUpdate(
        { key: idemKey },
        {
          $setOnInsert: {
            key: idemKey,
            userId,
            confirmationId: c.confirmationId,
            status: 'processing',
          },
        },
        { upsert: true, new: true, rawResult: true }
      );

      if (raw?.lastErrorObject?.updatedExisting === true) {
        const existing = raw.value;
        if (existing.status === 'completed' && existing.transactionId) {
          return { transactionId: existing.transactionId, replay: true };
        }
        if (existing.status === 'processing') throw new SwapInProgressError();
        throw new Error(existing.error || 'This swap already failed. Please request a new quote.');
      }

      try {
        const transactionId = await this.executeOnce(userId, c);

        // 'completed' on the IDEMPOTENCY row means "broadcast handled exactly
        // once" — it is not a swap result. The swap stays 'processing'.
        await SwapIdempotency.updateOne(
          { key: idemKey },
          { $set: { status: 'completed', transactionId, updatedAt: new Date() } }
        );
        return { transactionId, replay: false };
      } catch (error: any) {
        await SwapIdempotency.updateOne(
          { key: idemKey },
          { $set: { status: 'failed', error: error?.message || String(error), updatedAt: new Date() } }
        );
        throw error;
      }
    });
  }

  private async executeOnce(userId: number, c: MtConfirmation): Promise<string> {
    if (new Date() > new Date(c.expiresAt)) throw new QuoteExpiredError();

    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    const token = c.token;
    const direction = c.direction;
    const inputBase = BigInt(c.inputBase);
    const plan = c.feePlan;

    // The wallet that was quoted must still be the active wallet.
    const walletAddress = await this.wallets.getAddress(userId);
    if (!walletAddress) throw new Error('Wallet not found');
    if (walletAddress !== c.walletAddress) {
      throw new Error('Your active wallet changed since the quote. Please request a new quote.');
    }

    const { offer, ask } = this.pair(direction, token.masterAddress);

    // Rebuild the swap message from the quoted route (deterministic).
    const swapParams = await this.stonfi.buildRoutedSwapTransaction(walletAddress, c.quote, offer, ask);
    const swapValue = BigInt(swapParams.value.toString());
    const quotedValue = BigInt(c.swapValueNano);
    if (swapValue > quotedValue + 20_000_000n) {
      // gas requirement rose by more than 0.02 TON since the user confirmed
      throw new Error('Network gas changed since the quote. Please request a new quote.');
    }

    // ── Live funding re-check (balance may have moved since the quote) ──
    const liveTon = await this.wallets.getTonBalanceStrict(walletAddress);
    const feeInput = BigInt(plan.platformFeeInputBase || '0');
    const reserve = config.tonTransferFeeReserveNano + config.swapGasReserveNano;

    let preTokenBase = 0n;
    if (direction === 'token_to_ton') {
      preTokenBase = await this.readJettonBalanceStrict(walletAddress, token.masterAddress);
      if (preTokenBase < inputBase) {
        throw new Error(`Insufficient ${token.symbol} — your balance changed. Reduce the amount.`);
      }
    } else {
      if (liveTon < swapValue + feeInput + reserve) {
        throw new Error('Insufficient TON for this swap (amount + fee + network gas). Reduce the amount.');
      }
      // baseline for output detection
      preTokenBase = await this.readJettonBalanceStrict(walletAddress, token.masterAddress);
    }

    let advance = 0n;
    if (direction === 'token_to_ton') {
      const adv = computeAdvanceNano({
        direction,
        swapValueNano: swapValue,
        reserveNano: reserve,
        walletTonNano: liveTon,
        maxAdvanceNano: 500_000_000n,
      });
      if (adv.error) throw new Error(adv.error);
      advance = adv.advanceNano;
    }

    // ── Record the swap BEFORE any money moves (recoverable by the reconciler) ──
    const swapTx = await Transaction.create({
      userId: user._id,
      type: 'swap',
      asset: direction === 'ton_to_token' ? 'TON' : 'TOKEN',
      amount: inputBase.toString(),
      fee: feeInput.toString(),
      feeAsset: direction === 'ton_to_token' ? 'TON' : 'TOKEN',
      feePercentage: plan.platformPercent,
      feeWallet: config.adminFeeWalletAddress,
      feeStatus: 'pending',
      status: 'processing',
      txHash: provisionalTxHash(),
      metadata: {
        multiToken: true,
        swapDirection: direction,
        tokenMaster: token.masterAddress,
        tokenSymbol: token.symbol,
        tokenName: token.name,
        tokenDecimals: token.decimals,
        walletAddress,
        feePlan: plan,
        tonOutputFee: BigInt(c.tonOutputFeeNano) > 0n ? c.tonOutputFeeNano : undefined,
        inputAmountBase: inputBase.toString(),
        quote: c.quote,
        expiresAt: c.expiresAt,
        slippage: config.maxSlippagePercent,
        minOutputBaseUnits: String(c.quote.minAskUnits || '0'),
        expectedOutputBaseUnits: String(c.quote.askUnits || '0'),
        swapValueNano: swapValue.toString(),
        swapRouterAddress: c.quote.routerAddress,
        swapOutcome: 'unknown',
        swapBroadcasted: false,
        actualOutputBaseUnits: '0',
        gasTon: swapParams.gasTon,
      },
    });
    const swapId = swapTx._id.toString();

    let gasAdvanced = false;
    let gasAdvanceTxId: string | null = null;
    let broadcastAttempted = false;

    try {
      /* ── TON advance (TOKEN → TON shortfall) ── */
      if (advance > 0n) {
        const adv = await this.advanceGas(user._id.toString(), swapId, walletAddress, advance, liveTon);
        gasAdvanced = true;
        gasAdvanceTxId = adv.auditTxId;

        const landed = await this.waitForTonAtLeast(walletAddress, liveTon + advance, 60_000);
        if (!landed) {
          throw new Error(
            'The gas top-up has not arrived yet, so the swap was NOT sent. Nothing was swapped — please try again.'
          );
        }
      }

      /* ── Pre-swap evidence baseline (strict) ── */
      const preTon = await this.wallets.getTonBalanceStrict(walletAddress);
      if (preTon < swapValue + (direction === 'token_to_ton' ? 0n : feeInput)) {
        throw new Error(
          `Insufficient TON for the swap message (needs ~${dec(swapValue, TON_DECIMALS)} TON). The swap was NOT sent.`
        );
      }

      await Transaction.updateOne(
        { _id: swapTx._id },
        {
          $set: {
            'metadata.preSwapTonBalanceNano': preTon.toString(),
            'metadata.preSwapTokenBalanceBase': preTokenBase.toString(),
            'metadata.swapMinOutputBaseUnits': String(c.quote.minAskUnits || '0'),
            // Destination of the swap message — lets the reconciler find OUR
            // wallet tx even if the broadcast reference is uncertain.
            'metadata.swapMessageTo': swapParams.to,
          },
        }
      );

      /* ── BROADCAST (the only point of no return) ── */
      broadcastAttempted = true;
      const txHash = await this.wallets.sendTonFromWalletAddress(
        walletAddress,
        swapParams.to,
        swapValue,
        swapParams.body
      );

      // Targeted update — NEVER save() (would erase recovery metadata).
      await Transaction.updateOne(
        { _id: swapTx._id },
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

      // Gas recovery and fee collection are NOT attempted here. The
      // reconciler decides the real outcome first, then drives both.
      return swapId;
    } catch (error: any) {
      const message = error?.message || String(error);
      const uncertain =
        broadcastAttempted &&
        (error instanceof BroadcastOutcomeUnknownError || isUncertainBroadcastMessage(message));

      if (uncertain) {
        // The message MAY be on-chain. No refund, no recovery, no retry:
        // park it for the reconciler with a to-address so it is picked up.
        await Transaction.updateOne(
          { _id: swapTx._id },
          {
            $set: {
              status: 'processing',
              toAddress: swapParams.to,
              'metadata.swapOutcome': 'pending',
              'metadata.broadcastUncertain': true,
              'metadata.broadcastedAt': new Date().toISOString(),
              'metadata.error': message,
            },
          }
        );
        // The caller must not be told "failed" — the swap may land.
        return swapId;
      }

      // ── Verified pre-broadcast failure: nothing was swapped ──
      await Transaction.updateOne(
        { _id: swapTx._id },
        {
          $set: {
            status: 'failed',
            // A swap that never happened owes no platform fee. Zeroing it also
            // lets the existing recovery job reclaim any advance immediately.
            fee: '0',
            feeStatus: 'failed',
            'metadata.swapOutcome': 'failed',
            'metadata.error': message,
            'metadata.failedBeforeBroadcast': true,
            'metadata.feeWaivedBase': feeInput.toString(),
            ...(gasAdvanceTxId ? { 'metadata.gasAdvanceTxId': gasAdvanceTxId } : {}),
          },
        }
      );

      if (gasAdvanced) {
        try {
          const r = await this.gasRecovery.recoverAdminGasSafely({
            swapTransactionId: swapId,
            userId,
            walletAddress,
          });
          console.log(
            `[MultiTokenSwap] pre-broadcast failure; gas recovery for swap ${swapId}: ` +
              `status=${r.status} recovered=${r.totalRecoveredNano} pending=${r.pendingNano}` +
              (r.skippedReason ? ` (${r.skippedReason})` : '')
          );
        } catch (e) {
          console.error(`[MultiTokenSwap] gas recovery failed for swap ${swapId}:`, e);
          // GasRecoveryRetryJob resumes it.
        }
      }

      throw error;
    }
  }

  /**
   * Send the platform TON advance to the EXACT wallet and record it against
   * this swap. Serialised across the platform admin wallet so two advances
   * can never race on the admin seqno.
   */
  private async advanceGas(
    userObjectId: string,
    swapId: string,
    walletAddress: string,
    advanceNano: bigint,
    preAdvanceBalanceNano: bigint
  ): Promise<{ auditTxId: string; txRef: string }> {
    let lock: { release: () => Promise<void> } | null = null;
    for (let i = 0; i < 20 && !lock; i++) {
      lock = await acquireLock('lock:admin-wallet-send', 30_000);
      if (!lock) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!lock) throw new Error('Platform gas treasury is busy. Please try again in a moment.');

    try {
      const admin = this.adminWallet();
      await admin.initialize();

      const adminBalance = await admin.getBalance();
      if (adminBalance < advanceNano + 50_000_000n) {
        throw new Error('Platform gas treasury temporarily low. Please try again later.');
      }

      const txRef = await admin.sendTon(walletAddress, advanceNano);

      const audit = await Transaction.create({
        userId: userObjectId,
        type: 'fee_transfer',
        asset: 'TON',
        amount: advanceNano.toString(),
        status: 'completed',
        toAddress: walletAddress,
        txHash: txRef,
        metadata: {
          purpose: 'gas_advance',
          description: 'Gas TON advanced by admin for multi-token TOKEN→TON swap',
          fromAdmin: true,
          swapTxId: swapId,
          walletAddress,
        },
      });

      // Recorded IMMEDIATELY after the send, against the exact receiving
      // wallet + this swap: even if verification below times out, the
      // obligation exists and the existing retry job recovers whatever lands.
      await this.gasRecovery.recordAdvance({
        swapTransactionId: swapId,
        walletAddress,
        tonBalanceBeforeGasAdvanceNano: preAdvanceBalanceNano,
        gasAdvanceAmountNano: advanceNano,
        gasAdvanceTxHash: txRef,
      });

      return { auditTxId: audit._id.toString(), txRef };
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  private async waitForTonAtLeast(address: string, target: bigint, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // accept 98% of target — storage fees / rounding on the wallet
    const threshold = (target * 98n) / 100n;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        if ((await this.wallets.getTonBalanceStrict(address)) >= threshold) return true;
      } catch {
        // RPC hiccup — keep polling
      }
    }
    return false;
  }

  /** Hand one swap to the shared reconciler (lazy import: no load-time cycle). */
  protected async reconcileNow(swapId: string): Promise<void> {
    const { reconcileMultiTokenSwapNow } = await import('../jobs/reconciler');
    await reconcileMultiTokenSwapNow(swapId);
  }

  /* ═════ FAST SETTLEMENT (screen + background) ═════ */

  /**
   * Watch a broadcast swap until the chain decides it, polling every 2s
   * instead of waiting for the 10s reconciler tick. The moment the evidence
   * is definitive it hands the swap to the SAME reconciler code path, which
   * persists the outcome and then collects the fee and reclaims the TON
   * advance. Nothing is marked complete here — status only ever changes in
   * the reconciler; this just reads it back.
   */
  async settle(
    swapId: string,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<{ status: 'completed' | 'failed' | 'pending'; tx: any }> {
    const timeoutMs = opts.timeoutMs ?? 45_000;
    const pollMs = opts.pollMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    let handingOver = false;

    for (;;) {
      const tx: any = await Transaction.findById(swapId);
      if (tx?.status === 'completed') return { status: 'completed', tx };
      if (tx?.status === 'failed') return { status: 'failed', tx };
      if (!tx || Date.now() >= deadline) return { status: 'pending', tx };

      if (!handingOver) {
        try {
          const v = await this.evaluateOutcome(tx);
          if (v.status !== 'pending') {
            handingOver = true;
            // Not awaited: the reconciler also collects the fee and reclaims the
            // advance after the swap itself is final. Status flips at commit and
            // the next poll picks it up.
            this.reconcileNow(swapId)
              .catch((err: any) => console.error(`[MultiTokenSwap] fast reconcile ${swapId}:`, err))
              .finally(() => { handingOver = false; });
          }
        } catch (err: any) {
          // evidence unreadable — keep polling; never a verdict
          console.warn(`[MultiTokenSwap] settle ${swapId}: evidence read failed (${err?.message || err})`);
        }
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /* ═════════════ OUTCOME EVIDENCE (called by the reconciler) ═════════════ */

  /**
   * Read the chain and decide what a multi-token swap did. Pure decision
   * logic lives in multi-token-swap-policy; this only gathers evidence.
   * Never marks anything itself — the reconciler persists the verdict.
   */
  async evaluateOutcome(swap: {
    txHash?: string;
    toAddress?: string;
    createdAt?: Date | string;
    metadata?: Record<string, any>;
  }): Promise<MtOutcomeVerdict & { tokenDeltaBase?: string; tonDeltaNano?: string }> {
    const meta = (swap.metadata || {}) as Record<string, any>;
    const direction = meta.swapDirection as MultiTokenDirection;
    const walletAddress = String(meta.walletAddress || '');
    const tokenMaster = String(meta.tokenMaster || '');

    if (!isMultiTokenDirection(direction) || !walletAddress || !tokenMaster) {
      return { status: 'pending', actualOutputBase: 0n, method: 'missing_metadata' };
    }

    const broadcastMs = meta.broadcastedAt ? Date.parse(String(meta.broadcastedAt)) : NaN;
    const startMs = Number.isFinite(broadcastMs)
      ? broadcastMs
      : new Date(swap.createdAt as any).getTime();
    const ageMs = Math.max(0, Date.now() - startMs);

    let nowToken: bigint | null = null;
    try {
      nowToken = await this.readJettonBalanceStrict(walletAddress, tokenMaster);
    } catch {
      nowToken = null; // unreadable → the policy returns 'pending'
    }

    const tx = await this.findWalletTx(
      walletAddress,
      swap.txHash,
      String(swap.toAddress || meta.swapMessageTo || ''),
      Math.floor((startMs - 120_000) / 1000)
    );

    const verdict = evaluateMultiTokenOutcome({
      direction,
      ageMs,
      broadcastUncertain: meta.broadcastUncertain === true,
      tx,
      minOutputBase: BigInt(meta.minOutputBaseUnits || meta.swapMinOutputBaseUnits || '0'),
      preTokenBase: BigInt(meta.preSwapTokenBalanceBase || '0'),
      nowTokenBase: nowToken,
      expectedTokenInBase: BigInt(meta.quote?.offerUnits || '0'),
    });

    const preTok = BigInt(meta.preSwapTokenBalanceBase || '0');
    return {
      ...verdict,
      tokenDeltaBase:
        nowToken === null ? undefined : (nowToken >= preTok ? nowToken - preTok : -(preTok - nowToken)).toString(),
    };
  }

  /**
   * Find the wallet transaction that carried our swap message.
   * Real hash → match by hash. Otherwise (uncertain broadcast / tracking
   * reference) → match by an outbound message to the router since broadcast.
   */
  private async findWalletTx(
    walletAddress: string,
    txHash: string | undefined,
    routerOrTo: string,
    sinceUtime: number
  ): Promise<MtWalletTxEvidence> {
    let txs: any[];
    try {
      txs = await this.tonClient.getTransactions(Address.parse(walletAddress), { limit: 40 });
    } catch {
      return { state: 'unreadable' };
    }

    const isExternalIn = (t: any): boolean => t?.inMessage?.info?.type === 'external-in';

    const hasRealHash = !!txHash && /^[0-9a-f]{64}$/i.test(txHash);
    let target: any | undefined;

    // The hash returned by the wallet service can, under indexing lag, belong
    // to an UNRELATED wallet tx (e.g. the incoming gas advance). Only OUR
    // external-in wallet tx counts as evidence; otherwise fall back to
    // matching the outbound message to the router.
    if (hasRealHash) {
      const byHash = txs.find((t) => t.hash().toString('hex') === txHash);
      if (byHash && isExternalIn(byHash)) target = byHash;
    }

    if (!target && routerOrTo) {
      let dest: string | null = null;
      try {
        dest = Address.parse(routerOrTo).toString({ bounceable: false });
      } catch {
        dest = null;
      }
      if (dest) {
        target = txs.find((t) => {
          if (!isExternalIn(t)) return false;
          if ((t.now ?? 0) < sinceUtime) return false;
          const outs: any[] = Array.from((t.outMessages as any)?.values?.() ?? []);
          return outs.some((m) => {
            try {
              return m?.info?.dest && m.info.dest.toString({ bounceable: false }) === dest;
            } catch {
              return false;
            }
          });
        });
      }
    }

    if (!target) return { state: 'not_found' };

    const desc: any = target.description;
    const failed =
      !!desc?.aborted ||
      desc?.computePhase?.success === false ||
      desc?.actionPhase?.success === false ||
      !!(target.inMessage && 'bounced' in target.inMessage && (target.inMessage as any).bounced);

    const om: any = target.outMessages;
    const outMessages =
      om && typeof om.size === 'number' ? om.size : om && typeof om.length === 'number' ? om.length : null;

    return { state: 'found', failed, outMessages };
  }
}

      
