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
  fundingAmountNano: bigint;   // total debited from user wallet: requested + fee + network reserve
  forwardFeeEstimateNano: bigint;
  minReserveNano: bigint;
  totalDebitNano: bigint;
  relayResidualExpectedNano: bigint;
  expiresAt: Date;
}

/**
 * Platform-controlled transfer relay — AUTO-FUNDED from the user's
 * custodial wallet.
 *
 * Flow (one operation row per quote, idempotent end-to-end):
 *  1. prepareQuote  — amount → total to debit (requested + 2% fee + reserve)
 *  2. fundRelay     — bot sends the total from the user's wallet to the
 *                     fresh relay address; verified on-chain → FUNDED
 *  3. execute       — user supplied destination → ONE relay transaction
 *                     (platform fee → admin wallet, requested → destination)
 *                     verified at destination → COMPLETED + 10-day cooldown
 *
 * Guarantees:
 *  - No admin treasury involvement; fees flow to the admin FEE wallet.
 *  - Plaintext mnemonics NEVER leave this process; AES-GCM at rest only.
 *  - Per-user + per-address locks; idempotency key per quote; crash-safe
 *    (a retry after a crashed send re-checks balance instead of re-sending).
 *  - Only FUNDING/FUNDED/SENDING are fund-holding/in-flight states.
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

    // Fund-holding or genuinely in-flight states block selection.
    const unresolved = await TransferOperation.countDocuments({
      relayAddressId: relay._id,
      state: { $in: ['FUNDING', 'FUNDED', 'SENDING', 'RECOVERY_REQUIRED'] },
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

    // Total debited from the user's wallet and sent to the relay address.
    const fundingAmountNano = requestedNano + platformFeeNano + forwardFee;

    const walletAddress = await this.walletService.getAddress(userId);
    if (!walletAddress) throw new Error('Wallet not found');
    const userTon = await this.getTonBalance(walletAddress);
    const gasBuffer = 20_000_000n; // ~0.02 TON for the funding send itself
    if (userTon < fundingAmountNano + gasBuffer) {
      throw new Error(
        `Insufficient TON — you need ~${Precision.fromBaseUnits(fundingAmountNano + gasBuffer, 9)} TON ` +
        `(amount + ${config.feePolicy.relayTransferPercent}% fee + network reserve + gas).`
      );
    }

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
   * Balance check on the relay address. The address is guaranteed fresh
   * (selection enforced near-zero balance), so balance ≥ required means
   * the funds arrived — regardless of tx-hash reference formats.
   */
  async checkFunding(quote: RelayQuote): Promise<{ ok: boolean; balanceNano: bigint; requiredNano: bigint }> {
    this.assertEnabled();

    const relay = await RelayAddress.findById(quote.relayAddressId);
    if (!relay) throw new Error('Relay address not found');

    const requiredNano = quote.fundingAmountNano;
    const balanceNano = await this.getTonBalance(relay.address);

    return { ok: balanceNano >= requiredNano, balanceNano, requiredNano };
  }

  /* ══════════════ STEP 2: FUND THE RELAY FROM THE USER'S WALLET ══════════════ */

  /**
   * Debit the user's custodial wallet and fund the relay. Creates the
   * single operation row for this quote (idempotent by idempotencyKey).
   * Crash-safe: if the relay already holds the funds (crash after the
   * send), it skips re-sending and marks FUNDED.
   */
  async fundRelay(userId: number, quote: RelayQuote): Promise<{ operationId: string }> {
    this.assertEnabled();

    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    const idempotencyKey = `relay:${userId}:${quote.quoteId}`;

    return withLock(`lock:relay:user:${userId}`, config.relay.lockTtlMs, async () => {
      const relay = await RelayAddress.findOne({ _id: quote.relayAddressId, userId: user._id });
      if (!relay) throw new Error('Relay address not found');
      if (relay.address !== quote.relayAddress) {
        throw new Error('Quote relay address does not match the selected address');
      }

      return withLock(`lock:relay:addr:${relay.address}`, config.relay.lockTtlMs, async () => {
        const existing = await TransferOperation.findOne({ idempotencyKey });

        if (existing) {
          if (existing.state === 'FUNDED' || existing.state === 'SENDING' || existing.state === 'COMPLETED') {
            return { operationId: existing.operationId };
          }
          if (existing.state === 'RECOVERY_REQUIRED') {
            throw new Error('This operation requires reconciliation before retrying.');
          }
          if (existing.state === 'FAILED' || existing.state === 'EXPIRED') {
            throw new Error(existing.failureReason || 'This operation failed.');
          }
        }

        let op: ITransferOperation;
        if (existing) {
          op = existing;
        } else {
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
              destinationAddress: '',
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
              retryCount: 0,
              stateHistory: [{ state: 'CREATED', at: new Date() }],
            }) as ITransferOperation;
          } catch (error: any) {
            if (error?.code === 11000) {
              throw new Error('A concurrent request created this operation. Check its status before retrying.');
            }
            throw error;
          }
        }

        // Crash-recovery: already funded → do NOT re-send
        const preCheck = await this.checkFunding(quote);
        if (preCheck.ok) {
          await TransferOperation.updateOne(
            { _id: op._id },
            { $set: { fundingActualNano: preCheck.balanceNano.toString() } }
          );
          await this.transition(op, 'FUNDED', 'Relay already funded (recovered)');
          return { operationId: op.operationId };
        }

        const walletAddress = await this.walletService.getAddress(userId);
        if (!walletAddress) throw new Error('Wallet not found');

        let fundingAttempted = false;

        try {
          await this.transition(op, 'FUNDING', 'Debiting user wallet to fund relay');

          fundingAttempted = true;

          await this.walletService.sendTon(userId, relay.address, quote.fundingAmountNano);

          const v = await this.verifyIncomingTonFrom(
            relay.address,
            walletAddress,
            quote.fundingAmountNano,
            { allowBalanceFallback: true }
          );

          if (!v.ok) {
            throw new Error('Funding could not be confirmed on-chain. Operation requires reconciliation.');
          }

          await TransferOperation.updateOne(
            { _id: op._id },
            {
              $set: {
                fundingActualNano: v.receivedNano.toString(),
                ...(v.txHash ? { fundingTxHash: v.txHash } : {}),
              },
            }
          );

          await this.transition(op, 'FUNDED', 'Relay funded from user wallet — awaiting destination');

          return { operationId: op.operationId };
        } catch (error: any) {
          if (op.state !== 'FUNDED') {
            const nextState: RelayState = fundingAttempted ? 'RECOVERY_REQUIRED' : 'FAILED';
            await TransferOperation.updateOne(
              { _id: op._id },
              {
                $set: { state: nextState, failureReason: String(error?.message || error).slice(0, 500) },
                $push: {
                  stateHistory: {
                    state: nextState,
                    at: new Date(),
                    note: String(error?.message || error).slice(0, 200),
                  },
                },
              }
            ).catch(() => {});
            op.state = nextState;
          }
          throw error;
        }
      });
    });
                      }
    /* ══════════════ STEP 3: EXECUTE THE OUTGOING TRANSFER ══════════════ */

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

            if (!existing) {
              throw new Error('Relay is not funded yet. Complete the funding step first.');
            }

            if (existing.state === 'COMPLETED') return existing.operationId;

            if (existing.state !== 'FUNDED') {
              if (existing.state === 'RECOVERY_REQUIRED' || existing.state === 'SENDING') {
                throw new Error(
                  `Operation ${existing.operationId} is ${existing.state}. ` +
                  'Reconcile its on-chain transactions before attempting another transfer.'
                );
              }
              throw new Error(
                `Operation ${existing.operationId} is ${existing.state}. Fund the relay first.`
              );
            }

            // Record the destination now that we have it
            await TransferOperation.updateOne(
              { _id: existing._id },
              { $set: { destinationAddress: normalizedDestination } }
            );

            const op: ITransferOperation = existing;
            let ledger: any = null;
            let outgoingBroadcastAttempted = false;

            try {
              await this.transition(op, 'VALIDATED', 'Destination captured');

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

              /* ── Confirm the funds are still on the relay, then send ── */
              const fundingCheck = await this.checkFunding(quote);
              if (!fundingCheck.ok) {
                throw new Error(
                  `Relay balance short (${Precision.fromBaseUnits(fundingCheck.balanceNano, 9)} of ` +
                  `${Precision.fromBaseUnits(fundingCheck.requiredNano, 9)} TON). Check Relay History.`
                );
              }

              const actualReceived = fundingCheck.balanceNano;

              const availableForDestination =
                actualReceived - quote.platformFeeNano - quote.forwardFeeEstimateNano;

              if (availableForDestination < quote.requestedNano) {
                await this.transition(
                  op,
                  'RECOVERY_REQUIRED',
                  'Insufficient balance to cover transfer + network costs'
                );
                throw new Error('Network costs exceeded the estimate. Operation flagged for recovery.');
              }

              await TransferOperation.updateOne(
                { _id: op._id },
                { $set: { fundingActualNano: actualReceived.toString() } }
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
      state: { $in: ['CREATED', 'VALIDATED', 'FUNDING', 'FUNDED', 'SENDING'] },
      updatedAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) },
    }).limit(50);

    for (const op of stale) {
      try {
        if (op.state === 'FUNDING') {
          // Funding was broadcast — verify it from the user's wallet
          const owner = await User.findById(op.userId);
          if (owner) {
            const walletAddress = await this.walletService.getAddress(owner.telegramId);
            if (walletAddress) {
              const v = await this.verifyIncomingTonFrom(
                op.relayAddress,
                walletAddress,
                BigInt(op.fundingAmountNano),
                { allowBalanceFallback: true, quick: true }
              );
              if (v.ok) {
                await TransferOperation.updateOne(
                  { _id: op._id },
                  {
                    $set: {
                      state: 'FUNDED',
                      fundingActualNano: v.receivedNano.toString(),
                      ...(v.txHash ? { fundingTxHash: v.txHash } : {}),
                    },
                    $push: { stateHistory: { state: 'FUNDED', at: new Date(), note: 'reconciler: funding verified after restart' } },
                  }
                );
                resumed++;
                continue;
              }
            }
          }
          await this.transition(op, 'RECOVERY_REQUIRED', 'reconciler: funding unverifiable after restart');
          flagged++;
        } else if (op.state === 'SENDING' && op.outgoingTxHash) {
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
        } else if (op.state === 'FUNDED') {
          // Waiting on the user to enter a destination — not stale, leave it
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
                        'FUNDING', 'FUNDED', 'SENDING', 'RECOVERY_REQUIRED',
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
   * Safety: refuses while any operation is fund-holding or broadcast-
   * pending (FUNDING/FUNDED/SENDING). The caller holds the per-address
   * lock, which fundRelay/execute also require for their entire bodies.
   * Audit-logged via AdminAction.
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
        state: { $in: ['FUNDING', 'FUNDED', 'SENDING'] },
      });
      if (inFlight > 0) {
        throw new Error('This address has in-flight operations. Wait for them to finish before sweeping.');
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
   * Hash references from wallet services ("address_seqno") are NOT tx
   * hashes, so matching is sender+amount based, with an optional balance
   * fallback where the receiving address is guaranteed fresh.
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
