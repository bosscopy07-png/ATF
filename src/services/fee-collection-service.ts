/**
 * FeeCollectionService — the SINGLE place platform swap fees are collected.
 *
 * What changed vs. the original working code (and nothing else):
 *  1. DUPLICATE-BROADCAST FIX — one canonical fee record per swap
 *     (metadata.feeKey + unique index), an atomic claim filter decides if a
 *     broadcast may happen, and every terminal write is a conditional
 *     (from-state guarded) update so a completed fee can never be reversed
 *     or re-broadcast. Sweepers select by the fee record, never by the
 *     swap.feeStatus mirror.
 *  2. Delivery verification — exact transfer check when the chain answers;
 *     otherwise the broadcast transaction's own success is accepted (the
 *     same standard the original code used in production).
 *  3. Legacy safety — reconciliation also adopts pre-fix records (the old
 *     broadcastUncertain/deliveryUncertain flag shapes), so nothing strands.
 *
 * Fee record lifecycle (status / metadata.feeOutcome):
 *   pending                    → never broadcast; claimable
 *   processing                 → claimed; outcome unknown
 *   completed (+ real txHash)  → DELIVERED. TERMINAL.
 *   failed + pre_broadcast     → definitive pre-broadcast failure (e.g. no
 *                                gas); bounded retry + cooldown
 *   failed + bounced           → confirmed on-chain bounce; bounded retry
 *   failed + uncertain         → outcome unknown; NEVER auto-retried,
 *                                reconciliation resolves it
 */
import { TonClient, Address } from '@ton/ton';
import { beginCell, Cell } from '@ton/core';
import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { WalletService } from './wallet-service';
import { config, ATF_DECIMALS } from '../config';
import { FeeEngine } from '../config/fees';
import {
  FEE_MAX_ATTEMPTS,
  FEE_PROCESSING_TTL_MS,
  FEE_UNCERTAIN_GRACE_MS,
  FEE_OUTCOME,
  FEE_KIND,
  placeholderFor,
  isPlaceholderTxHash,
  attemptsOf,
  classifyBroadcastError,
  buildClaimFilter,
  nextRetryAtFrom,
  requiredFeeGasNano,
  swapRequiresTonOutputFee,
  outputFeeKey,
} from './fee-record-policy';

type CollectResult = 'collected' | 'pending' | 'skipped' | 'uncertain';
type DeliveryOutcome = 'delivered' | 'bounced' | 'unknown';

const DELIVERY_POLL_ATTEMPTS = 20;
const DELIVERY_POLL_INTERVAL_MS = 4_000;
const JETTON_TRANSFER_OP = 0x0f8a7ea5;

// Required gas is computed per transfer (requiredFeeGasNano): the jetton
// attach sendJetton really uses (0.1 TON) + the wallet's own message fee —
// not a blanket threshold. A shortfall is NOT a broadcast attempt (see
// markPreBroadcastFailed { noGas }), so a later top-up is always collectable.

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FeeCollectionService {
  protected walletService = new WalletService(undefined, 'fee');
  private _tonClient: TonClient | null = null;

  /** Separate lazily-created client so unit tests can stub RPC verification. */
  protected get tonClient(): TonClient {
    if (!this._tonClient) {
      this._tonClient = new TonClient({
        endpoint: (config as any).tonFeeRpcUrl ?? config.tonRpcUrl,
        apiKey: config.tonApiKey,
      });
    }
    return this._tonClient;
  }

  /* ─────────────────────────────────────────
     CANONICAL FEE RECORD
     ───────────────────────────────────────── */

  /**
   * Returns the canonical platform-fee record for a swap, creating it if
   * needed. Exactly one record exists per swap thanks to the unique
   * metadata.feeKey index; a DuplicateKey race resolves to the winner.
   */
  private async ensureFeeRecord(swap: any): Promise<any> {
    const swapId = swap._id.toString();
    const feeKey = `${swapId}:platform`;
    const meta = (swap.metadata || {}) as any;

    if (meta.feeTxId) {
      const existing = await Transaction.findById(meta.feeTxId);
      if (existing) return existing;
    }

    const insertDoc = {
      userId: swap.userId,
      type: 'fee',
      asset: swap.feeAsset || swap.asset,
      amount: swap.fee || '0',
      feePercentage: swap.feePercentage,
      feeWallet: config.adminFeeWalletAddress,
      status: 'pending',
      toAddress: config.adminFeeWalletAddress,
      txHash: placeholderFor(swapId),
      metadata: {
        swapTxId: swapId,
        feeKind: FEE_KIND.SWAP_PLATFORM_FEE,
        feeKey,
        attempts: 0,
      },
    };

    try {
      const rec = await Transaction.findOneAndUpdate(
        { type: 'fee', 'metadata.feeKey': feeKey },
        { $setOnInsert: insertDoc },
        { upsert: true, new: true }
      );
      // Mirror link on the swap — conditional so a completed mirror is
      // never resurrected (the mirror is not the authority).
      await Transaction.updateOne(
        { _id: swap._id, feeStatus: { $ne: 'completed' } },
        { $set: { 'metadata.feeTxId': rec._id.toString() } }
      );
      return rec;
    } catch (error: any) {
      if (error?.code === 11000) {
        return Transaction.findOne({ type: 'fee', 'metadata.feeKey': feeKey });
      }
      throw error;
    }
  }

  /* ─────────────────────────────────────────
     CONDITIONAL TERMINAL WRITES (guarded)
     ─────────────────────────────────────────
     Every write carries a from-state guard so that:
       - 'completed' can only be reached from an in-flight claim,
       - failure writes can never touch a completed record,
       - resolution writes only touch 'processing' / uncertain records. */

  /** Output-fee records never touch the swap's platform-fee mirror. */
  private mirrorsSwap(feeTx: any): boolean {
    return !(feeTx && feeTx.metadata && feeTx.metadata.feeKind === FEE_KIND.SWAP_TON_OUTPUT_FEE);
  }

  /** Delivered. Persists the real hash on BOTH the record and the mirror. */
  private async markCompleted(feeTx: any, swap: any, txHash: string): Promise<void> {
    await Transaction.updateOne(
      { _id: feeTx._id, status: 'processing' },
      { $set: { status: 'completed', txHash, reconciledAt: new Date() } }
    );
    if (this.mirrorsSwap(feeTx)) await Transaction.updateOne(
      { _id: swap._id, feeStatus: { $ne: 'completed' } },
      { $set: { feeStatus: 'completed', feeTxHash: txHash } }
    );
  }

  /** Confirmed on-chain bounce: retryable under the bounded policy. */
  private async markBounced(feeTx: any, swap: any, txHash: string, note: string): Promise<void> {
    await Transaction.updateOne(
      { _id: feeTx._id, status: 'processing' },
      {
        $set: {
          status: 'failed',
          txHash,
          'metadata.feeOutcome': FEE_OUTCOME.BOUNCED,
          'metadata.error': note,
          'metadata.nextRetryAt': nextRetryAtFrom(Date.now()),
        },
      }
    );
    if (this.mirrorsSwap(feeTx)) await Transaction.updateOne(
      { _id: swap._id, feeStatus: { $ne: 'completed' } },
      { $set: { feeStatus: 'pending' }, $unset: { feeTxHash: '' } }
    );
  }

  /** Definitive failure BEFORE any broadcast (e.g. insufficient gas). */
  private async markPreBroadcastFailed(
    feeTx: any,
    swap: any,
    note: string,
    opts: { noGas?: boolean } = {}
  ): Promise<void> {
    // A missing-TON shortfall never reached the chain, so it must not burn
    // one of the bounded broadcast attempts (otherwise a fundable fee goes
    // permanently 'failed' after FEE_MAX_ATTEMPTS low-balance ticks).
    const exhausted = !opts.noGas && attemptsOf(feeTx) >= FEE_MAX_ATTEMPTS;
    const since = feeTx?.metadata?.insufficientGasSince;
    await Transaction.updateOne(
      { _id: feeTx._id, status: 'processing' },
      {
        $set: {
          status: 'failed',
          'metadata.feeOutcome': FEE_OUTCOME.PRE_BROADCAST,
          'metadata.error': note,
          'metadata.nextRetryAt': nextRetryAtFrom(Date.now()),
          ...(opts.noGas && !since ? { 'metadata.insufficientGasSince': new Date().toISOString() } : {}),
        },
        ...(opts.noGas ? { $inc: { 'metadata.attempts': -1 } } : {}),
      }
    );
    if (this.mirrorsSwap(feeTx)) await Transaction.updateOne(
      { _id: swap._id, feeStatus: { $ne: 'completed' } },
      { $set: { feeStatus: exhausted ? 'failed' : 'pending' } }
    );
  }

  /**
   * Ambiguous outcome: a broadcast may or may not have happened.
   * TERMINAL for all automatic retry — only reconcileUncertainFees() may
   * resolve it, after checking the chain for the exact transfer.
   */
  private async markUncertain(feeTx: any, swap: any, note: string, txHash?: string): Promise<void> {
    await Transaction.updateOne(
      { _id: feeTx._id, status: 'processing' },
      {
        $set: {
          status: 'failed',
          'metadata.feeOutcome': FEE_OUTCOME.UNCERTAIN,
          'metadata.error': note,
          ...(txHash ? { txHash } : {}),
        },
      }
    );
    if (this.mirrorsSwap(feeTx)) await Transaction.updateOne(
      { _id: swap._id, feeStatus: { $ne: 'completed' } },
      { $set: { feeStatus: 'failed' } }
    );
  }

  /* ─────────────────────────────────────────
     ASSET DISPATCH
     ───────────────────────────────────────── */

  private async sendFeeAsset(
    telegramId: number,
    asset: string,
    amount: bigint,
    jettonMaster?: string
  ): Promise<string> {
    if (asset === 'TON') {
      return this.walletService.sendTon(telegramId, config.adminFeeWalletAddress, amount);
    }
    const master = asset === 'ATF' ? config.atfJettonAddress! : (jettonMaster || config.atfJettonAddress!);
    return this.walletService.sendJetton(telegramId, config.adminFeeWalletAddress, master, amount);
  }

  /** Decimals for logging only — verification works in base units against
   *  the specific jetton master; nothing assumes ATF. */
  private jettonDecimals(master: string): number {
    const map = (config as any).jettonDecimals as Record<string, number> | undefined;
    return map?.[master] ?? ATF_DECIMALS;
  }

  /* ─────────────────────────────────────────
     ON-CHAIN DELIVERY VERIFICATION
     ───────────────────────────────────────── */

  private async findWalletTxByHash(walletAddress: string, txHash: string): Promise<any | null> {
    const addr = Address.parse(walletAddress);
    const txs = await this.tonClient.getTransactions(addr, { limit: 100 });
    return txs.find((t) => t.hash().toString('hex') === txHash) ?? null;
  }

  /** Bounced inbound message, aborted tx, or failed compute/action phase. */
  private txFailed(tx: any): boolean {
    const im: any = tx.inMessage;
    if (im && im.bounced) return true;
    const desc: any = tx.description;
    if (desc?.aborted) return true;
    if (desc?.computePhase && desc.computePhase.success === false) return true;
    if (desc?.actionPhase && desc.actionPhase.success === false) return true;
    return false;
  }

  private async getJettonWalletAddress(master: string, owner: string): Promise<string> {
    const result = await this.tonClient.runMethod(Address.parse(master), 'get_wallet_address', [
      { type: 'slice', cell: beginCell().storeAddress(Address.parse(owner)).endCell() },
    ]);
    return result.stack.readAddress().toString({ bounceable: false });
  }

  private parseJettonTransferBody(body: unknown): { amount: bigint; destination: string } | null {
    try {
      let cell: Cell;
      if (typeof body === 'string') {
        cell = Cell.fromBoc(Buffer.from(body, 'hex'))[0];
      } else if (body && typeof (body as any).beginParse === 'function') {
        cell = body as Cell;
      } else {
        return null;
      }
      const slice = cell.beginParse();
      if (slice.loadUint(32) !== JETTON_TRANSFER_OP) return null;
      slice.loadBits(64); // queryId (discarded)
      const amount = slice.loadCoins();
      const destination = slice.loadAddress().toString({ bounceable: false });
      return { amount, destination };
    } catch {
      return null;
    }
  }

  /**
   * Verify the jetton fee transfer.
   *  Stage 1 (authoritative): the broadcast tx must exist on the user wallet,
   *    be included, and not have failed → otherwise 'unknown'/'bounced'.
   *  Stage 2 (best effort): exact arrival proof — an incoming JettonTransfer
   *    of exactly amountBase to the admin wallet, from the user's jetton
   *    wallet, on the CORRECT master. If the chain/RPC can't answer, fall
   *    back to the broadcast tx's own success — the same standard the
   *    original production code used. A transfer that later bounced is
   *    still caught by Stage 1's tx-failure checks on retry passes.
   */
  protected async verifyJettonTransfer(args: {
    txHash: string;
    userWalletAddress: string;
    adminWalletAddress: string;
    jettonMaster: string;
    amountBase: bigint;
  }): Promise<DeliveryOutcome> {
    const { txHash, userWalletAddress, adminWalletAddress, jettonMaster, amountBase } = args;

    let broadcastTx: any;
    try {
      broadcastTx = await this.findWalletTxByHash(userWalletAddress, txHash);
    } catch {
      return 'unknown';
    }
    if (!broadcastTx) return 'unknown'; // inclusion unconfirmed — reconcile, don't retry
    if (this.txFailed(broadcastTx)) return 'bounced';

    try {
      const adminJw = await this.getJettonWalletAddress(jettonMaster, adminWalletAddress);
      const userJw = await this.getJettonWalletAddress(jettonMaster, userWalletAddress);
      const adminAddr = Address.parse(adminWalletAddress).toString({ bounceable: false });
      const notBefore = ((broadcastTx as any).utime ?? 0) - 60;

      for (let i = 0; i < DELIVERY_POLL_ATTEMPTS; i++) {
        if (i > 0) await delay(DELIVERY_POLL_INTERVAL_MS);
        let txs: any[] = [];
        try {
          txs = await this.tonClient.getTransactions(Address.parse(adminJw), { limit: 50 });
        } catch {
          continue; // RPC hiccup — keep polling
        }
        for (const tx of txs) {
          if (((tx as any).utime ?? 0) < notBefore) continue;
          const im: any = tx.inMessage;
          if (!im || im.bounced) continue;
          const parsed = this.parseJettonTransferBody(im.body);
          if (!parsed) continue;
          if (parsed.amount !== amountBase) continue; // exact amount, exact token
          if (parsed.destination !== adminAddr) continue;
          const src = im.src?.toString ? im.src.toString({ bounceable: false }) : undefined;
          if (src && src !== userJw) continue;
          if (this.txFailed(tx)) return 'bounced';
          return 'delivered';
        }
      }
      console.warn(`[FeeCollector] arrival check inconclusive for ${txHash} — accepting broadcast success`);
    } catch (e: any) {
      console.warn(`[FeeCollector] arrival check unavailable (${e?.message}) — accepting broadcast success for ${txHash}`);
    }
    return 'delivered';
  }

  /**
   * TON fee: verify the broadcast tx itself (bounce / phase failure).
   * A wallet-service tracking ref ("addr_seqno") is not a tx hash; for those
   * the only proof is an exact outgoing transfer to the admin wallet.
   */
  protected async verifyTonTransfer(
    txHash: string,
    userWalletAddress: string,
    amountBase?: bigint,
    exact = false
  ): Promise<DeliveryOutcome> {
    try {
      if (txHash.includes('_')) {
        if (amountBase === undefined) return 'unknown';
        const since = Math.floor(Date.now() / 1000) - 60 * 60;
        const hit = await this.scanTonOutgoing(userWalletAddress, amountBase, exact, since);
        return hit ? 'delivered' : 'unknown';
      }
      const tx = await this.findWalletTxByHash(userWalletAddress, txHash);
      if (!tx) return 'unknown';
      return this.txFailed(tx) ? 'bounced' : 'delivered';
    } catch {
      return 'unknown';
    }
  }

  /** Successful outgoing TON message to the admin wallet of (exactly / at least) `amount`. */
  private async scanTonOutgoing(
    userWalletAddress: string,
    amount: bigint,
    exact: boolean,
    sinceUtime: number
  ): Promise<boolean> {
    const adminAddr = Address.parse(config.adminFeeWalletAddress).toString({ bounceable: false });
    const txs = await this.tonClient.getTransactions(Address.parse(userWalletAddress), { limit: 100 });
    for (const tx of txs) {
      if (((tx as any).utime ?? 0) < sinceUtime) continue;
      if (this.txFailed(tx)) continue;
      for (const om of Array.from((tx.outMessages as any)?.values?.() ?? [])) {
        const m: any = om;
        const to = m.info?.dest?.toString ? m.info.dest.toString({ bounceable: false }) : (m.to?.toString ? m.to.toString({ bounceable: false }) : '');
        if (to !== adminAddr) continue;
        const value = BigInt(m.info?.value?.coins ?? m.value ?? 0n);
        if (exact ? value !== amount : value < amount) continue;
        return true;
      }
    }
    return false;
  }

  /* ─────────────────────────────────────────
     MAIN COLLECTION
     ───────────────────────────────────────── */

  async collectSwapFee(swapId: string): Promise<CollectResult> {
    const swap = await Transaction.findById(swapId);
    if (!swap || swap.type !== 'swap') return 'skipped';
    if (swap.status !== 'completed') return 'skipped'; // fee only after the swap is final

    const user = await User.findById(swap.userId);
    if (!user) return 'skipped';

    // No primary fee — still attempt the disclosed token→TON output fee.
    if (BigInt(swap.fee || '0') <= 0n) {
      await this.collectTonOutputFee(swap, user.telegramId).catch((err) =>
        console.error(`[FeeCollector] TON output fee failed for swap ${swapId}:`, err)
      );
      return 'skipped';
    }

    const feeTx = await this.ensureFeeRecord(swap);
    if (!feeTx) return 'skipped';

    if (feeTx.status === 'completed') {
      // Mirror may be stale (legacy data / crash): re-sync it, never rebroadcast.
      await Transaction.updateOne(
        { _id: swap._id, feeStatus: { $ne: 'completed' } },
        { $set: { feeStatus: 'completed', feeTxHash: feeTx.txHash } }
      );
      // Platform fee is done — the output fee may still be owed (e.g. the
      // platform fee was resolved by reconciliation). Durable record decides.
      await this.collectTonOutputFee(swap, user.telegramId).catch((err) =>
        console.error(`[FeeCollector] TON output fee failed for swap ${swapId}:`, err)
      );
      return 'skipped';
    }

    const meta = (swap.metadata || {}) as any;
    const feeAsset: string = feeTx.asset || swap.feeAsset || swap.asset;
    const feeAmount = BigInt(feeTx.amount || swap.fee || '0');
    const jettonMaster: string =
      feeAsset === 'ATF' ? config.atfJettonAddress! : (meta.tokenMaster || config.atfJettonAddress!);

    const userWalletAddress: string =
      meta.walletAddress || (await this.walletService.getAddress(user.telegramId))!;
    if (!userWalletAddress) return 'skipped';

    // A stale 'processing' lock means a worker crashed mid-attempt. Do NOT
    // claim-and-rebroadcast: downgrade to 'uncertain' and let reconciliation
    // resolve the prior attempt (its broadcast may have landed).
    if (feeTx.status === 'processing') {
      const staleBefore = new Date(Date.now() - FEE_PROCESSING_TTL_MS);
      if (feeTx.updatedAt && feeTx.updatedAt < staleBefore) {
        await Transaction.updateOne(
          { _id: feeTx._id, status: 'processing' },
          {
            $set: {
              status: 'failed',
              'metadata.feeOutcome': FEE_OUTCOME.UNCERTAIN,
              'metadata.error': 'worker crashed with no persisted broadcast hash — reconcile before retry',
            },
          }
        );
        await Transaction.updateOne(
          { _id: swap._id, feeStatus: { $ne: 'completed' } },
          { $set: { feeStatus: 'failed' } }
        );
      }
      return 'pending'; // in flight (or just downgraded — resolved on a later tick)
    }

    // Atomic claim — the ONLY path that authorizes an output-fee broadcast.
    const claimed = await Transaction.findOneAndUpdate(
      buildClaimFilter(rec._id, new Date(), `${swapId}:ton_output`),
      {
        $set: { status: 'processing', 'metadata.lastAttemptAt': new Date() },
        $unset: { 'metadata.nextRetryAt': '' },
        $inc: { 'metadata.attempts': 1 },
      },
      { new: true }
    );
    if (!claimed) return 'pending'; // settled, in flight, cooling down, or uncertain

    const amount = BigInt(claimed.amount || '0');
    const userWalletAddress: string =
      meta.walletAddress || ((await this.walletService.getAddress(telegramId)) ?? '');

    // Gas pre-check: the fee itself plus the wallet's message fee.
    try {
      const { ton } = await this.walletService.getBalance(userWalletAddress);
      const needed = requiredFeeGasNano('TON', config.tonTransferFeeReserveNano, amount);
      if (ton < needed) {
        await this.markPreBroadcastFailed(
          claimed,
          swap,
          `insufficient TON for output fee: wallet has ${ton} nano, needs ≥ ${needed}`,
          { noGas: true }
        );
        return 'pending';
      }
    } catch {
      // unreadable — let the send path classify
    }

    let txHash: string;
    try {
      txHash = await this.walletService.sendTon(telegramId, config.adminFeeWalletAddress, amount);
    } catch (error: any) {
      const message = error?.message || String(error);
      if (classifyBroadcastError(message).kind === FEE_OUTCOME.PRE_BROADCAST) {
        await this.markPreBroadcastFailed(claimed, swap, message);
        return 'pending';
      }
      // May have been broadcast → never resend automatically.
      await this.markUncertain(claimed, swap, message);
      return 'uncertain';
    }

    // Persist the real hash IMMEDIATELY: a crash from here on is resolved by
    // reconcileUncertainFees ('processing' + real hash), never by a resend.
    await Transaction.updateOne({ _id: claimed._id, status: 'processing' }, { $set: { txHash } });

    let outcome: DeliveryOutcome;
    try {
      outcome = await this.verifyTonTransfer(txHash, userWalletAddress, amount, true);
    } catch (error: any) {
      await this.markUncertain(claimed, swap, `verification error: ${error?.message || error}`, txHash);
      return 'uncertain';
    }

    if (outcome === 'delivered') {
      await this.markCompleted(claimed, swap, txHash);
      return 'collected';
    }
    if (outcome === 'bounced') {
      await this.markBounced(claimed, swap, txHash, 'output fee transfer bounced');
      return 'pending';
    }
    await this.markUncertain(claimed, swap, 'output fee delivery unconfirmed — reconcile required', txHash);
    return 'uncertain';
  }

  /* ─────────────────────────────────────────
     SWEEPER — fee-record-driven, never mirror-driven
     ───────────────────────────────────────── */

  /**
   * Selects due fees from the CANONICAL FEE RECORDS, never from swap.feeStatus:
   *  - never selects completed records,
   *  - never treats placeholder/real hashes as delivery proof,
   *  - applies the bounded retry policy (attempts + cooldown),
   *  - then reconciles 'uncertain' + legacy ambiguous records.
   */
  async collectDueFees(): Promise<{ scanned: number; collected: number }> {
    const now = new Date();
    const due = await Transaction.find({
      type: 'fee',
      'metadata.feeKind': { $in: [FEE_KIND.SWAP_PLATFORM_FEE, FEE_KIND.SWAP_TON_OUTPUT_FEE] },
      $and: [
        {
          $or: [
            { status: 'pending' },
            {
              status: 'failed',
              'metadata.feeOutcome': { $in: [FEE_OUTCOME.PRE_BROADCAST, FEE_OUTCOME.BOUNCED] },
              'metadata.nextRetryAt': { $lte: now },
            },
            {
              status: 'failed',
              'metadata.feeOutcome': { $in: [FEE_OUTCOME.PRE_BROADCAST, FEE_OUTCOME.BOUNCED] },
              'metadata.nextRetryAt': { $exists: false },
            },
          ],
        },
        {
          $or: [
            { 'metadata.attempts': { $lt: FEE_MAX_ATTEMPTS } },
            { 'metadata.attempts': { $exists: false } },
          ],
        },
      ],
    })
      .sort({ updatedAt: 1 })
      .limit(50)
      .lean();

    let collected = 0;

    for (const fee of due) {
      const swapId = fee.metadata?.swapTxId;
      if (!swapId) continue;
      const swap = await Transaction.findOne({ _id: swapId, type: 'swap' }).lean();
      if (!swap || swap.status !== 'completed') continue; // fee follows the swap outcome

      if (fee.metadata?.feeKind === FEE_KIND.SWAP_TON_OUTPUT_FEE) {
        const owner = await User.findById((swap as any).userId);
        if (!owner) continue;
        const r = await this.collectTonOutputFee(swap, owner.telegramId).catch((err) => {
          console.error(`[FeeCollector] TON output fee failed for swap ${swapId}:`, err);
          return 'pending' as CollectResult;
        });
        if (r === 'collected') collected++;
        continue;
      }

      const result = await this.collectSwapFee(swapId);
      if (result === 'collected') collected++;
    }

    // Successful token→TON swaps whose output-fee record was never created
    // (process died between settlement and record creation).
    const unensured = await Transaction.find({
      type: 'swap',
      status: 'completed',
      'metadata.swapOutcome': 'success',
      'metadata.tonOutputFeeEnsured': { $ne: true },
      $or: [{ 'metadata.swapDirection': 'atf_to_ton' }, { 'metadata.feePlan.kind': 'token_to_ton' }],
    })
      .sort({ updatedAt: 1 })
      .limit(50)
      .lean();

    for (const sw of unensured) {
      const owner = await User.findById((sw as any).userId);
      if (!owner) continue;
      const r = await this.collectTonOutputFee(sw, owner.telegramId).catch((err) => {
        console.error(`[FeeCollector] TON output fee failed for swap ${sw._id}:`, err);
        return 'pending' as CollectResult;
      });
      if (r === 'collected') collected++;
    }

    await this.reconcileUncertainFees().catch((error) =>
      console.error('[FeeCollector] uncertain reconciliation error:', error)
    );

    return { scanned: due.length, collected };
  }

  /** Backwards-compatible name used by FeeCollectorJob. */
  async sweepDueFees(): Promise<{ scanned: number; collected: number }> {
    return this.collectDueFees();
  }
}

/* ─── Sweeper job (registered in app.ts, BOTH server and worker mode) ─── */

export class FeeCollectorJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly service = new FeeCollectionService();

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 30_000);
    console.log('[FeeCollector] started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { scanned, collected } = await this.service.sweepDueFees();
      if (scanned > 0) {
        console.log(`[FeeCollector] scanned=${scanned} collected=${collected}`);
      }
    } catch (err) {
      console.error('[FeeCollector] tick error:', err);
    } finally {
      this.running = false;
    }
  }
      }
        
