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

export interface SwapRequest {
  userId: number;

  direction:
    | 'ton_to_atf'
    | 'atf_to_ton';

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

function provisionalTxHash(
  prefix: string
): string {
  return `${prefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/* ─────────────────────────────────────────────────────────────
   QUEUE ITEM
   ───────────────────────────────────────────────────────────── */

interface QueuedSwap {
  userId: number;

  confirmation: SwapConfirmation;

  direction:
    | 'ton_to_atf'
    | 'atf_to_ton';

  resolve: (
    value: string
  ) => void;

  reject: (
    reason: any
  ) => void;

  enqueuedAt: number;
}

/* ─────────────────────────────────────────────────────────────
   ATF → TON QUEUE
   ───────────────────────────────────────────────────────────── */

class AtfToTonQueue {
  private queue: QueuedSwap[] = [];

  private isRunning =
    false;

  private adminWallet:
    AdminWalletService;

  private executor:
    (
      userId: number,
      confirmation: SwapConfirmation,
      direction:
        | 'ton_to_atf'
        | 'atf_to_ton'
    ) => Promise<string>;

  constructor(
    executor: (
      userId: number,
      confirmation: SwapConfirmation,
      direction:
        | 'ton_to_atf'
        | 'atf_to_ton'
    ) => Promise<string>
  ) {
    this.adminWallet =
      new AdminWalletService();

    this.executor =
      executor;
  }

  async enqueue(
    userId: number,
    confirmation: SwapConfirmation,
    direction:
      | 'ton_to_atf'
      | 'atf_to_ton'
  ): Promise<string> {
    return new Promise(
      (
        resolve,
        reject
      ) => {
        this.queue.push({
          userId,
          confirmation,
          direction,
          resolve,
          reject,
          enqueuedAt:
            Date.now(),
        });

        this.process();
      }
    );
  }

  private async process() {
    if (this.isRunning) {
      return;
    }

    this.isRunning =
      true;

    try {
      while (
        this.queue.length >
        0
      ) {
        const now =
          Date.now();

        while (
          this.queue.length >
            0 &&
          now -
              this.queue[0]
                .enqueuedAt >
            5 * 60 * 1000
        ) {
          const expired =
            this.queue.shift()!;

          expired.reject(
            new Error(
              'Swap queue timeout. Admin gas treasury busy. Please try again.'
            )
          );
        }

        if (
          this.queue.length ===
          0
        ) {
          break;
        }

        await this.adminWallet.initialize();

        const adminBalance =
          await this.adminWallet.getBalance();

        const firstItem =
          this.queue[0];

        const gasPerSwap =
          firstItem.confirmation
            .gasTon
            ? gasTonToNano(
                firstItem.confirmation
                  .gasTon
              )
            : gasTonToNano(
                '0.3'
              );

        const buffer =
          gasTonToNano(
            '0.05'
          );

        const requiredPerSwap =
          gasPerSwap +
          buffer;

        if (
          adminBalance <
          requiredPerSwap
        ) {
          console.log(
            `[SwapQueue] Admin balance ${Precision.fromBaseUnits(
              adminBalance,
              9
            )} TON < ${Precision.fromBaseUnits(
              requiredPerSwap,
              9
            )} TON required. Waiting...`
          );

          await new Promise(
            r =>
              setTimeout(
                r,
                3000
              )
          );

          continue;
        }

        let batchSize =
          0;

        let totalRequired =
          0n;

        for (
          let i = 0;
          i <
          this.queue.length;
          i++
        ) {
          const itemGas =
            this.queue[i]
              .confirmation
              .gasTon
              ? gasTonToNano(
                  this.queue[i]
                    .confirmation
                    .gasTon!
                )
              : gasPerSwap;

          const itemRequired =
            itemGas +
            buffer;

          if (
            totalRequired +
              itemRequired >
            adminBalance
          ) {
            break;
          }

          totalRequired +=
            itemRequired;

          batchSize++;
        }

        batchSize =
          Math.max(
            1,
            batchSize
          );

        const batch =
          this.queue.splice(
            0,
            batchSize
          );

        console.log(
          `[SwapQueue] Processing batch of ${batchSize} swap(s). Queue remaining: ${this.queue.length}. Admin: ${Precision.fromBaseUnits(
            adminBalance,
            9
          )} TON`
        );

        await Promise.all(
          batch.map(
            async item => {
              try {
                const result =
                  await this.executor(
                    item.userId,
                    item.confirmation,
                    item.direction
                  );

                item.resolve(
                  result
                );
              } catch (err) {
                item.reject(
                  err
                );
              }
            }
          )
        );

        if (
          this.queue.length >
          0
        ) {
          await new Promise(
            r =>
              setTimeout(
                r,
                2000
              )
          );
        }
      }
    } catch (err) {
      console.error(
        '[SwapQueue] Fatal queue error:',
        err
      );
    } finally {
      this.isRunning =
        false;

      if (
        this.queue.length >
        0
      ) {
        this.process();
      }
    }
  }
}

/* ─────────────────────────────────────────────────────────────
   SWAP SERVICE
   ───────────────────────────────────────────────────────────── */

export class SwapService {
  private walletService:
    WalletService;

  private adminWallet:
    AdminWalletService;

  private stonfi:
    STONFiAdapter;

  private priceService:
    PriceService;

  private atfQueue:
    AtfToTonQueue;

  private gasRecovery:
    GasRecoveryService;

  constructor() {
    this.walletService =
      new WalletService();

    this.adminWallet =
      new AdminWalletService();

    this.stonfi =
      new STONFiAdapter();

    this.priceService =
      PriceService.getInstance();

    this.gasRecovery =
      new GasRecoveryService(
        this.walletService
      );

    this.atfQueue =
      new AtfToTonQueue(
        (
          userId,
          confirmation,
          direction
        ) =>
          this.executeSwapDirect(
            userId,
            confirmation,
            direction
          )
      );
  }

  /* ─────────────────────────────────────────────
     PUBLIC SWAP EXECUTION
     ───────────────────────────────────────────── */

  async executeSwap(
    userId: number,

    confirmation: SwapConfirmation,

    direction:
      | 'ton_to_atf'
      | 'atf_to_ton'
  ): Promise<string> {
    await checkRateLimit(
      'swap:execute',
      userId,
      config.swapExecuteRateLimit,
      config.swapExecuteRateWindowMs
    );

    await checkRateLimit(
      'swap:execute',
      userId,
      config.swapExecuteRateLimit,
      config.swapExecuteRateWindowMs
    );

    if (
      !confirmation.confirmationId
    ) {
      throw new Error(
        'Invalid or expired quote. Please request a new quote.'
      );
    }

    return withLock(
      `lock:swap:${userId}`,
      config.swapLockTtlMs,
      async () => {
        const idemKey =
          `swap:${userId}:${confirmation.confirmationId}`;

        const raw: any =
          await SwapIdempotency.findOneAndUpdate(
            {
              key:
                idemKey,
            },
            {
              $setOnInsert: {
                key:
                  idemKey,

                userId,

                confirmationId:
                  confirmation.confirmationId,

                status:
                  'processing',
              },
            },
            {
              upsert:
                true,

              new:
                true,

              rawResult:
                true,
            }
          );

        const alreadyExisted =
          raw?.lastErrorObject
            ?.updatedExisting ===
          true;

        if (
          alreadyExisted
        ) {
          const existing =
            raw.value;

          if (
            existing.status ===
              'completed' &&
            existing.transactionId
          ) {
            return existing.transactionId;
          }

          if (
            existing.status ===
            'processing'
          ) {
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
            direction ===
            'atf_to_ton'
              ? await this.atfQueue.enqueue(
                  userId,
                  confirmation,
                  direction
                )
              : await this.executeSwapDirect(
                  userId,
                  confirmation,
                  direction
                );

          await SwapIdempotency.updateOne(
            {
              key:
                idemKey,
            },
            {
              $set: {
                status:
                  'completed',

                transactionId:
                  txId,

                updatedAt:
                  new Date(),
              },
            }
          );

          return txId;
        } catch (error: any) {
          await SwapIdempotency.updateOne(
            {
              key:
                idemKey,
            },
            {
              $set: {
                status:
                  'failed',

                error:
                  error?.message ||
                  String(error),

                updatedAt:
                  new Date(),
              },
            }
          );

          throw error;
        }
      }
    );
  }

  /* ─────────────────────────────────────────────
     PREPARE QUOTE
     ───────────────────────────────────────────── */

  async prepareSwap(
    request: SwapRequest
  ): Promise<SwapConfirmation> {
    if (
      !config.atfJettonAddress
    ) {
      throw new Error(
        'ATF jetton address not configured'
      );
    }

    await checkRateLimit(
      'swap:prepare',
      request.userId,
      config.swapPrepareRateLimit,
      config.swapPrepareRateWindowMs
    );

    const user =
      await User.findOne({
        telegramId:
          request.userId,
      });

    if (!user) {
      throw new Error(
        'User not found'
      );
    }

    if (user.isFrozen) {
      throw new Error(
        'Account is frozen'
      );
    }

    const isTonToAtf =
      request.direction ===
      'ton_to_atf';

    const inputDecimals =
      isTonToAtf
        ? TON_DECIMALS
        : ATF_DECIMALS;

    const outputDecimals =
      isTonToAtf
        ? ATF_DECIMALS
        : TON_DECIMALS;

    const amountBase =
      Precision.toBaseUnits(
        request.amount,
        inputDecimals
      );

    const walletAddress =
      await this.walletService.getAddress(
        request.userId
      );

    if (!walletAddress) {
      throw new Error(
        'Wallet not found'
      );
    }

    const {
      ton: onChainTon,
      atf: onChainAtf,
    } =
      await this.walletService.getBalance(
        walletAddress
      );

    const liveBalance =
      isTonToAtf
        ? onChainTon
        : onChainAtf;

    if (
      Precision.isLessThan(
        liveBalance,
        amountBase
      )
    ) {
      throw new Error(
        'Insufficient balance'
      );
    }

    const feeBase =
      Precision.calculateFee(
        amountBase,
        config.platformSwapFeePercent
      );

    const netSwapBase =
      Precision.subtract(
        amountBase,
        feeBase
      );

    if (
      isTonToAtf
    ) {
      const minBase =
        Precision.toBaseUnits(
          config.minSwapTon.toString(),
          TON_DECIMALS
        );

      if (
        Precision.isLessThan(
          netSwapBase,
          minBase
        )
      ) {
        throw new Error(
          `Minimum swap amount is ${config.minSwapTon} TON (after fees)`
        );
      }
    } else {
      if (
        netSwapBase <=
        0n
      ) {
        throw new Error(
          'Amount too small after platform fee'
        );
      }
    }

    let gasTon:
      | string
      | undefined;

    if (
      !isTonToAtf
    ) {
      const prelimQuote =
        await this.stonfi.getQuote(
          config.atfJettonAddress,
          'ton',
          netSwapBase.toString(),
          (
            config.maxSlippagePercent /
            100
          ).toString()
        );

      const txParams =
        await this.stonfi.buildSwapTransaction(
          walletAddress,
          prelimQuote,
          config.atfJettonAddress,
          'ton'
        );

      gasTon =
        txParams.gasTon;
    }

    const offerAddress =
      isTonToAtf
        ? 'ton'
        : config.atfJettonAddress;

    const askAddress =
      isTonToAtf
        ? config.atfJettonAddress
        : 'ton';

    const quote =
      await this.stonfi.getQuote(
        offerAddress,
        askAddress,
        netSwapBase.toString(),
        (
          config.maxSlippagePercent /
          100
        ).toString()
      );

    let txParams:
      | any
      | undefined;

    if (
      walletAddress
    ) {
      txParams =
        await this.stonfi.buildSwapTransaction(
          walletAddress,
          quote,
          offerAddress,
          askAddress
        );
    }

    const inputDisplay =
      Precision.fromBaseUnits(
        amountBase,
        inputDecimals
      );

    const feeDisplay =
      Precision.fromBaseUnits(
        feeBase,
        inputDecimals
      );

    const netDisplay =
      Precision.fromBaseUnits(
        netSwapBase,
        inputDecimals
      );

    const outputDisplay =
      Precision.fromBaseUnits(
        BigInt(
          quote.askUnits
        ),
        outputDecimals
      );

    const minOutputDisplay =
      Precision.fromBaseUnits(
        BigInt(
          quote.minAskUnits
        ),
        outputDecimals
      );

    const rateValue =
      parseFloat(
        netDisplay
      ) > 0
        ? parseFloat(
            outputDisplay
          ) /
          parseFloat(
            netDisplay
          )
        : 0;

    const rate =
      isTonToAtf
        ? `1 TON ≈ ${rateValue.toFixed(
            2
          )} ATF`
        : `1 ATF ≈ ${rateValue.toFixed(
            6
          )} TON`;

    return {
      confirmationId:
        crypto.randomUUID(),

      inputAmount:
        inputDisplay,

      platformFee:
        feeDisplay,

      netSwapAmount:
        netDisplay,

      expectedOutput:
        outputDisplay,

      minOutput:
        minOutputDisplay,

      dexCosts:
        Precision.fromBaseUnits(
          BigInt(
            quote.feeUnits ||
              '0'
          ),
          TON_DECIMALS
        ),

      rate,

      expiresAt:
        quote.expiresAt,

      quote,

      txParams,

      gasTon,
    };
  }

  /* ─────────────────────────────────────────────
     DIRECT EXECUTION
     ───────────────────────────────────────────── */

  private async executeSwapDirect(
    userId: number,

    confirmation: SwapConfirmation,

    direction:
      | 'ton_to_atf'
      | 'atf_to_ton'
  ): Promise<string> {
    if (
      !config.atfJettonAddress
    ) {
      throw new Error(
        'ATF jetton address not configured'
      );
    }

    const user =
      await User.findOne({
        telegramId:
          userId,
      });

    if (!user) {
      throw new Error(
        'User not found'
      );
    }

    if (user.isFrozen) {
      throw new Error(
        'Account is frozen'
      );
    }

    if (
      new Date() >
      new Date(
        confirmation.expiresAt
      )
    ) {
      throw new Error(
        'Quote expired. Please request a new quote.'
      );
    }

    const isTonToAtf =
      direction ===
      'ton_to_atf';

    const inputDecimals =
      isTonToAtf
        ? TON_DECIMALS
        : ATF_DECIMALS;

    const amountBase =
      Precision.toBaseUnits(
        confirmation.inputAmount,
        inputDecimals
      );

    const feeBase =
      Precision.calculateFee(
        amountBase,
        config.platformSwapFeePercent
      );

    const balanceKey =
      isTonToAtf
        ? 'tonBalance'
        : 'atfBalance';

    const walletAddress =
      await this.walletService.getAddress(
        userId
      );

    if (!walletAddress) {
      throw new Error(
        'Wallet not found'
      );
    }

    const {
      ton: onChainTon,
      atf: onChainAtf,
    } =
      await this.walletService.getBalance(
        walletAddress
      );

    const liveBalance =
      isTonToAtf
        ? onChainTon
        : onChainAtf;

    if (
      Precision.isLessThan(
        liveBalance,
        amountBase
      )
    ) {
      throw new Error(
        'Insufficient balance'
      );
    }

    let tx: any;

    let deducted =
      false;

    let gasAdvanced =
      false;

    let gasAdvanceTxId:
      | string
      | null =
      null;

    let gasClawbackTxHash:
      | string
      | null =
      null;

    try {
      /**
       * Deduct internal balance before blockchain execution.
       */
      const currentBalance =
        BigInt(
          user[balanceKey] ||
            '0'
        );

      user[balanceKey] =
        Precision.subtract(
          currentBalance,
          amountBase
        ).toString();

      await user.save();

      deducted =
        true;

      /**
       * Create the swap transaction BEFORE the gas advance.
       *
       * This is critical because the swap record is where the
       * gas-recovery audit state is stored.
       */
      tx =
        await Transaction.create({
          userId:
            user._id,

          type:
            'swap',

          asset:
            isTonToAtf
              ? 'TON'
              : 'ATF',

          amount:
            amountBase.toString(),

          fee:
            feeBase.toString(),

          feeAsset:
            isTonToAtf
              ? 'TON'
              : 'ATF',

          feePercentage:
            config.platformSwapFeePercent,

          feeWallet:
            config.adminFeeWalletAddress,

          feeStatus:
            'pending',

          status:
            'processing',

          txHash:
            provisionalTxHash(
              'swap'
            ),

          metadata: {
            swapDirection:
              direction,

            inputAmount:
              confirmation.inputAmount,

            platformFee:
              confirmation.platformFee,

            netSwapAmount:
              confirmation.netSwapAmount,

            expectedOutput:
              confirmation.expectedOutput,

            minOutput:
              confirmation.minOutput,

            slippage:
              config.maxSlippagePercent,

            dexCosts:
              confirmation.dexCosts,

            expiresAt:
              confirmation.expiresAt,

            quote:
              confirmation.quote,

            gasTon:
              confirmation.gasTon,
          },
        });

      /* ─────────────────────────────────────────
         ATF → TON:
         ADMIN ADVANCES GAS
         ───────────────────────────────────────── */

      if (
        !isTonToAtf &&
        confirmation.gasTon
      ) {
        const gasNano =
          gasTonToNano(
            confirmation.gasTon
          );

        await this.adminWallet.initialize();

        const adminBalance =
          await this.adminWallet.getBalance();

        if (
          adminBalance <
          gasNano
        ) {
          throw new Error(
            'Platform gas treasury temporarily low. Please try again later.'
          );
        }

        /**
         * Capture the user's exact TON balance immediately
         * before the company gas is sent.
         */
        const {
          ton:
            preAdvanceBalanceRaw,
        } =
          await this.walletService.getBalance(
            walletAddress
          );

        const preAdvanceBalanceNano =
          BigInt(
            preAdvanceBalanceRaw.toString()
          );

        /**
         * Company sends gas to the EXACT wallet.
         */
        const gasTxHash =
          await this.adminWallet.sendTon(
            walletAddress,
            gasNano
          );

        /**
         * Audit the gas advance.
         */
        const gasTx =
          await Transaction.create({
            userId:
              user._id,

            type:
              'fee_transfer',

            asset:
              'TON',

            amount:
              gasNano.toString(),

            status:
              'completed',

            toAddress:
              walletAddress,

            txHash:
              gasTxHash,

            metadata: {
              purpose:
                'gas_advance',

              description:
                'Gas TON advanced by admin for ATF→TON swap',

              fromAdmin:
                true,

              swapTxId:
                tx._id.toString(),

              walletAddress,
            },
          });

        gasAdvanceTxId =
          gasTx._id.toString();

        gasAdvanced =
          true;

        /**
         * IMPORTANT:
         *
         * Store the EXACT wallet address in the swap's
         * gas-recovery record.
         */
        await this.gasRecovery.recordAdvance({
          swapTransactionId:
            tx._id.toString(),

          walletAddress,

          tonBalanceBeforeGasAdvanceNano:
            preAdvanceBalanceNano,

          gasAdvanceAmountNano:
            gasNano,

          gasAdvanceTxHash:
            gasTxHash,
        });

        /**
         * Give the gas transfer a moment to settle before
         * constructing/broadcasting the swap.
         */
        await new Promise(
          r =>
            setTimeout(
              r,
              3000
            )
        );
      }

      const offerAddress =
        isTonToAtf
          ? 'ton'
          : config.atfJettonAddress;

      const askAddress =
        isTonToAtf
          ? config.atfJettonAddress
          : 'ton';

      const swapParams =
        await this.stonfi.buildSwapTransaction(
          walletAddress,
          confirmation.quote,
          offerAddress,
          askAddress
        );

      /**
       * TON → ATF needs enough TON to execute.
       */
      if (
        isTonToAtf
      ) {
        const {
          ton:
            onChainTonCheck,
        } =
          await this.walletService.getBalance(
            walletAddress
          );

        const requiredTon =
          BigInt(
            swapParams.value.toString()
          );

        if (
          onChainTonCheck <
          requiredTon
        ) {
          throw new Error(
            `Wallet needs ~${Precision.fromBaseUnits(
              requiredTon,
              TON_DECIMALS
            )} TON for this swap (includes gas). Excess is returned. Deposit more TON.`
          );
        }
      }

      /**
       * BROADCAST THE ACTUAL SWAP.
       */
      const txHash =
        await this.walletService.sendTon(
          userId,
          swapParams.to,
          BigInt(
            swapParams.value.toString()
          ),
          swapParams.body
        );

      /**
       * The swap has now actually been broadcast.
       */
      tx.txHash =
        txHash;

      tx.status =
        'completed';

      tx.toAddress =
        swapParams.to;

      tx.metadata = {
        ...tx.metadata,

        swapBroadcasted:
          true,
      };

      await tx.save();

      /* ─────────────────────────────────────────
         SUCCESSFUL ATF → TON GAS RECOVERY
         ───────────────────────────────────────── */

      if (
        !isTonToAtf &&
        gasAdvanced
      ) {
        /**
         * The recovery reserve is already active in the database.
         *
         * Therefore the user cannot withdraw the company's gas
         * during this delay.
         *
         * We wait briefly for the swap output to appear, then
         * immediately attempt recovery.
         *
         * If it is not yet visible, the retry worker continues.
         */
        const swapTransactionId =
          tx._id.toString();

        setTimeout(
          () => {
            this.gasRecovery
              .recoverAdminGasSafely({
                swapTransactionId,

                userId,

                walletAddress,
              })
              .catch(
                err =>
                  console.error(
                    '[SwapService] Post-success gas recovery failed:',
                    err
                  )
              );
          },
          config.postSwapGasRecoveryDelayMs
        );
      }

      /**
       * Platform swap fee.
       *
       * Existing behavior retained.
       */
      this.transferFee(
        userId,
        feeBase,
        isTonToAtf
          ? 'TON'
          : 'ATF',
        tx._id.toString()
      ).catch(
        err =>
          console.error(
            '[SwapService] Fee transfer async error:',
            err
          )
      );

      return tx._id.toString();
    } catch (error) {
      /**
       * Explicit broadcast flag is authoritative.
       */
      const broadcasted =
        tx?.metadata
          ?.swapBroadcasted ===
        true;

      /* ─────────────────────────────────────────
         FAILED ATF → TON BEFORE BROADCAST
         ───────────────────────────────────────── */

      if (
        gasAdvanced &&
        !broadcasted &&
        tx
      ) {
        try {
          const result =
            await this.gasRecovery
              .recoverAdminGasSafely({
                swapTransactionId:
                  tx._id.toString(),

                userId,

                walletAddress,
              });

          gasClawbackTxHash =
            result.txHash ||
            null;

          console.log(
            `[SwapService] Gas recovery for user ${userId} on swap ${tx._id}: ` +
              `status=${result.status}, ` +
              `recovered=${Precision.fromBaseUnits(
                result.totalRecoveredNano,
                TON_DECIMALS
              )} TON, ` +
              `pending=${Precision.fromBaseUnits(
                result.pendingNano,
                TON_DECIMALS
              )} TON` +
              (
                result.skippedReason
                  ? ` (${result.skippedReason})`
                  : ''
              )
          );
        } catch (
          recoveryErr: any
        ) {
          console.error(
            `[SwapService] Gas recovery FAILED for user ${userId}:`,
            recoveryErr
          );
        }
      }

      /* ─────────────────────────────────────────
         ROLLBACK INTERNAL BALANCE
         ───────────────────────────────────────── */

      if (
        deducted &&
        !broadcasted
      ) {
        try {
          const currentUser =
            await User.findById(
              user._id
            );

          if (currentUser) {
            currentUser[
              balanceKey
            ] =
              Precision.add(
                BigInt(
                  currentUser[
                    balanceKey
                  ] || '0'
                ),
                amountBase
              ).toString();

            await currentUser.save();

            console.log(
              `[SwapService] Rollback complete: restored ${Precision.fromBaseUnits(
                amountBase,
                inputDecimals
              )} ${
                isTonToAtf
                  ? 'TON'
                  : 'ATF'
              } (includes ${Precision.fromBaseUnits(
                feeBase,
                inputDecimals
              )} fee) to user ${userId}`
            );
          }
        } catch (
          rollbackErr
        ) {
          console.error(
            '[SwapService] Balance rollback failed:',
            rollbackErr
          );
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
          const latest =
            await Transaction.findById(
              tx._id
            );

          if (latest) {
            latest.status =
              'failed';

            latest.metadata = {
              ...latest.metadata,

              error:
                (error as Error)
                  .message,

              broadcasted,

              gasAdvanceTxId:
                gasAdvanceTxId ||
                undefined,

              gasClawbackTxHash:
                gasClawbackTxHash ||
                undefined,

              gasRecoveryAttempted:
                gasAdvanced &&
                !broadcasted,
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

    asset:
      | 'TON'
      | 'ATF',

    swapTxId: string
  ): Promise<void> {
    try {
      const user =
        await User.findOne({
          telegramId:
            userId,
        });

      if (!user) {
        return;
      }

      const feeTx =
        await Transaction.create({
          userId:
            user._id,

          type:
            'fee',

          asset,

          amount:
            feeAmount.toString(),

          status:
            'processing',

          toAddress:
            config.adminFeeWalletAddress,

          txHash:
            provisionalTxHash(
              'fee'
            ),

          metadata: {
            swapTxId,
          },
        });

      let txHash: string;

      if (
        asset === 'TON'
      ) {
        txHash =
          await this.walletService.sendTon(
            userId,
            config.adminFeeWalletAddress,
            feeAmount
          );
      } else {
        txHash =
          await this.walletService.sendJetton(
            userId,
            config.adminFeeWalletAddress,
            config.atfJettonAddress!,
            feeAmount
          );
      }

      feeTx.txHash =
        txHash;

      feeTx.status =
        'completed';

      await feeTx.save();

      await Transaction.findByIdAndUpdate(
        swapTxId,
        {
          feeStatus:
            'completed',

          feeTxHash:
            txHash,
        }
      );
    } catch (error) {
      console.error(
        '[SwapService] Fee transfer failed:',
        error
      );
    }
  }
}
