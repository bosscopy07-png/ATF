import { User } from '../models/User';
import { Transaction } from '../models/Transaction';
import { WalletService } from './wallet-service';

import { Precision } from '../utils/precision';

import {
  config,
  TON_DECIMALS,
  ATF_DECIMALS,
} from '../config';

import {
  isValidTonAddress,
} from '../utils/validation';

import {
  acquireLock,
} from '../utils/distributed-lock';

export interface WithdrawalRequest {
  userId: number;

  asset:
    | 'TON'
    | 'ATF';

  amount: string;

  toAddress: string;
}

export interface WithdrawalPreview {
  asset: string;

  toAddress: string;

  amount: string;

  platformFee: string;

  networkCost: string;

  receiveAmount: string;
}

function provisionalTxHash(
  prefix: string
): string {
  return `${prefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export class WithdrawalService {
  private walletService: WalletService;

  constructor() {
    this.walletService =
      new WalletService();
  }

  /**
   * Per-swap breakdown of company gas still reserved for this
   * EXACT wallet, ordered oldest first.
   */
  private async getOutstandingAdminGasReserveItems(
    userObjectId: any,

    walletAddress: string
  ): Promise<
    Array<{
      swapId: string;

      pendingNano: bigint;

      writtenOffNano: bigint;
    }>
  > {
    const pendingSwaps =
      await Transaction.find({
        userId: userObjectId,

        type: 'swap',

        'metadata.gasRecoveryStatus': {
          $in: [
            'pending',
            'partial',
            'processing',
          ],
        },
      })
        .select(
          'metadata.gasRecoveryWalletAddress ' +
            'metadata.gasRecoveryPendingAmountNano ' +
            'metadata.gasAdvanceAmountNano ' +
            'metadata.gasRecoveredAmountNano ' +
            'metadata.gasRecoveryWrittenOffNano'
        )
        .sort({
          _id: 1,
        })
        .lean();

    const items: Array<{
      swapId: string;

      pendingNano: bigint;

      writtenOffNano: bigint;
    }> = [];

    for (
      const swap of pendingSwaps
    ) {
      const metadata =
        (swap.metadata || {}) as Record<
          string,
          any
        >;

      let recoveryWallet =
        metadata.gasRecoveryWalletAddress as
          | string
          | undefined;

      /**
       * Backward compatibility.
       */
      if (!recoveryWallet) {
        const gasAdvance =
          await Transaction.findOne({
            userId: userObjectId,

            type: 'fee_transfer',

            'metadata.purpose':
              'gas_advance',

            'metadata.swapTxId':
              swap._id.toString(),
          })
            .select(
              'toAddress'
            )
            .lean();

        recoveryWallet =
          gasAdvance?.toAddress ||
          undefined;
      }

      /**
       * Never reserve another wallet's gas.
       */
      if (
        recoveryWallet !==
        walletAddress
      ) {
        continue;
      }

      let pendingNano =
        metadata.gasRecoveryPendingAmountNano !=
        null
          ? BigInt(
              metadata.gasRecoveryPendingAmountNano
            )
          : 0n;

      let writtenOffNano =
        metadata.gasRecoveryWrittenOffNano !=
        null
          ? BigInt(
              metadata.gasRecoveryWrittenOffNano
            )
          : 0n;

      /**
       * Older records may not contain
       * gasRecoveryPendingAmountNano.
       */
      if (
        pendingNano <= 0n &&
        metadata.gasAdvanceAmountNano !=
          null
      ) {
        const advanced =
          BigInt(
            metadata.gasAdvanceAmountNano
          );

        const recovered =
          BigInt(
            metadata.gasRecoveredAmountNano ||
              '0'
          );

        const settled =
          recovered +
          writtenOffNano;

        pendingNano =
          advanced > settled
            ? advanced -
              settled
            : 0n;
      }

      if (
        pendingNano > 0n
      ) {
        items.push({
          swapId:
            swap._id.toString(),

          pendingNano,

          writtenOffNano,
        });
      }
    }

    return items;
  }

  /**
   * Calculate the amount of company gas that is still reserved
   * for this EXACT wallet.
   *
   * This is blockchain-side protection.
   *
   * It does not rely on user.tonBalance because the company gas
   * has already been sent on-chain.
   */
  private async getOutstandingAdminGasReserve(
    userObjectId: any,
    walletAddress: string
  ): Promise<bigint> {
    const items =
      await this.getOutstandingAdminGasReserveItems(
        userObjectId,
        walletAddress
      );

    let totalReserved =
      0n;

    for (
      const item of items
    ) {
      totalReserved +=
        item.pendingNano;
    }

    return totalReserved;
  }

  /**
   * Settle the platform gas reserve that a TON withdrawal would
   * breach by charging the unrecoverable remainder to the user's
   * internal TON balance.
   *
   * Only the breached portion (shortfall) is charged. Recovered
   * amounts are never double-charged: every charged nanoTON is
   * written off in the swap's recovery metadata, so the retry
   * worker can never recover it again.
   *
   * Must be called while holding the wallet lock.
   *
   * Returns the amount charged in nanoTON.
   */
  private async chargeGasReserveShortfall(
    user: any,

    walletAddress: string,

    shortfallNano: bigint
  ): Promise<bigint> {
    if (
      shortfallNano <= 0n
    ) {
      return 0n;
    }

    const items =
      await this.getOutstandingAdminGasReserveItems(
        user._id,
        walletAddress
      );

    let available =
      0n;

    for (
      const item of items
    ) {
      available +=
        item.pendingNano;
    }

    const chargeNano =
      minBigInt(
        shortfallNano,
        available
      );

    if (
      chargeNano <= 0n
    ) {
      return 0n;
    }

    const internalTon =
      BigInt(
        user.tonBalance ||
          '0'
      );

    if (
      internalTon <
      chargeNano
    ) {
      throw new Error(
        `TON withdrawal blocked: ${Precision.fromBaseUnits(
          chargeNano,
          TON_DECIMALS
        )} TON is reserved for pending platform gas recovery and your internal balance cannot cover it. Please wait for the swap gas to be returned or reduce the amount.`
      );
    }

    let remaining =
      chargeNano;

    const settledSwapIds: string[] =
      [];

    const writeOffs: Array<{
      swapTxId: string;

      writtenOffNano: string;
    }> = [];

    /**
     * Oldest first; partially write off the last swap if the
     * shortfall does not cover its full pending amount.
     */
    for (
      const item of items
    ) {
      if (
        remaining <= 0n
      ) {
        break;
      }

      const writeOff =
        minBigInt(
          item.pendingNano,
          remaining
        );

      const newPending =
        item.pendingNano -
        writeOff;

      const newWrittenOff =
        item.writtenOffNano +
        writeOff;

      const newStatus =
        newPending <= 0n
          ? 'completed'
          : 'partial';

      const updated =
        await Transaction.findOneAndUpdate(
          {
            _id:
              item.swapId,

            'metadata.gasRecoveryStatus':
              {
                $in: [
                  'pending',
                  'partial',
                  'processing',
                ],
              },
          },
          {
            $set: {
              'metadata.gasRecoveryPendingAmountNano':
                newPending.toString(),

              'metadata.gasRecoveryWrittenOffNano':
                newWrittenOff.toString(),

              'metadata.gasRecoveryStatus':
                newStatus,

              'metadata.gasRecoveryProcessingAt':
                null,

              'metadata.gasRecoverySettledAt':
                new Date().toISOString(),

              'metadata.gasRecoverySettlementReason':
                'charged_to_user_balance',
            },
          },
          {
            new: true,
          }
        );

      if (!updated) {
        /**
         * Recovery state changed underneath us — skip this
         * swap instead of double-settling it.
         */
        continue;
      }

      settledSwapIds.push(
        item.swapId
      );

      writeOffs.push({
        swapTxId:
          item.swapId,

        writtenOffNano:
          writeOff.toString(),
      });

      remaining -=
        writeOff;
    }

    const totalCharged =
      chargeNano -
      remaining;

    if (
      totalCharged <= 0n
    ) {
      return 0n;
    }

    user.tonBalance =
      Precision.subtract(
        BigInt(
          user.tonBalance ||
            '0'
        ),
        totalCharged
      ).toString();

    await user.save();

    /**
     * Audit the internal settlement.
     */
    await Transaction.create({
      userId:
        user._id,

      type:
        'fee',

      asset:
        'TON',

      amount:
        totalCharged.toString(),

      status:
        'completed',

      toAddress:
        config.adminFeeWalletAddress,

      feeStatus:
        'completed',

      feeWallet:
        config.adminFeeWalletAddress,

      txHash:
        provisionalTxHash(
          'gas-settle'
        ),

      metadata: {
        purpose:
          'gas_reserve_settlement',

        description:
          'Unrecoverable platform gas advance charged to user internal balance during TON withdrawal',

        walletAddress,

        swapTxIds:
          settledSwapIds,

        writeOffs,

        chargedAmountNano:
          totalCharged.toString(),
      },
    });

    console.log(
      `[WithdrawalService] Gas reserve settled by charging user balance: ` +
        `user=${user.telegramId} ` +
        `wallet=${walletAddress} ` +
        `chargedNano=${totalCharged} ` +
        `swaps=${settledSwapIds.length}`
    );

    return totalCharged;
  }

  /**
   * Final live-balance + company-gas-reserve check.
   *
   * This is called immediately before an actual withdrawal.
   *
   * The reserve no longer hard-blocks when the user's internal
   * balance can cover the breached portion — that portion is
   * charged automatically at execution time.
   */
  private async assertWithdrawalFundsAvailable(
    user: any,

    request: WithdrawalRequest,

    walletAddress: string,

    amountBase: bigint,

    liveBalance: bigint
  ): Promise<void> {
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

    /**
     * Only TON can contain the company's temporary
     * TON gas advance.
     */
    if (
      request.asset !== 'TON'
    ) {
      return;
    }

    const adminGasReserve =
      await this.getOutstandingAdminGasReserve(
        user._id,
        walletAddress
      );

    if (
      adminGasReserve <= 0n
    ) {
      return;
    }

    const remainingAfterWithdrawal =
      liveBalance -
      amountBase;

    if (
      remainingAfterWithdrawal <
      adminGasReserve
    ) {
      const shortfall =
        adminGasReserve -
        remainingAfterWithdrawal;

      const internalTon =
        BigInt(
          user.tonBalance ||
            '0'
        );

      if (
        internalTon >=
        shortfall
      ) {
        /**
         * The breached portion will be charged from the
         * user's internal balance at execution time.
         *
         * Not an error.
         */
        return;
      }

      throw new Error(
        `TON withdrawal blocked: ${Precision.fromBaseUnits(
          adminGasReserve,
          TON_DECIMALS
        )} TON is reserved for pending platform gas recovery. Please wait for the swap gas to be returned.`
      );
    }
  }

  async prepareWithdrawal(
    request: WithdrawalRequest
  ): Promise<WithdrawalPreview> {
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

    if (
      !isValidTonAddress(
        request.toAddress
      )
    ) {
      throw new Error(
        'Invalid destination address'
      );
    }

    const decimals =
      request.asset === 'TON'
        ? TON_DECIMALS
        : ATF_DECIMALS;

    const amountBase =
      Precision.toBaseUnits(
        request.amount,
        decimals
      );

    if (
      amountBase <= 0n
    ) {
      throw new Error(
        'Amount must be greater than zero'
      );
    }

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
      request.asset === 'TON'
        ? onChainTon
        : onChainAtf;

    await this.assertWithdrawalFundsAvailable(
      user,
      request,
      walletAddress,
      amountBase,
      liveBalance
    );

    const feeBase =
      Precision.calculateFee(
        amountBase,
        config.platformWithdrawalFeePercent ||
          0
      );

    const networkCostBase =
      request.asset === 'TON'
        ? Precision.toBaseUnits(
            '0.005',
            TON_DECIMALS
          )
        : Precision.toBaseUnits(
            '0.05',
            TON_DECIMALS
          );

    const receiveBase =
      request.asset === 'TON'
        ? Precision.subtract(
            Precision.subtract(
              amountBase,
              feeBase
            ),
            networkCostBase
          )
        : Precision.subtract(
            amountBase,
            feeBase
          );

    if (
      receiveBase <= 0n
    ) {
      throw new Error(
        'Amount too small after platform fee and network costs'
      );
    }

    return {
      asset:
        request.asset,

      toAddress:
        request.toAddress,

      amount:
        request.amount,

      platformFee:
        Precision.fromBaseUnits(
          feeBase,
          decimals
        ),

      networkCost:
        Precision.fromBaseUnits(
          networkCostBase,
          TON_DECIMALS
        ),

      receiveAmount:
        Precision.fromBaseUnits(
          receiveBase,
          decimals
        ),
    };
  }

  /**
   * Execute a withdrawal while holding the SAME distributed wallet lock
   * used by GasRecoveryService.
   */
  async executeWithdrawal(
    request: WithdrawalRequest
  ): Promise<string> {
    const walletAddress =
      await this.walletService.getAddress(
        request.userId
      );

    if (!walletAddress) {
      throw new Error(
        'Wallet not found'
      );
    }

    const walletLock =
      await acquireLock(
        `lock:ton-gas:${walletAddress}`,
        config.gasRecoveryLockTtlMs
      );

    if (!walletLock) {
      throw new Error(
        'This wallet is being processed. Please try the withdrawal again in a moment.'
      );
    }

    try {
      return await this.executeWithdrawalLocked(
        request,
        walletAddress
      );
    } finally {
      await walletLock
        .release()
        .catch(
          () => undefined
        );
    }
  }

  /**
   * Actual withdrawal implementation.
   */
  private async executeWithdrawalLocked(
    request: WithdrawalRequest,

    walletAddress: string
  ): Promise<string> {
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

    const decimals =
      request.asset === 'TON'
        ? TON_DECIMALS
        : ATF_DECIMALS;

    const amountBase =
      Precision.toBaseUnits(
        request.amount,
        decimals
      );

    if (
      amountBase <= 0n
    ) {
      throw new Error(
        'Amount must be greater than zero'
      );
    }

    if (
      !isValidTonAddress(
        request.toAddress
      )
    ) {
      throw new Error(
        'Invalid destination address'
      );
    }

    /**
     * Re-read the blockchain balance WHILE holding the wallet lock.
     */
    const {
      ton: onChainTon,
      atf: onChainAtf,
    } =
      await this.walletService.getBalance(
        walletAddress
      );

    const liveBalance =
      request.asset === 'TON'
        ? onChainTon
        : onChainAtf;

    /* ─────────────────────────────────────────
       GAS-RESERVE SETTLEMENT (TON only)
       ───────────────────────────────────────── */

    if (
      request.asset === 'TON'
    ) {
      const adminGasReserve =
        await this.getOutstandingAdminGasReserve(
          user._id,
          walletAddress
        );

      if (
        adminGasReserve > 0n
      ) {
        const remainingAfterWithdrawal =
          liveBalance -
          amountBase;

        const shortfall =
          remainingAfterWithdrawal <
          adminGasReserve
            ? adminGasReserve -
              remainingAfterWithdrawal
            : 0n;

        if (
          shortfall > 0n
        ) {
          /**
           * Instead of blocking the withdrawal, settle the
           * breached portion by charging the user's internal
           * TON balance and writing off the recovery reserve.
           */
            await this.chargeGasReserveShortfall(
            user,
            walletAddress,
            shortfall
          );
        }
      }
    }

    /**
     * This is the critical protection.
     */
    await this.assertWithdrawalFundsAvailable(
      user,
      request,
      walletAddress,
      amountBase,
      liveBalance
    );

    const feeBase =
      Precision.calculateFee(
        amountBase,
        config.platformWithdrawalFeePercent ||
          0
      );

    const networkCostBase =
      request.asset === 'TON'
        ? Precision.toBaseUnits(
            '0.005',
            TON_DECIMALS
          )
        : Precision.toBaseUnits(
            '0.05',
            TON_DECIMALS
          );

    const sendBase =
      request.asset === 'TON'
        ? Precision.subtract(
            Precision.subtract(
              amountBase,
              feeBase
            ),
            networkCostBase
          )
        : Precision.subtract(
            amountBase,
            feeBase
          );

    if (
      sendBase <= 0n
    ) {
      throw new Error(
        'Amount too small after platform fee and network costs'
      );
    }

    if (
      request.asset === 'TON' &&
      onChainTon < amountBase
    ) {
      throw new Error(
        'On-chain TON balance insufficient. Funds may be pending or already spent.'
      );
    }

    if (
      request.asset === 'ATF' &&
      onChainTon < networkCostBase
    ) {
      throw new Error(
        'Custodial wallet lacks TON for gas. Deposit TON to this wallet first.'
      );
    }

    let tx: any;

    let deducted =
      false;

    try {
      const balanceKey =
        request.asset === 'TON'
          ? 'tonBalance'
          : 'atfBalance';

      user[balanceKey] =
        Precision.subtract(
          BigInt(
            user[balanceKey] ||
              '0'
          ),
          amountBase
        ).toString();

      await user.save();

      deducted =
        true;

      tx =
        await Transaction.create({
          userId:
            user._id,

          type:
            'withdrawal',

          asset:
            request.asset,

          amount:
            amountBase.toString(),

          fee:
            feeBase.toString(),

          feeAsset:
            request.asset,

          feePercentage:
            config.platformWithdrawalFeePercent ||
              0,

          feeWallet:
            config.adminFeeWalletAddress,

          feeStatus:
            'pending',

          status:
            'processing',

          toAddress:
            request.toAddress,

          txHash:
            provisionalTxHash(
              'withdrawal'
            ),

          metadata: {
            requestedAmount:
              request.amount,

            destination:
              request.toAddress,

            platformFee:
              Precision.fromBaseUnits(
                feeBase,
                decimals
              ),

            networkCost:
              Precision.fromBaseUnits(
                networkCostBase,
                TON_DECIMALS
              ),

            sendAmount:
              Precision.fromBaseUnits(
                sendBase,
                decimals
              ),

            gasReserveProtected:
              request.asset ===
              'TON',
          },
        });

      /**
       * 1. Send withdrawal to destination.
       */
      let txHash: string;

      if (
        request.asset ===
        'TON'
      ) {
        txHash =
          await this.walletService.sendTon(
            request.userId,
            request.toAddress,
            sendBase
          );
      } else {
        txHash =
          await this.walletService.sendJetton(
            request.userId,
            request.toAddress,
            config.atfJettonAddress!,
            sendBase
          );
      }

      tx.txHash =
        txHash;

      tx.status =
        'completed';

      await tx.save();

      /**
       * 2. Send platform fee to admin.
       */
      if (
        feeBase > 0n
      ) {
        try {
          let feeTxHash: string;

          if (
            request.asset ===
            'TON'
          ) {
            feeTxHash =
              await this.walletService.sendTon(
                request.userId,
                config.adminFeeWalletAddress,
                feeBase
              );
          } else {
            feeTxHash =
              await this.walletService.sendJetton(
                request.userId,
                config.adminFeeWalletAddress,
                config.atfJettonAddress!,
                feeBase
              );
          }

          tx.feeTxHash =
            feeTxHash;

          tx.feeStatus =
            'completed';

          await tx.save();
        } catch (feeErr) {
          console.error(
            '[WithdrawalService] Fee transfer failed:',
            feeErr
          );

          tx.feeStatus =
            'failed';

          tx.metadata = {
            ...tx.metadata,

            feeError:
              (feeErr as Error)
                .message,
          };

          await tx.save();
        }
      }

      return tx._id.toString();
    } catch (error) {
      const broadcasted =
        tx?.txHash &&
        !tx.txHash.startsWith(
          'withdrawal-'
        );

      /**
       * Only roll back internal balance if the actual blockchain
       * withdrawal was NOT broadcast.
       *
       * NOTE: the gas-reserve settlement charge applied earlier
       * is deliberately NOT rolled back — it settled a real,
       * already-consumed platform gas obligation.
       */
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
            const balanceKey =
              request.asset === 'TON'
                ? 'tonBalance'
                : 'atfBalance';

            currentUser[balanceKey] =
              Precision.add(
                BigInt(
                  currentUser[
                    balanceKey
                  ] || '0'
                ),
                amountBase
              ).toString();

            await currentUser.save();
          }
        } catch (rollbackErr) {
          console.error(
            '[WithdrawalService] Balance rollback failed:',
            rollbackErr
          );
        }
      }

      if (tx) {
        try {
          tx.status =
            'failed';

          tx.metadata = {
            ...tx.metadata,

            error:
              (error as Error)
                .message,

            broadcasted,
          };

          await tx.save();
        } catch {
          // Preserve original withdrawal error.
        }
      }

      throw error;
    }
  }
}

function minBigInt(
  a: bigint,
  b: bigint
): bigint {
  return a < b ? a : b;
            }
