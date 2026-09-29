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
            'metadata.gasRecoveredAmountNano'
        )
        .lean();

    let totalReserved =
      0n;

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

        pendingNano =
          advanced > recovered
            ? advanced - recovered
            : 0n;
      }

      if (
        pendingNano > 0n
      ) {
        totalReserved +=
          pendingNano;
      }
    }

    return totalReserved;
  }

  /**
   * Final live-balance + company-gas-reserve check.
   *
   * This is called immediately before an actual withdrawal.
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

    /**
     * The withdrawal must leave enough TON in the wallet
     * for the pending company-gas recovery.
     */
    if (
      remainingAfterWithdrawal <
      adminGasReserve
    ) {
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
