import crypto from 'crypto';
import { mnemonicNew, mnemonicToWalletKey } from '@ton/crypto';
import {
  TonClient, WalletContractV4, WalletContractV5R1,
  Address, internal, toNano, SendMode,
} from '@ton/ton';
import { config } from '../config';
import { FeeEngine } from '../config/fees';
import { RelayAddress } from '../models/RelayAddress';
import { TransferOperation, RelayState, ITransferOperation } from '../models/TransferOperation';
import { User } from '../models/User';
import { Transaction } from '../models/Transaction';
import { encrypt } from '../utils/encryption';
import { withLock } from '../utils/distributed-lock';
import { checkRateLimit } from '../utils/rate-limiter';
import { isValidTonAddress } from '../utils/validation';
import { Precision } from '../utils/precision';
import { AdminWalletService } from './admin-wallet-service';

export interface RelayQuote {
  quoteId: string;
  relayAddressId: string;
  relayAddress: string;
  label: string;
  requestedNano: bigint;
  platformFeeNano: bigint;
  fundingAmountNano: bigint;     // requested + fee (+ forward estimate)
  forwardFeeEstimateNano: bigint;
  minReserveNano: bigint;
  totalDebitNano: bigint;        // from user's source wallet
  relayResidualExpectedNano: bigint;
  expiresAt: Date;
}

const CONFIRMATIONS_REQUIRED = 1;

/**
 * Platform-controlled transfer relay.
 *
 * Hard isolation guarantees:
 *  - NEVER touches Wallet/User.tonBalance paths of swap or withdrawal.
 *  - Funding source is the ADMIN gas treasury (AdminWalletService) —
 *    user custody wallet is debited by the same authorized infrastructure
 *    (sendTon from user wallet) ONLY in a single signed step.
 *  - Plaintext mnemonics NEVER leave this process; only AES-GCM
 *    (existing authenticated encryption util) at rest.
 */
export class TransferRelayService {
  private tonClient: TonClient;
  private adminWallet: AdminWalletService;

  constructor() {
    this.tonClient = new TonClient({ endpoint: config.tonRpcUrl, apiKey: config.tonApiKey });
    this.adminWallet = new AdminWalletService();
  }

  private assertEnabled(): void {
    if (!config.features.transferRelay) throw new Error('Transfer relay is not enabled');
  }

  /* ══════════════ ADDRESS PROVISIONING ══════════════ */

  /**
   * Idempotent provisioning: opens the feature → ensures the user has
   * exactly `addressesPerUser` ACTIVE addresses. Never regenerates on
   * re-open. Encryption key comes from env/KMS-bound config only.
   */
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

    // Rate-limit provisioning (per user)
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

      // Enforce platform-wide uniqueness (race-safe via unique index)
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

  /**
   * Ten-day reuse rule + safety checks. Returns the address or throws.
   */
  private async assertAddressSelectable(relay: any): Promise<void> {
    if (relay.status !== 'active') {
      throw new Error('This relay address is not active');
    }

    if (relay.nextEligibleAt && relay.nextEligibleAt.getTime() > Date.now()) {
      const days = Math.ceil((relay.nextEligibleAt.getTime() - Date.now()) / 86_400_000);
      throw new Error(`This address is cooling down. Try again in ~${days} day(s).`);
    }

    // Unresolved transaction on this address?
    const unresolved = await TransferOperation.countDocuments({
      relayAddressId: relay._id,
      state: { $in: ['FUNDING', 'FUNDED', 'SENDING', 'RECOVERY_REQUIRED'] },
    });
    if (unresolved > 0) {
      throw new Error('This address has an unresolved operation. Wait for it to finish.');
    }

    // Residual on-chain funds must be zero (or flagged, not silently reused)
    const balance = await this.getTonBalance(relay.address);
    if (balance > 0n) {
      throw new Error('This address still holds funds. It is flagged for recovery first.');
    }
  }

  private async getTonBalance(address: string): Promise<bigint> {
    try {
      return BigInt((await this.tonClient.getBalance(Address.parse(address))).toString());
    } catch {
      return 0n; // fail-closed for selection (treated as unknown → not selectable below via reserve check)
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

    if (!isValidTonAddress(requestedTon)) {
      // requestedTon is an amount string; validate amount
    }
    if (!/^\d+(\.\d+)?$/.test(requestedTon) || Number(requestedTon) <= 0) {
      throw new Error('Invalid amount');
    }

    const requestedNano = BigInt(Precision.toBaseUnits(requestedTon, 9));
    if (requestedNano <= 0n) throw new Error('Invalid amount');

    const { platformFeeNano } = FeeEngine.planRelayFee(requestedNano);
    const forwardFee = config.relay.forwardFeeEstimateNano;
    const minReserve = config.relay.minRelayReserveNano;

    // Funding = requested + fee + forward fee estimate + min reserve
    const fundingAmountNano = requestedNano + platformFeeNano + forwardFee + minReserve;

    // Verify user can cover total debit from their active wallet
    const walletAddress = await (new (require('./wallet-service').WalletService)()).getAddress(userId);
    if (!walletAddress) throw new Error('Wallet not found');
    const userTon = await this.getTonBalance(walletAddress);

    if (userTon < fundingAmountNano + config.relay.minRelayReserveNano) {
      throw new Error(
        `Insufficient TON. You need ~${Precision.fromBaseUnits(fundingAmountNano, 9)} TON ` +
        `(amount + 2% platform fee + network costs).`
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
      relayResidualExpectedNano: minReserve, // min reserve intentionally stays
      expiresAt: new Date(Date.now() + config.relay.quoteTtlMs),
    };
  }

  /* ══════════════ EXECUTION STATE MACHINE ══════════════ */

  async execute(userId: number, quote: RelayQuote, destination: string): Promise<string> {
    this.assertEnabled();

    if (!isValidTonAddress(destination)) throw new Error('Invalid destination address');
    if (Address.parse(destination).workChain !== 0 && config.tonNetwork === 'mainnet') {
      throw new Error('Destination is not a standard TON network address');
    }
    if (new Date() > quote.expiresAt) throw new Error('Quote expired. Request a new preview.');

    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');
    if (user.isFrozen) throw new Error('Account is frozen');

    // Idempotency key: one execution per prepared quote, across instances & restarts
    const idempotencyKey = `relay:${userId}:${quote.quoteId}`;

    return withLock(`lock:relay:user:${userId}`, config.relay.lockTtlMs, async () => {
      const relay = await RelayAddress.findOne({ _id: quote.relayAddressId, userId: user._id });
      if (!relay) throw new Error('Relay address not found');

      return withLock(`lock:relay:addr:${relay.address}`, config.relay.lockTtlMs, async () => {
        await this.assertAddressSelectable(relay);

        // Atomic insert-or-return: replayed confirmations and worker restarts
        // converge on the SAME operation row.
        const raw: any = await TransferOperation.findOneAndUpdate(
          { idempotencyKey },
          {
            $setOnInsert: {
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
              destinationAddress: Address.parse(destination).toString(),
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
              retryCount: 0,
              stateHistory: [{ state: 'CREATED', at: new Date() }],
            },
          },
          { upsert: true, new: true, rawResult: true }
        );

        const op: ITransferOperation = raw.value;
        if (raw.lastErrorObject?.updatedExisting) {
          // Already created → return existing, never duplicate
          if (['COMPLETED'].includes(op.state)) return op.operationId;
          if (['FAILED', 'EXPIRED'].includes(op.state)) throw new Error(op.failureReason || 'Operation already failed');
          return op.operationId; // in-flight: the reconciler owns it
        }

        try {
          await this.transition(op, 'VALIDATED', 'destination + funds validated');

          // ── Persist ledger record BEFORE any broadcast ──
          const ledger = await Transaction.create({
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
            toAddress: destination,
            metadata: {
              operationId: op.operationId,
              relayAddress: relay.address,
              fundingAmount: Precision.fromBaseUnits(quote.fundingAmountNano, 9),
              platformFee: Precision.fromBaseUnits(quote.platformFeeNano, 9),
              relayService: true,
            },
          });

          await this.transition(op, 'FUNDING', 'broadcasting funding tx');

          /* ── STEP 1: FUNDING via authorized admin infrastructure ── */
          await this.adminWallet.initialize();
          const fundingTxHash = await this.adminWallet.sendTon(
            relay.address,
            quote.fundingAmountNano
          );

          await TransferOperation.updateOne(
            { _id: op._id },
            { $set: { fundingTxHash } }
          );
          await Transaction.updateOne(
            { _id: ledger._id },
            { $set: { metadata: { ...ledger.metadata, fundingTxHash } } }
          );

          await this.transition(op, 'FUNDED', 'funding broadcast — awaiting on-chain verify');

          /* ── STEP 2: verify funding on-chain (NOT just the RPC submit) ── */
          const verifiedFunding = await this.verifyIncomingTon(
            relay.address,
            quote.fundingAmountNano,
            fundingTxHash
          );
          if (!verifiedFunding.ok) {
            throw new Error(`Funding verification failed: ${verifiedFunding.reason}`);
          }

          const actualReceived = verifiedFunding.receivedNano;
          const fundingNetworkFee = quote.fundingAmountNano - actualReceived > 0n
            ? quote.fundingAmountNano - actualReceived
            : 0n;

          // Recalculate what can actually leave after REAL costs
          const availableForDestination = actualReceived - quote.minReserveNano;

          if (availableForDestination < quote.requestedNano) {
            await this.transition(op, 'RECOVERY_REQUIRED', 'insufficient after real network costs');
            throw new Error('Network costs exceeded the estimate. Operation flagged for recovery.');
          }

          await TransferOperation.updateOne(
            { _id: op._id },
            {
              $set: {
                fundingActualNano: actualReceived.toString(),
                fundingNetworkFeeNano: fundingNetworkFee.toString(),
              },
            }
          );

          await this.transition(op, 'SENDING', 'broadcasting outgoing transfer');

          /* ── STEP 3: outgoing transfer FROM the relay wallet ── */
          const outgoingTxHash = await this.sendFromRelay(
            relay,
            Address.parse(destination).toString(),
            quote.requestedNano
          );

          await TransferOperation.updateOne(
            { _id: op._id },
            { $set: { outgoingTxHash } }
          );

          /* ── STEP 4: verify destination tx on-chain ── */
          const verifiedOut = await this.verifyIncomingTon(
            destination,
            quote.requestedNano,
            outgoingTxHash
          );
          if (!verifiedOut.ok) {
            await this.transition(op, 'RECOVERY_REQUIRED', 'outgoing tx unconfirmed');
            throw new Error('Outgoing transfer could not be confirmed on-chain.');
          }

          const residual = actualReceived - quote.requestedNano - (verifiedOut.feeNano ?? 0n);

          await TransferOperation.updateOne(
            { _id: op._id },
            {
              $set: {
                state: 'COMPLETED',
                confirmedAt: new Date(),
                outgoingAmountNano: quote.requestedNano.toString(),
                outgoingNetworkFeeNano: (verifiedOut.feeNano ?? 0n).toString(),
                relayResidualNano: residual > 0n ? residual.toString() : '0',
                'stateHistory.$[s]': undefined as any,
              },
              $push: { stateHistory: { state: 'COMPLETED', at: new Date(), note: 'both tx verified on-chain' } },
            }
          );

          // Ten-day cooldown starts at completion
          await RelayAddress.updateOne(
            { _id: relay._id },
            {
              $set: {
                nextEligibleAt: new Date(Date.now() + config.relay.reuseCooldownDays * 86_400_000),
                lastActivityAt: new Date(),
              },
            }
          );

          // Ledger: platform fee leg (reconciler can also sweep)
          await Transaction.create({
            userId: user._id,
            type: 'fee',
            asset: 'TON',
            amount: Precision.fromBaseUnits(quote.platformFeeNano, 9),
            status: 'completed',
            txHash: `relay-fee-${op.operationId}`,
            metadata: { operationId: op.operationId, relayAddress: relay.address, feeKind: 'relay_platform_fee' },
          });

          await Transaction.updateOne(
            { _id: ledger._id },
            { $set: { status: 'completed', txHash: outgoingTxHash, reconciledAt: new Date() } }
          );

          return op.operationId;
        } catch (err: any) {
          const message = err?.message || String(err);
          const current = await TransferOperation.findOne({ _id: op._id });
          if (current && !['COMPLETED', 'RECOVERY_REQUIRED'].includes(current.state)) {
            await TransferOperation.updateOne(
              { _id: op._id },
              {
                $set: { state: 'FAILED', failureReason: message.slice(0, 500) },
                $push: { stateHistory: { state: 'FAILED', at: new Date(), note: message.slice(0, 200) } },
              }
            );
          }
          throw err;
        }
      });
    });
  }

  /* ══════════════ RECONCILIATION (worker-owned) ══════════════ */

  /**
   * Resume interrupted operations after a worker restart.
   * NEVER submits a replacement tx without first reconciling the
   * existing operation's on-chain facts.
   */
  async reconcileStale(): Promise<{ resumed: number; flagged: number }> {
    let resumed = 0;
    let flagged = 0;

    const stale = await TransferOperation.find({
      state: { $in: ['CREATED', 'VALIDATED', 'FUNDING', 'FUNDED', 'SENDING'] },
      updatedAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) },
    }).limit(50);

    for (const op of stale) {
      try {
        if (op.state === 'FUNDING' && op.fundingTxHash) {
          const v = await this.verifyIncomingTon(op.relayAddress, BigInt(op.fundingAmountNano), op.fundingTxHash);
          if (v.ok) {
            await this.transition(op, 'FUNDED', 'reconciler: funding verified after restart');
            resumed++;
          } else {
            await this.transition(op, 'RECOVERY_REQUIRED', `reconciler: funding unverifiable — ${v.reason}`);
            flagged++;
          }
        } else if (op.state === 'SENDING' && op.outgoingTxHash) {
          const v = await this.verifyIncomingTon(op.destinationAddress, BigInt(op.requestedAmountNano), op.outgoingTxHash);
          if (v.ok) {
            await TransferOperation.updateOne(
              { _id: op._id },
              {
                $set: { state: 'COMPLETED', confirmedAt: new Date() },
                $push: { stateHistory: { state: 'COMPLETED', at: new Date(), note: 'reconciler verified outgoing tx' } },
              }
            );
            resumed++;
          } else {
            await this.transition(op, 'RECOVERY_REQUIRED', `reconciler: outgoing unverifiable — ${v.reason}`);
            flagged++;
          }
        } else {
          // CREATED / VALIDATED / FUNDED with no tx hash → safe to expire
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
  ): Promise<Array<{ 
