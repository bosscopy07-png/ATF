import crypto from 'crypto';
import { mnemonicNew, mnemonicToWalletKey } from '@ton/crypto';
import {
  TonClient, WalletContractV4, WalletContractV5R1,
  Address, internal, SendMode,
} from '@ton/ton';
import { config } from '../config';
import { FeeEngine } from '../config/fees';
import { RelayAddress } from '../models/RelayAddress';
import { TransferOperation, RelayState, ITransferOperation } from '../models/TransferOperation';
import { User } from '../models/User';
import { Transaction } from '../models/Transaction';
import { AdminAction } from '../models/AdminAction';
import { encrypt } from '../utils/encryption';
import { withLock } from '../utils/distributed-lock';
import { checkRateLimit } from '../utils/rate-limiter';
import { isValidTonAddress } from '../utils/validation';
import { Precision } from '../utils/precision';
import { WalletService } from './wallet-service';

export interface RelayQuote {
  quoteId: string;
  relayAddressId: string;
  relayAddress: string;
  label: string;
  requestedNano: bigint;
  platformFeeNano: bigint;
  fundingAmountNano: bigint;   // total the user must send: requested + fee + network reserve
  forwardFeeEstimateNano: bigint;
  minReserveNano: bigint;
  totalDebitNano: bigint;
  relayResidualExpectedNano: bigint;
  expiresAt: Date;
}

/**
 * Platform-controlled transfer relay — USER-FUNDED design.
 *
 * Flow:
 *  1. User picks an amount → bot shows a fresh relay address and the
 *     exact total to send (requested + 2% platform fee + network reserve).
 *  2. User funds the relay address from ANY wallet.
 *  3. User provides the destination → confirms.
 *  4. ONE on-chain transaction from the relay pays the platform fee to the
 *     admin fee wallet and the requested amount to the destination.
 *  5. Destination receipt verified on-chain → COMPLETED + 10-day cooldown.
 *
 * Guarantees:
 *  - No admin treasury involvement (no gas advance, no init churn).
 *  - Plaintext mnemonics NEVER leave this process; AES-GCM at rest only.
 *  - Idempotent at every stage; per-user and per-address locks.
 *  - Only FUNDING-adjacent broadcast state is SENDING. CREATED/VALIDATED
 *    never broadcast and must never block selection or sweeps.
 */
export class TransferRelayService {
  private tonClient: TonClient;
  private walletService: WalletService;

  constructor() {
    this.tonClient = new TonClient({ endpoint: config.tonRpcUrl, apiKey: config.tonApiKey });
    this.walletService = new WalletService();
  }

  private assertEnabled(): void {
    if (!config.features.transferRelay) throw new Error('Transfer relay is not enabled');
  }

  /* ══════════════ ADDRESS PROVISIONING ══════════════ */

  async ensureAddresses(userId: number): Promise<void> {
    this.assertEnabled();

    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');

    const count = await RelayAddress.countDocuments({
      userId: user._id,
      status: { $in: ['active', 'recovery_required'] },
    });

    const needed = config.relay.addressesPerUser - count;
    if (needed <= 0) return;

    await checkRateLimit('relay:provision', userId, 2, 60_000);

    const existing = await RelayAddress.countDocuments({});
    for (let i = 0; i < needed; i++) {
      const mnemonic = await mnemonicNew(24);
      const keyPair = await mnemonicToWalletKey(mnemonic);

      const contract =
        config.relay.walletVersion === 'v5r1'
          ? WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 })
          : WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });

      const address = contract.address.toString();
      const enc = encrypt(mnemonic.join(' '));

      await RelayAddress.create({
        userId: user._id,
        address,
        label: `Relay ${existing + i + 1}`,
        encryptedMnemonic: enc.encrypted,
        iv: enc.iv,
        tag: enc.tag,
        walletVersion: config.relay.walletVersion,
        status: 'active',
      });
    }
  }

  async listAddresses(userId: number) {
    this.assertEnabled();
    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');
    return RelayAddress.find({ userId: user._id, status: { $in: ['active', 'recovery_required'] } })
      .sort({ createdAt: 1 });
  }

  /* ══════════════ SELECTION GUARDS ══════════════ */

  private async assertAddressSelectable(relay: any): Promise<void> {
    if (relay.status !== 'active') {
      throw new Error('This relay address is not active');
    }

    if (relay.nextEligibleAt && relay.nextEligibleAt.getTime() > Date.now()) {
      const days = Math.ceil((relay.nextEligibleAt.getTime() - Date.now()) / 86_400_000);
      throw new Error(`This address is cooling down. Try again in ~${days} day(s).`);
    }

    // Only genuinely in-flight or fund-holding states block selection.
    // CREATED/VALIDATED ops never broadcast and are cleaned by the reconciler.
    const unresolved = await TransferOperation.countDocuments({
      relayAddressId: relay._id,
      state: { $in: ['SENDING', 'RECOVERY_REQUIRED'] },
    });
    if (unresolved > 0) {
      throw new Error('This address has an unresolved operation. Wait for it to finish.');
    }

    // Recoverable dust (≤ network reserve) is fine — it can't cover a transfer.
    const balance = await this.getTonBalance(relay.address);
    if (balance > config.relay.forwardFeeEstimateNano) {
      throw new Error('This address still holds funds. Sweep it via the admin dashboard first.');
    }
  }

  private async getTonBalance(address: string): Promise<bigint> {
    try {
      return BigInt((await this.tonClient.getBalance(Address.parse(address))).toString());
    } catch {
      return 0n;
    }
  }

  /* ══════════════ QUOTE / PREVIEW ══════════════ */

  async prepareQuote(
    userId: number,
    relayAddressId: string,
    requestedTon: string
  ): Promise<RelayQuote> {
    this.assertEnabled();

    await checkRateLimit('relay:prepare', userId, config.relay.prepareRateLimit, config.relay.prepareRateWindowMs);

    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    const relay = await RelayAddress.findOne({ _id: relayAddressId, userId: user._id });
    if (!relay) throw new Error('Relay address not found');
    await this.assertAddressSelectable(relay);

    if (!/^\d+(\.\d+)?$/.test(requestedTon) || Number(requestedTon) <= 0) {
      throw new Error('Invalid amount');
    }

    const requestedNano = BigInt(Precision.toBaseUnits(requestedTon, 9));
    if (requestedNano <= 0n) throw new Error('Invalid amount');

    const { platformFeeNano } = FeeEngine.planRelayFee(requestedNano);
    const forwardFee = config.relay.forwardFeeEstimateNano;
    const minReserve = config.relay.minRelayReserveNano;

    // Total the user must send to the relay address.
    const fundingAmountNano = requestedNano + platformFeeNano + forwardFee;

    return {
      quoteId: crypto.randomUUID(),
      relayAddressId: relay._id.toString(),
      relayAddress: relay.address,
      label: relay.label,
      requestedNano,
      platformFeeNano,
      fundingAmountNano,
      forwardFeeEstimateNano: forwardFee,
      minReserveNano: minReserve,
      totalDebitNano: fundingAmountNano,
      relayResidualExpectedNano: minReserve,
      expiresAt: new Date(Date.now() + config.relay.quoteTtlMs),
    };
  }

  /**
   * Phase-1b check: has the relay address received the required funds?
   * Balance-based — the address is guaranteed fresh (selection enforced
   * near-zero balance), so balance ≥ required means the user funded it.
   */
  async checkFunding(quote: RelayQuote): Promise<{ ok: boolean; balanceNano: bigint; requiredNano: bigint }> {
    this.assertEnabled();

    const relay = await RelayAddress.findById(quote.relayAddressId);
    if (!relay) throw new Error('Relay address not found');

    const requiredNano = quote.fundingAmountNano;
    const balanceNano = await this.getTonBalance(relay.address);

    return { ok: balanceNano >= requiredNano, balanceNano, requiredNano };
  }
    /* ══════════════ EXECUTION STATE MACHINE ══════════════ */

  async execute(userId: number, quote: RelayQuote, destination: string): Promise<string> {
    this.assertEnabled();

    if (!isValidTonAddress(destination)) {
      throw new Error('Invalid destination address');
    }

    if (Date.now() > quote.expiresAt.getTime()) {
      throw new Error('Quote expired. Request a new preview.');
    }

    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    const normalizedDestination = Address.parse(destination).toString();
    const idempotencyKey = `relay:${userId}:${quote.quoteId}`;

    return withLock(
      `lock:relay:user:${userId}`,
      config.relay.lockTtlMs,
      async () => {
        const relay = await RelayAddress.findOne({
          _id: quote.relayAddressId,
          userId: user._id,
        });

        if (!relay) throw new Error('Relay address not found');
        if (relay.address !== quote.relayAddress) {
          throw new Error('Quote relay address does not match the selected address');
        }

        return withLock(
          `lock:relay:addr:${relay.address}`,
          config.relay.lockTtlMs,
          async () => {
            const existing = await TransferOperation.findOne({ idempotencyKey });

            if (existing) {
              if (existing.state === 'COMPLETED') return existing.operationId;
              if (
                existing.state === 'RECOVERY_REQUIRED' ||
                existing.state === 'SENDING'
              ) {
                throw new Error(
                  `Operation ${existing.operationId} is ${existing.state}. ` +
                  'Reconcile its on-chain transactions before attempting another transfer.'
                );
              }
              if (existing.state === 'FAILED' || existing.state === 'EXPIRED') {
                throw new Error(
                  existing.failureReason ||
                  'This operation has failed. Reconcile it before creating another transfer.'
                );
              }
              throw new Error(
                `Operation ${existing.operationId} already exists in state ${existing.state}. ` +
                'It will not be executed again automatically.'
              );
            }

            await this.assertAddressSelectable(relay);

            let op: ITransferOperation;
            try {
              op = await TransferOperation.create({
                operationId: crypto.randomUUID(),
                idempotencyKey,
                userId: user._id,
                relayAddressId: relay._id,
                relayAddress: relay.address,
                state: 'CREATED',
                requestedAmountNano: quote.requestedNano.toString(),
                platformFeeNano: quote.platformFeeNano.toString(),
                fundingAmountNano: quote.fundingAmountNano.toString(),
                forwardFeeEstimateNano: quote.forwardFeeEstimateNano.toString(),
                minReserveNano: quote.minReserveNano.toString(),
                totalDebitNano: quote.totalDebitNano.toString(),
                destinationAddress: normalizedDestination,
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
                retryCount: 0,
                stateHistory: [{ state: 'CREATED', at: new Date() }],
              }) as ITransferOperation;
            } catch (error: any) {
              if (error?.code === 11000) {
                throw new Error(
                  'A concurrent request created this operation. Check its status before retrying.'
                );
              }
              throw error;
            }

            let ledger: any = null;
            let outgoingBroadcastAttempted = false;

            try {
              await this.transition(op, 'VALIDATED', 'Destination and quote validated');

              ledger = await Transaction.create({
                userId: user._id,
                type: 'transfer_relay',
                asset: 'TON',
                amount: Precision.fromBaseUnits(quote.requestedNano, 9),
                fee: Precision.fromBaseUnits(quote.platformFeeNano, 9),
                feeAsset: 'TON',
                feePercentage: config.feePolicy.relayTransferPercent,
                feeWallet: config.adminFeeWalletAddress,
                feeStatus: 'pending',
                status: 'processing',
                txHash: `relay-pending-${op.operationId}`,
                toAddress: normalizedDestination,
                metadata: {
                  operationId: op.operationId,
                  relayAddress: relay.address,
                  fundingAmount: Precision.fromBaseUnits(quote.fundingAmountNano, 9),
                  platformFee: Precision.fromBaseUnits(quote.platformFeeNano, 9),
                  relayService: true,
                },
              });

              /* ── User-funded relay: confirm the deposit landed, then send ── */
              const fundingCheck = await this.checkFunding(quote);
              if (!fundingCheck.ok) {
                throw new Error(
                  `Relay not funded yet (${Precision.fromBaseUnits(fundingCheck.balanceNano, 9)} of ` +
                  `${Precision.fromBaseUnits(fundingCheck.requiredNano, 9)} TON). Check Relay History.`
                );
              }

              const actualReceived = fundingCheck.balanceNano;

              const availableForDestination =
                actualReceived - quote.platformFeeNano - quote.forwardFeeEstimateNano;

              if (availableForDestination < quote.requestedNano) {
                await TransferOperation.updateOne(
                  { _id: op._id },
                  {
                    $set: {
                      fundingActualNano: actualReceived.toString(),
                      state: 'RECOVERY_REQUIRED',
                    },
                    $push: {
                      stateHistory: {
                        state: 'RECOVERY_REQUIRED',
                        at: new Date(),
                        note: 'Insufficient balance after funding check',
                      },
                    },
                  }
                );
                throw new Error('Network costs exceeded the estimate. Operation flagged for recovery.');
              }

              await TransferOperation.updateOne(
                { _id: op._id },
                {
                  $set: {
                    fundingActualNano: actualReceived.toString(),
                  },
                }
              );

              await this.transition(op, 'SENDING', 'Relay funded — preparing outgoing transfer');

              outgoingBroadcastAttempted = true;

              // ONE transaction: platform fee → admin wallet, requested → destination
              const outgoingRef = await this.sendFromRelayMulti(
                relay,
                [
                  { to: config.adminFeeWalletAddress, value: quote.platformFeeNano },
                  { to: normalizedDestination, value: quote.requestedNano },
                ]
              );

              await TransferOperation.updateOne(
                { _id: op._id },
                { $set: { outgoingTxHash: outgoingRef } }
              );

              /* ── Verify outgoing by SENDER (relay) + AMOUNT at destination ── */
              const verifiedOut = await this.verifyIncomingTonFrom(
                normalizedDestination,
                relay.address,
                quote.requestedNano,
                { allowBalanceFallback: false }
              );

              if (!verifiedOut.ok) {
                await this.transition(
                  op,
                  'RECOVERY_REQUIRED',
                  `Outgoing verification uncertain: ${verifiedOut.reason}`
                );
                throw new Error('Outgoing transfer could not be confirmed. Operation requires recovery.');
              }

              const residual =
                actualReceived - quote.requestedNano - quote.platformFeeNano - (verifiedOut.feeNano ?? 0n);

              await TransferOperation.updateOne(
                { _id: op._id },
                {
                  $set: {
                    state: 'COMPLETED',
                    confirmedAt: new Date(),
                    outgoingAmountNano: quote.requestedNano.toString(),
                    outgoingNetworkFeeNano: (verifiedOut.feeNano ?? 0n).toString(),
                    relayResidualNano: (residual > 0n ? residual : 0n).toString(),
                    // Replace the external-msg-hash ref with the real tx hash when matched
                    ...(verifiedOut.txHash ? { outgoingTxHash: verifiedOut.txHash } : {}),
                  },
                  $push: {
                    stateHistory: {
                      state: 'COMPLETED',
                      at: new Date(),
                      note: 'Outgoing transaction verified on-chain',
                    },
                  },
                }
              );

              op.state = 'COMPLETED';

              await RelayAddress.updateOne(
                { _id: relay._id },
                {
                  $set: {
                    nextEligibleAt: new Date(
                      Date.now() + config.relay.reuseCooldownDays * 86_400_000
                    ),
                    lastActivityAt: new Date(),
                  },
                }
              );

              await Transaction.create({
                userId: user._id,
                type: 'fee',
                asset: 'TON',
                amount: Precision.fromBaseUnits(quote.platformFeeNano, 9),
                status: 'completed',
                txHash: `relay-fee-${op.operationId}`,
                metadata: {
                  operationId: op.operationId,
                  relayAddress: relay.address,
                  feeKind: 'relay_platform_fee',
                },
              });

              await Transaction.updateOne(
                { _id: ledger._id },
                {
                  $set: {
                    status: 'completed',
                    txHash: verifiedOut.txHash || outgoingRef,
                    reconciledAt: new Date(),
                  },
                }
              );

              return op.operationId;
            } catch (error: any) {
              const message = String(error?.message || error).slice(0, 500);

              if (op.state !== 'COMPLETED') {
                const mustRecover =
                  outgoingBroadcastAttempted ||
                  op.state === 'SENDING' ||
                  op.state === 'RECOVERY_REQUIRED';

                const nextState: RelayState = mustRecover ? 'RECOVERY_REQUIRED' : 'FAILED';

                await TransferOperation.updateOne(
                  { _id: op._id },
                  {
                    $set: { state: nextState, failureReason: message },
                    $push: {
                      stateHistory: {
                        state: nextState,
                        at: new Date(),
                        note: message.slice(0, 200),
                      },
                    },
                  }
                ).catch(() => {
                  // Keep the original error. Reconciliation must inspect stale operations.
                });

                op.state = nextState;
              }

              throw error;
            }
          }
        );
      }
    );
  }

  /* ══════════════ RECONCILIATION (worker-owned) ══════════════ */

  async reconcileStale(): Promise<{ resumed: number; flagged: number }> {
    let resumed = 0;
    let flagged = 0;

    const stale = await TransferOperation.find({
      state: { $in: ['CREATED', 'VALIDATED', 'SENDING'] },
      updatedAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) },
    }).limit(50);

    for (const op of stale) {
      try {
        if (op.state === 'SENDING' && op.outgoingTxHash) {
          const v = await this.verifyIncomingTonFrom(
            op.destinationAddress,
            op.relayAddress,
            BigInt(op.requestedAmountNano),
            { allowBalanceFallback: false, quick: true }
          );
          if (v.ok) {
            await TransferOperation.updateOne(
              { _id: op._id },
              {
                $set: { state: 'COMPLETED', confirmedAt: new Date() },
                $push: {
                  stateHistory: {
                    state: 'COMPLETED',
                    at: new Date(),
                    note: 'reconciler verified outgoing tx',
                  },
                },
              }
            );
            resumed++;
          } else {
            await this.transition(op, 'RECOVERY_REQUIRED', `reconciler: outgoing unverifiable — ${v.reason}`);
            flagged++;
          }
        } else {
          // CREATED / VALIDATED with no broadcast → dead, expire safely
          await TransferOperation.updateOne(
            { _id: op._id },
            {
              $set: { state: 'EXPIRED', failureReason: 'Expired before broadcast' },
              $push: { stateHistory: { state: 'EXPIRED', at: new Date() } },
            }
          );
          flagged++;
        }
      } catch {
        flagged++;
      }
    }

    return { resumed, flagged };
              }
                  /* ══════════════ TREASURY CONSOLIDATION (admin-gated) ══════════════ */

  async sweepResidualToTreasury(
    adminTelegramId: number,
    reason: string
  ): Promise<Array<{ address: string; amountNano: string; txHash?: string; error?: string }>> {
    if (!config.features.treasurySweep) throw new Error('Treasury sweep is not enabled');
    if (!config.relay.treasuryAddress || !isValidTonAddress(config.relay.treasuryAddress)) {
      throw new Error('Treasury address not configured');
    }
    if (!reason || reason.trim().length < 5) throw new Error('A reason is required for the audit log');

    const results: Array<{ address: string; amountNano: string; txHash?: string; error?: string }> = [];

    const candidates = await RelayAddress.aggregate([
      {
        $lookup: {
          from: 'transferoperations',
          let: { rid: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$relayAddressId', '$$rid'] },
                    {
                      $in: ['$state', [
                        'CREATED', 'VALIDATED', 'AWAITING_CONFIRMATION',
                        'SENDING', 'RECOVERY_REQUIRED',
                      ]],
                    },
                  ],
                },
              },
            },
          ],
          as: 'openOps',
        },
      },
      {
        $match: {
          openOps: { $size: 0 },
          status: { $in: ['active', 'recovery_required', 'retired'] },
        },
      },
    ]);

    for (const cand of candidates) {
      const swept = await withLock(
        `lock:relay:addr:${cand.address}`,
        60_000,
        async () => {
          const balance = await this.getTonBalance(cand.address);

          const minSweep =
            config.relay.minRelayReserveNano +
            config.relay.forwardFeeEstimateNano;

          if (balance <= minSweep) return null;

          const sweepable = balance - config.relay.forwardFeeEstimateNano;
          if (sweepable <= 0n) return null;

          try {
            const relay = await RelayAddress.findById(cand._id);
            if (!relay) return null;

            const txHash = await this.sendFromRelay(
              relay,
              config.relay.treasuryAddress,
              sweepable
            );

            return {
              address: cand.address as string,
              amountNano: sweepable.toString(),
              txHash,
            };
          } catch (err: any) {
            return {
              address: cand.address as string,
              amountNano: sweepable.toString(),
              error: String(err.message).slice(0, 200),
            };
          }
        }
      ).catch(() => null);

      if (swept) results.push(swept);
    }

    const adminUser = await User.findOne({ telegramId: adminTelegramId });
    await Transaction.create({
      userId: adminUser?._id,
      type: 'treasury_sweep',
      asset: 'TON',
      amount: results
        .filter((r) => !r.error)
        .reduce((acc, r) => acc + BigInt(r.amountNano), 0n)
        .toString(),
      status: 'completed',
      txHash: `sweep-${Date.now()}`,
      metadata: {
        adminTelegramId,
        reason: reason.slice(0, 300),
        addresses: results.map((r) => ({
          address: r.address,
          amountNano: r.amountNano,
          txHash: r.txHash,
          error: r.error,
        })),
        sweptCount: results.filter((r) => !r.error).length,
        failedCount: results.filter((r) => r.error).length,
      },
    });

    return results;
  }

  /**
   * Admin recovery sweep: move the full spendable balance of ONE relay
   * address to the admin fee wallet. Super-admin gated at the UI layer.
   *
   * Safety: refuses only while an operation is broadcast-pending (SENDING).
   * CREATED/VALIDATED ops never broadcast and cannot be executing
   * concurrently — the caller holds the per-address lock, which execute()
   * also requires for its entire body. Audit-logged via AdminAction.
   */
  async sweepAddressToAdmin(
    relayId: string,
    adminTelegramId: number
  ): Promise<{ address: string; amountNano: string; txHash: string }> {
    this.assertEnabled();

    const relay = await RelayAddress.findById(relayId);
    if (!relay) throw new Error('Relay address not found');

    return withLock(`lock:relay:addr:${relay.address}`, 60_000, async () => {
      const inFlight = await TransferOperation.countDocuments({
        relayAddressId: relay._id,
        state: { $in: ['SENDING'] },
      });
      if (inFlight > 0) {
        throw new Error('This address has an in-flight operation. Wait for it to finish before sweeping.');
      }

      const balance = await this.getTonBalance(relay.address);
      const sweepable = balance - config.relay.forwardFeeEstimateNano; // reserve network fee
      if (sweepable <= 0n) {
        throw new Error('Nothing to sweep — balance is below the network-fee threshold.');
      }

      const txHash = await this.sendFromRelay(
        relay,
        config.adminFeeWalletAddress,
        sweepable
      );

      await AdminAction.create({
        adminId: adminTelegramId,
        action: 'RELAY_ADDRESS_SWEEP',
        target: relay.address,
        result: 'success',
        metadata: {
          relayId: relay._id.toString(),
          label: relay.label,
          amountNano: sweepable.toString(),
          txHash,
          toAddress: config.adminFeeWalletAddress,
          reason: 'admin_recovery_sweep',
        },
      });

      return {
        address: relay.address,
        amountNano: sweepable.toString(),
        txHash,
      };
    });
  }

  /** Public read for the admin dashboard (live on-chain balance). */
  async getAddressBalance(address: string): Promise<bigint> {
    return this.getTonBalance(address);
  }

  /* ══════════════ INTERNALS ══════════════ */

  private async transition(op: ITransferOperation, to: RelayState, note?: string): Promise<void> {
    await TransferOperation.updateOne(
      { _id: op._id },
      {
        $set: { state: to },
        $push: { stateHistory: { state: to, at: new Date(), note } },
      }
    );
    op.state = to;
  }

  /**
   * Verify an incoming transfer by SENDER ADDRESS + AMOUNT.
   *
   * Addresses are compared canonically (bounceable EQ form) because the
   * same key can appear as EQ.../UQ... and raw string equality misses it.
   */
  private async verifyIncomingTonFrom(
    receivingAddress: string,
    senderAddress: string,
    expectedNano: bigint,
    opts: { allowBalanceFallback: boolean; quick?: boolean }
  ): Promise<
    | { ok: true; receivedNano: bigint; feeNano: bigint; txHash: string }
    | { ok: false; reason: string }
  > {
    const attempts = opts.quick ? 3 : 30;
    const intervalMs = 5_000;

    const canonicalSender = (() => {
      try { return Address.parse(senderAddress).toString(); } catch { return senderAddress; }
    })();

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const txs = await this.tonClient.getTransactions(Address.parse(receivingAddress), { limit: 20 });

        for (const tx of txs) {
          const inMsg = tx.inMessage;
          if (inMsg?.info.type === 'internal') {
            const src = inMsg.info.src
              ? (() => { try { return Address.parse(inMsg.info.src.toString()).toString(); } catch { return inMsg.info.src.toString(); } })()
              : null;
            if (src === canonicalSender) {
              const value = BigInt(inMsg.info.value.coins.toString());
              if (value >= expectedNano) {
                return {
                  ok: true,
                  receivedNano: value,
                  feeNano: BigInt(tx.totalFees.coins.toString()),
                  txHash: tx.hash().toString('hex'),
                };
              }
            }
          }
        }

        // Balance fallback (fresh-address guarantee required)
        if (opts.allowBalanceFallback) {
          const balance = await this.getTonBalance(receivingAddress);
          if (balance >= expectedNano) {
            return {
              ok: true,
              receivedNano: balance,
              feeNano: 0n,
              txHash: '',
            };
          }
        }
      } catch {
        // RPC hiccup — retry with backoff
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    return { ok: false, reason: 'incoming transfer not found on-chain after timeout' };
  }

  /**
   * Sign and broadcast a single-message transfer FROM a relay wallet.
   * Used by admin recovery sweeps. V4R2/V5R1 branched explicitly.
   */
  private async sendFromRelay(
    relay: any,
    to: string,
    amountNano: bigint
  ): Promise<string> {
    return this.sendFromRelayMulti(relay, [{ to, value: amountNano }]);
  }

  /**
   * Sign and broadcast a multi-message transfer FROM a relay wallet.
   * All messages go out in ONE transaction (single seqno increment).
   * Signing material decrypted in-memory only, never logged.
   */
  private async sendFromRelayMulti(
    relay: any,
    transfers: Array<{ to: string; value: bigint }>
  ): Promise<string> {
    const { decrypt } = require('../utils/encryption');

    const mnemonicPhrase: string = decrypt(
      relay.encryptedMnemonic,
      relay.iv,
      relay.tag
    );
    const mnemonic = mnemonicPhrase.split(' ');
    const keyPair = await mnemonicToWalletKey(mnemonic);

    const isV5 = relay.walletVersion === 'v5r1';
    const contract = isV5
      ? WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 })
      : WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });

    const opened = this.tonClient.open(contract as any);

    const seqno = await opened.getSeqno();

    const messages = transfers.map((t) =>
      internal({
        to: Address.parse(t.to),
        value: t.value,
        bounce: false,
      })
    );

    const sendMode = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;

    let transfer: any;
    if (isV5) {
      const c = contract as WalletContractV5R1;
      transfer = await c.createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode,
        messages,
      });
    } else {
      const c = contract as WalletContractV4;
      transfer = await c.createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode,
        messages,
      });
    }

    await opened.send(transfer);
    return transfer.hash().toString('hex');
  }

  /* ── User-facing history ── */

  async history(userId: number, page = 1) {
    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');

    const pageSize = 8;
    const [items, total] = await Promise.all([
      TransferOperation.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .select(
          'operationId relayAddress destinationAddress requestedAmountNano state fundingTxHash outgoingTxHash createdAt'
        ),
      TransferOperation.countDocuments({ userId: user._id }),
    ]);

    return { items, total, page, pageSize };
  }
}
