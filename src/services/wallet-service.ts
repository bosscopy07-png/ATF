import {
  mnemonicNew,
  mnemonicToWalletKey,
  KeyPair,
} from '@ton/crypto';

import {
  WalletContractV4,
  WalletContractV5R1,
  TonClient,
  internal,
  Address,
  Cell,
  beginCell,
  toNano,
  SendMode,
  JettonMaster,
  JettonWallet,
} from '@ton/ton';

import { storeMessage } from '@ton/core';
import { encrypt, decrypt } from '../utils/encryption';
import { Wallet, IWallet } from '../models/Wallet';
import { User } from '../models/User';
import { config } from '../config';

/**
 * Thrown when a broadcast's on-chain outcome cannot be determined: the
 * provider returned an uncertain-class error (HTTP 5xx / timeout /
 * connection reset / aborted request) and the wallet seqno did not
 * advance within the bounded verification window.
 *
 * ERROR CONTRACT (for the unmodified callers):
 *  - code: 'BROADCAST_OUTCOME_UNKNOWN'
 *  - The transaction MAY still land on-chain at any time.
 *  - Callers must keep the operation pending, reconcile on-chain, and
 *    MUST NOT auto-refund, auto-fail, or auto-resubmit.
 *  - The message intentionally contains 'timed out' and the HTTP status
 *    so the existing uncertainty regexes in swap-service and
 *    fee-collection-service classify it correctly without modification.
 *  - Never carries mnemonics, keys, API keys, or signed payloads.
 */
export class BroadcastOutcomeUnknownError extends Error {
  readonly code = 'BROADCAST_OUTCOME_UNKNOWN' as const;

  constructor(
    message: string,
    readonly walletAddress: string,
    readonly seqno: number,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = 'BroadcastOutcomeUnknownError';
  }
}

interface BroadcastErrorInfo {
  uncertain: boolean;
  httpStatus?: number;
  bodySnippet: string;
}

/**
 * Classify a broadcast failure.
 *
 * Uncertain (outcome unknown — the node may have accepted the BoC before
 * the response failed): HTTP 5xx, timeouts, connection resets/aborts.
 *
 * Everything else (4xx validation errors, insufficient funds, wallet
 * mismatch, bad request) is a VERIFIED pre-submission rejection: the
 * message never reached the chain and callers may safely treat it as
 * failed. Never log secrets here — only status + a bounded body snippet.
 */
function classifyBroadcastError(error: any): BroadcastErrorInfo {
  const msg = error?.message || String(error);

  const httpStatus: number | undefined =
    typeof error?.response?.status === 'number'
      ? error.response.status
      : undefined;

  let bodySnippet = '';
  try {
    const data = error?.response?.data;
    bodySnippet = (typeof data === 'string' ? data : JSON.stringify(data))
      ?.slice(0, 300) || '';
  } catch {
    // ignore
  }

  const messageUncertain =
    /HTTP 5\d\d|500|502|503|504|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|aborted|socket|fetch failed/i.test(
      msg
    );

  const statusUncertain = httpStatus !== undefined && httpStatus >= 500;

  return {
    uncertain: messageUncertain || statusUncertain,
    httpStatus,
    bodySnippet,
  };
}

/**
 * Supported wallet contracts.
 *
 * V4R2 and V5R1 can be generated from the same mnemonic/public key,
 * but they produce different addresses.
 */
export type WalletVersion = 'v4r2' | 'v5r1';

export interface DerivedWallet {
  version: WalletVersion;
  address: string;
  keyPair: KeyPair;
  contract: WalletContractV4 | WalletContractV5R1;
  balance: bigint;
  hasTransactions: boolean;
  deployed: boolean;
}

export interface ISigner {
  getAddress(
    publicKey: Buffer,
    version?: WalletVersion
  ): string;

  signTransfer(
    wallet:
      | WalletContractV4
      | WalletContractV5R1,
    seqno: number,
    secretKey: Buffer,
    messages: any[]
  ): Cell;
}

/**
 * Default local signer.
 *
 * IMPORTANT:
 * The signer must use the SAME wallet contract version that generated
 * the address.
 */
class LocalSigner implements ISigner {
  getAddress(
    publicKey: Buffer,
    version: WalletVersion = 'v4r2'
  ): string {
    if (version === 'v5r1') {
      const wallet = WalletContractV5R1.create({
        publicKey,
        workchain: 0,
        walletId: {
          networkGlobalId:
            process.env.TON_NETWORK === 'testnet'
              ? -3
              : -239,
        },
      });

      return wallet.address.toString({
        bounceable: false,
      });
    }

    const wallet = WalletContractV4.create({
      publicKey,
      workchain: 0,
      walletId: 0x29a9a317,
    });

    return wallet.address.toString({
      bounceable: false,
    });
  }

  signTransfer(
    wallet:
      | WalletContractV4
      | WalletContractV5R1,
    seqno: number,
    secretKey: Buffer,
    messages: any[]
  ): Cell {
    if (wallet instanceof WalletContractV5R1) {
      return wallet.createTransfer({
        seqno,
        secretKey,
        messages,
        sendMode:
          SendMode.PAY_GAS_SEPARATELY,
        timeout: Math.floor(Date.now() / 1000) + 60,
      });
    }

    return wallet.createTransfer({
      seqno,
      secretKey,
      messages,
    });
  }
}

export class WalletService {
  private client: TonClient;
  private signer: ISigner;

  /**
   * TON mainnet:
   *   -239
   *
   * TON testnet:
   *   -3
   */
  private readonly v5NetworkGlobalId: number;

  /**
   * FIX E: rpcProfile selects which endpoint/API key this instance uses.
   * 'swap'  — swap execution path
   * 'fee'   — fee collection + gas recovery
   * default — deposit monitor, withdraws, everything else (unchanged)
   */
  constructor(
    signer?: ISigner,
    rpcProfile: 'default' | 'swap' | 'fee' = 'default'
  ) {
    const endpoint =
      rpcProfile === 'swap'
        ? config.tonRpcUrlSwap
        : rpcProfile === 'fee'
          ? config.tonRpcUrlFee
          : config.tonRpcUrl;

    const apiKey =
      rpcProfile === 'swap'
        ? config.tonApiKeySwap
        : rpcProfile === 'fee'
          ? config.tonApiKeyFee
          : config.tonApiKey;

    this.client = new TonClient({
      endpoint,
      apiKey,
    });

    this.signer = signer || new LocalSigner();

    this.v5NetworkGlobalId =
      process.env.TON_NETWORK === 'testnet'
        ? -3
        : -239;
  }

  // ===========================================================================
  // WALLET CONTRACT CREATION
  // ===========================================================================

  /**
   * Create a V4R2 contract from a keypair.
   */
  private createV4Wallet(
    publicKey: Buffer
  ): WalletContractV4 {
    return WalletContractV4.create({
      publicKey,
      workchain: 0,
      walletId: 0x29a9a317,
    });
  }

  /**
   * Create a V5R1 / W5 contract from a keypair.
   */
  private createV5Wallet(
    publicKey: Buffer
  ): WalletContractV5R1 {
    return WalletContractV5R1.create({
      publicKey,
      workchain: 0,
      walletId: {
        networkGlobalId: this.v5NetworkGlobalId,
      },
    });
  }

  /**
   * Create the correct contract for a wallet version.
   */
  private createWalletContract(
    publicKey: Buffer,
    version: WalletVersion
  ): WalletContractV4 | WalletContractV5R1 {
    if (version === 'v5r1') {
      return this.createV5Wallet(publicKey);
    }

    return this.createV4Wallet(publicKey);
  }

  // ===========================================================================
  // ADDRESS DERIVATION
  // ===========================================================================

  /**
   * Derive an address for a specific wallet version.
   */
  getAddressFromKeyPair(
    keyPair: KeyPair,
    version: WalletVersion
  ): string {
    const wallet = this.createWalletContract(
      keyPair.publicKey,
      version
    );

    return wallet.address.toString({
      bounceable: false,
    });
  }

  /**
   * Derive BOTH V4 and W5 addresses from one mnemonic.
   *
   * This is the important fix for your Tonkeeper import problem.
   */
  async deriveAllWallets(
    mnemonicPhrase: string
  ): Promise<{
    v4: DerivedWallet;
    v5: DerivedWallet;
  }> {
    const words = this.normalizeMnemonic(mnemonicPhrase);

    const keyPair = await mnemonicToWalletKey(words);

    const v4Contract = this.createV4Wallet(
      keyPair.publicKey
    );

    const v5Contract = this.createV5Wallet(
      keyPair.publicKey
    );

    const v4Address = v4Contract.address.toString({
      bounceable: false,
    });

    const v5Address = v5Contract.address.toString({
      bounceable: false,
    });

    const [v4Info, v5Info] = await Promise.all([
      this.inspectAddress(v4Address),
      this.inspectAddress(v5Address),
    ]);

    return {
      v4: {
        version: 'v4r2',
        address: v4Address,
        keyPair,
        contract: v4Contract,
        ...v4Info,
      },

      v5: {
        version: 'v5r1',
        address: v5Address,
        keyPair,
        contract: v5Contract,
        ...v5Info,
      },
    };
  }

  // ===========================================================================
  // ADDRESS INSPECTION / AUTOMATIC DETECTION
  // ===========================================================================

  /**
   * Inspect an address to determine whether it appears to be an
   * existing/used wallet.
   */
  private async inspectAddress(
    address: string
  ): Promise<{
    balance: bigint;
    hasTransactions: boolean;
    deployed: boolean;
  }> {
    try {
      const parsed = Address.parse(address);

      const balance =
        await this.client.getBalance(parsed);

      let hasTransactions = false;

      try {
        const transactions =
          await this.client.getTransactions(parsed, {
            limit: 1,
          });

        hasTransactions = transactions.length > 0;
      } catch {
        // Some providers can return balance successfully
        // while transaction history is temporarily unavailable.
      }

      let deployed = false;

      try {
        const state =
          await this.client.getContractState(parsed);

        deployed =
          state.state === 'active';
      } catch {
        // Ignore state lookup failure.
      }

      return {
        balance,
        hasTransactions,
        deployed,
      };
    } catch {
      return {
        balance: 0n,
        hasTransactions: false,
        deployed: false,
      };
    }
  }
    /**
   * Automatically determine which wallet version is actually being used.
   *
   * Rules:
   *
   * 1. If only V4 has activity -> V4
   * 2. If only V5 has activity -> V5
   * 3. If both have activity -> require explicit choice
   * 4. If neither has activity -> default to V5 because current
   *    Tonkeeper W5 wallets are commonly V5, but this should be
   *    treated as an unused wallet.
   */
  async detectWalletVersion(
    mnemonicPhrase: string
  ): Promise<{
    version: WalletVersion;
    address: string;
    v4: DerivedWallet;
    v5: DerivedWallet;
  }> {
    const wallets =
      await this.deriveAllWallets(mnemonicPhrase);

    const v4Used =
      wallets.v4.balance > 0n ||
      wallets.v4.hasTransactions ||
      wallets.v4.deployed;

    const v5Used =
      wallets.v5.balance > 0n ||
      wallets.v5.hasTransactions ||
      wallets.v5.deployed;

    if (v4Used && !v5Used) {
      return {
        version: 'v4r2',
        address: wallets.v4.address,
        ...wallets,
      };
    }

    if (v5Used && !v4Used) {
      return {
        version: 'v5r1',
        address: wallets.v5.address,
        ...wallets,
      };
    }

    if (v4Used && v5Used) {
      throw new Error(
        [
          'Both V4R2 and V5R1 wallets were found for this seed phrase.',
          '',
          `V4R2: ${wallets.v4.address}`,
          `V5R1: ${wallets.v5.address}`,
          '',
          'Please select which wallet you want to import.',
        ].join('\n')
      );
    }

    /**
     * No activity.
     *
     * Default to V5 because that is the wallet version the user
     * is most likely expecting when importing a modern Tonkeeper W5 wallet.
     */
    return {
      version: 'v5r1',
      address: wallets.v5.address,
      ...wallets,
    };
  }

  // ===========================================================================
  // MNEMONIC HELPERS
  // ===========================================================================

  private normalizeMnemonic(
    mnemonicPhrase: string
  ): string[] {
    const words = mnemonicPhrase
      .trim()
      .toLowerCase()
      .split(/\s+/);

    if (words.length !== 24) {
      throw new Error(
        'Invalid mnemonic: must contain exactly 24 words'
      );
    }

    return words;
  }

  private mnemonicToString(
    words: string[]
  ): string {
    return words.join(' ');
  }

  // ===========================================================================
  // CREATE WALLET
  // ===========================================================================

  /**
   * Create a brand-new V5 wallet.
   *
   * You can change this to V4 if you want newly-created wallets
   * to remain V4, but I recommend moving new wallets to V5.
   */
  async createWallet(
    userId: number
  ): Promise<IWallet> {
    const user = await User.findOne({
      telegramId: userId,
    });

    if (!user) {
      throw new Error('User not found');
    }

    const mnemonic =
      await mnemonicNew(24);

    const keyPair =
      await mnemonicToWalletKey(mnemonic);

    /**
     * New wallets use V5R1.
     */
    const version: WalletVersion = 'v5r1';

    const address =
      this.getAddressFromKeyPair(
        keyPair,
        version
      );

    const {
      encrypted,
      iv,
      tag,
    } = encrypt(
      this.mnemonicToString(mnemonic)
    );

    return Wallet.create({
      userId: user._id,
      address,
      encryptedMnemonic: encrypted,
      iv,
      tag,
      isImported: false,
      walletVersion: version,
    });
  }

  // ===========================================================================
  // IMPORT WALLET
  // ===========================================================================

  /**
   * Import wallet.
   *
   * If walletVersion is omitted, V4/V5 are automatically checked.
   *
   * Example:
   *
   * await importWallet(userId, phrase);
   *
   * OR:
   *
   * await importWallet(userId, phrase, 'v5r1');
   */
  async importWallet(
    userId: number,
    mnemonicPhrase: string,
    walletVersion?: WalletVersion
  ): Promise<IWallet> {
    const user = await User.findOne({
      telegramId: userId,
    });

    if (!user) {
      throw new Error('User not found');
    }

    const words =
      this.normalizeMnemonic(
        mnemonicPhrase
      );

    const normalizedMnemonic =
      this.mnemonicToString(words);

    const keyPair =
      await mnemonicToWalletKey(words);

    let version: WalletVersion;

    if (walletVersion) {
      version = walletVersion;
    } else {
      const detected =
        await this.detectWalletVersion(
          normalizedMnemonic
        );

      version = detected.version;
    }

    const address =
      this.getAddressFromKeyPair(
        keyPair,
        version
      );

    const {
      encrypted,
      iv,
      tag,
    } = encrypt(normalizedMnemonic);

    /**
     * IMPORTANT:
     *
     * This always creates a NEW wallet document.
     * Existing imported/created wallets are not overwritten.
     */
    return Wallet.create({
      userId: user._id,
      address,
      encryptedMnemonic: encrypted,
      iv,
      tag,
      isImported: true,
      walletVersion: version,
    });
  }

  // ===========================================================================
  // WALLET LOOKUP
  // ===========================================================================

  async getWallet(
    userId: number
  ): Promise<IWallet | null> {
    const user = await User.findOne({
      telegramId: userId,
    });

    if (!user) {
      return null;
    }

    /**
     * First use explicitly selected active wallet.
     */
    if (user.activeWalletId) {
      const active =
        await Wallet.findById(
          user.activeWalletId
        );

      if (active) {
        return active;
      }
    }

    /**
     * Fallback to newest wallet.
     */
    return Wallet.findOne({
      userId: user._id,
    }).sort({
      createdAt: -1,
    });
  }

  async getWallets(
    userId: number
  ): Promise<IWallet[]> {
    const user = await User.findOne({
      telegramId: userId,
    });

    if (!user) {
      return [];
    }

    return Wallet.find({
      userId: user._id,
    }).sort({
      createdAt: 1,
    });
  }

  async getWalletById(
    walletId: string
  ): Promise<IWallet | null> {
    return Wallet.findById(walletId);
  }

  // ===========================================================================
  // KEYPAIR
  // ===========================================================================

  /**
   * Get keypair for a specific wallet document.
   */
  async getKeyPair(
    userId: number
  ): Promise<KeyPair> {
    const wallet =
      await this.getWallet(userId);

    if (!wallet) {
      throw new Error('Wallet not found');
    }

    return this.getKeyPairForWallet(
      wallet
    );
  }

  private async getKeyPairForWallet(
    wallet: IWallet
  ): Promise<KeyPair> {
    const mnemonicPhrase =
      decrypt(
        wallet.encryptedMnemonic,
        wallet.iv,
        wallet.tag
      );

    const words =
      this.normalizeMnemonic(
        mnemonicPhrase
      );

    return mnemonicToWalletKey(words);
  }

  // ===========================================================================
  // WALLET VERSION RECOVERY
  // ===========================================================================

  /**
   * Existing wallet documents created before walletVersion was added
   * will have no version.
   *
   * This method tries to determine their version from the address.
   */
  private async getWalletVersion(
    wallet: IWallet,
    keyPair: KeyPair
  ): Promise<WalletVersion> {
    const storedVersion =
      (wallet as any).walletVersion as
        | WalletVersion
        | undefined;

    if (
      storedVersion === 'v4r2' ||
      storedVersion === 'v5r1'
    ) {
      return storedVersion;
    }

    /**
     * Backward compatibility for your old V4-only database.
     */
    const v4Address =
      this.getAddressFromKeyPair(
        keyPair,
        'v4r2'
      );

    const v5Address =
      this.getAddressFromKeyPair(
        keyPair,
        'v5r1'
      );

    const storedAddress =
      Address.parse(wallet.address)
        .toString({
          bounceable: false,
        });

    if (
      storedAddress ===
      Address.parse(v4Address).toString({
        bounceable: false,
      })
    ) {
      return 'v4r2';
    }

    if (
      storedAddress ===
      Address.parse(v5Address).toString({
        bounceable: false,
      })
    ) {
      return 'v5r1';
    }

    throw new Error(
      'Unable to determine wallet version from stored address'
    );
  }

  // ===========================================================================
  // BALANCES
  // ===========================================================================

  /** Strict on-chain TON balance read for money-recovery paths.
   * Unlike getBalance(), this never converts an RPC failure into zero.
   */
  async getTonBalanceStrict(address: string): Promise<bigint> {
    return this.client.getBalance(Address.parse(address));
  }

  /** Strict balance read used by reconciliation/recovery.
   * RPC failures are thrown instead of being converted to zero.
   */
  async getBalanceStrict(
    address: string
  ): Promise<{
    ton: bigint;
    atf: bigint;
  }> {
    const ton = await this.client.getBalance(Address.parse(address));

    const jettonMaster = this.client.open(
      JettonMaster.create(Address.parse(config.atfJettonAddress))
    );
    const jettonWalletAddress = await jettonMaster.getWalletAddress(Address.parse(address));
    const jettonWallet = this.client.open(JettonWallet.create(jettonWalletAddress));
    const atf = await jettonWallet.getBalance();

    return { ton, atf };
  }

  async getBalance(
    address: string
  ): Promise<{
    ton: bigint;
    atf: bigint;
  }> {
    let tonBalance = 0n;
    let atfBalance = 0n;

    try {
      tonBalance =
        await this.client.getBalance(
          Address.parse(address)
        );
    } catch (error) {
      console.error(
        'Failed to fetch TON balance:',
        error
      );
    }

    try {
      const jettonMaster =
        this.client.open(
          JettonMaster.create(
            Address.parse(
              config.atfJettonAddress
            )
          )
        );

      const jettonWalletAddress =
        await jettonMaster.getWalletAddress(
          Address.parse(address)
        );

      const jettonWallet =
        this.client.open(
          JettonWallet.create(
            jettonWalletAddress
          )
        );

      atfBalance =
        await jettonWallet.getBalance();
    } catch {
      /**
       * Jetton wallet may not be deployed yet.
       */
      atfBalance = 0n;
    }

    return {
      ton: tonBalance,
      atf: atfBalance,
    };
  }

  // ===========================================================================
  // WALLET CONTRACT FOR USER
  // ===========================================================================

  private async getWalletContext(
    userId: number
  ): Promise<{
    walletDoc: IWallet;
    keyPair: KeyPair;
    version: WalletVersion;
    contract:
      | WalletContractV4
      | WalletContractV5R1;
  }> {
    const walletDoc =
      await this.getWallet(userId);

    if (!walletDoc) {
      throw new Error(
        'Wallet not found'
      );
    }

    const keyPair =
      await this.getKeyPairForWallet(
        walletDoc
      );

    const version =
      await this.getWalletVersion(
        walletDoc,
        keyPair
      );

    const contract =
      this.createWalletContract(
        keyPair.publicKey,
        version
      );

    /**
     * Safety check.
     *
     * The address derived from the stored mnemonic/version
     * MUST match the address saved in MongoDB.
     */
    const derivedAddress =
      contract.address.toString({
        bounceable: false,
      });

    const storedAddress =
      Address.parse(walletDoc.address)
        .toString({
          bounceable: false,
        });

    if (
      derivedAddress !== storedAddress
    ) {
      throw new Error(
        [
          'Wallet address mismatch.',
          `Stored: ${storedAddress}`,
          `Derived: ${derivedAddress}`,
          `Version: ${version}`,
        ].join('\n')
      );
    }

      /**
     * Persist version for old V4 wallets.
     */
    if (
      (walletDoc as any).walletVersion !==
      version
    ) {
      await Wallet.findByIdAndUpdate(
        walletDoc._id,
        {
          $set: {
            walletVersion: version,
          },
        }
      );
    }

    return {
      walletDoc,
      keyPair,
      version,
      contract,
    };
  }
    // ===========================================================================
  // SEND TON
  // ===========================================================================

  async sendTon(
    userId: number,
    toAddress: string,
    amount: bigint,
    body?: Cell | string
  ): Promise<string> {
    const wallet = await this.getWallet(userId);
    if (!wallet) throw new Error('Wallet not found');
    return this.sendTonFromWalletAddress(
      wallet.address,
      toAddress,
      amount,
      body
    );
  }

  /**
   * Send TON from one exact stored wallet address.
   *
   * This exists specifically for recovery/settlement flows. Those flows
   * must never resolve the user's current active wallet because the wallet
   * that received the platform advance may no longer be active.
   */
  async sendTonFromWalletAddress(
    walletAddress: string,
    toAddress: string,
    amount: bigint,
    body?: Cell | string
  ): Promise<string> {
    if (amount <= 0n) {
      throw new Error('TON amount must be greater than zero');
    }

    const walletDoc = await Wallet.findOne({
      address: walletAddress,
    });

    if (!walletDoc) {
      throw new Error(`Wallet not found for address ${walletAddress}`);
    }

    const keyPair = await this.getKeyPairForWallet(walletDoc);
    const version = await this.getWalletVersion(walletDoc, keyPair);
    const contract = this.createWalletContract(keyPair.publicKey, version);

    const derivedAddress = contract.address.toString({ bounceable: false });
    const storedAddress = Address.parse(walletDoc.address).toString({ bounceable: false });

    if (derivedAddress !== storedAddress) {
      throw new Error(
        `Wallet address mismatch. Stored=${storedAddress} Derived=${derivedAddress} Version=${version}`
      );
    }

    const destination = Address.parse(toAddress);
    const opened = this.client.open(contract);

    /**
     * SAFE SEQNO RESOLUTION: the contract state is verified on-chain
     * first; seqno 0 is only used when the RPC confirms the wallet is
     * uninitialized. An RPC outage is never treated as proof of an
     * undeployed wallet. The deployment decision returned here is the
     * SINGLE source of truth for whether the external message carries
     * the contract init (see buildExternalMessage).
     */
    const { seqno, deployed } = await this.resolveSeqno(opened, walletDoc.address);

    const message = internal({
      to: destination,
      value: amount,
      bounce: false,
      body,
    });

    let transfer: Cell;

    if (version === 'v5r1') {
      transfer = (contract as WalletContractV5R1).createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [message],
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        timeout: Math.floor(Date.now() / 1000) + 60,
      });
    } else {
      transfer = (contract as WalletContractV4).createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [message],
      });
    }

    /**
     * BROADCAST-OUTCOME HANDLING:
     *
     * An HTTP 5xx / timeout / connection reset does NOT prove the message
     * failed — the node may have accepted the BoC before the response
     * broke. Verified pre-submission rejections (4xx, validation,
     * insufficient funds) propagate unchanged so callers may safely treat
     * them as failed.
     *
     * On an UNCERTAIN error: poll the wallet seqno (bounded). If it
     * advanced past the pre-broadcast seqno, the message was consumed —
     * return the reconciler-compatible "address_seqno" tracking reference
     * (only ever returned when seqno advancement was established). If the
     * seqno never advanced, throw BroadcastOutcomeUnknownError (code
     * BROADCAST_OUTCOME_UNKNOWN). We never fabricate a hash, never
     * auto-retry a potentially-submitted message, and never report a
     * definitive failure merely because indexing lagged.
     */
    try {
      await this.client.sendMessage(
        this.buildExternalMessage(contract, walletDoc.address, deployed, transfer)
      );
    } catch (error: any) {
      const info = classifyBroadcastError(error);

      /**
       * Diagnostics: surface the HTTP status + response body (truncated;
       * never contains keys, mnemonics, or the signed payload).
       */
      if (info.httpStatus || info.bodySnippet) {
        console.error(
          `[WalletService] Broadcast rejected by endpoint` +
          (info.httpStatus ? ` (HTTP ${info.httpStatus})` : '') +
          (info.bodySnippet ? `: ${info.bodySnippet}` : '')
        );
      }

      if (!info.uncertain) {
        throw error; // verified pre-submission rejection — safe to treat as failed
      }

      console.warn(
        `[WalletService] Uncertain broadcast outcome for ${walletAddress}` +
        (info.httpStatus ? ` (HTTP ${info.httpStatus})` : '') +
        `. Checking wallet seqno to classify...`
      );

      const consumed = await this.waitForSeqnoAdvance(opened, seqno, 10, 1500);

      if (consumed) {
        console.warn(
          `[WalletService] Seqno advanced — message WAS consumed on-chain despite the error. ` +
          `Returning tracking reference for reconciliation.`
        );
        return `${Address.parse(walletDoc.address).toString({ bounceable: false })}_${seqno}`;
      }

      throw new BroadcastOutcomeUnknownError(
        `Broadcast outcome unknown: endpoint returned an uncertain error` +
        (info.httpStatus ? ` (HTTP ${info.httpStatus})` : '') +
        ` and the wallet seqno did not advance before the verification window timed out. ` +
        `The transaction may still land on-chain — keep the operation pending and reconcile.`,
        walletDoc.address,
        seqno,
        info.httpStatus
      );
    }

    return this.waitForTransaction(opened, walletDoc.address, seqno);
  }

  /**
   * Returns true if the wallet seqno advanced past previousSeqno within
   * maxAttempts polls — i.e. an external message was consumed on-chain.
   * An RPC hiccup never reads as "not advanced" prematurely; it keeps
   * polling until the bounded window is exhausted.
   */
  private async waitForSeqnoAdvance(
    opened: ReturnType<TonClient['open']>,
    previousSeqno: number,
    maxAttempts = 10,
    delayMs = 1500
  ): Promise<boolean> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      try {
        const currentSeqno = await (opened as any).getSeqno();

        if (currentSeqno > previousSeqno) {
          return true;
        }
      } catch {
        // RPC hiccup — keep polling.
      }
    }

    return false;
  }
    // ===========================================
  async sendJetton(
    userId: number,
    toAddress: string,
    jettonMasterAddress: string,
    amount: bigint
  ): Promise<string> {
    const {
      walletDoc,
      keyPair,
      contract,
      version,
    } = await this.getWalletContext(userId);

    const ownerAddress = Address.parse(walletDoc.address);
    const destination = Address.parse(toAddress);
    const userJettonWallet = await this.deriveJettonWallet(
      walletDoc.address,
      jettonMasterAddress
    );

    const transferBody = beginCell()
      .storeUint(0x0f8a7ea5, 32)
      .storeUint(BigInt(Math.floor(Date.now() / 1000)), 64)
      .storeCoins(amount)
      .storeAddress(destination)
      .storeAddress(ownerAddress)
      .storeBit(0)
      .storeCoins(toNano('0.001'))
      .storeBit(0)
      .endCell();

    const opened = this.client.open(contract);

    /**
     * SAFE SEQNO RESOLUTION — same single source of truth as
     * sendTonFromWalletAddress.
     */
    const { seqno, deployed } = await this.resolveSeqno(opened, walletDoc.address);

    const message = internal({
      to: userJettonWallet,
      // 0.1 TON attached value (unchanged): a transfer to a wallet whose
      // jetton wallet isn't deployed yet needs this headroom; the standard
      // jetton contract otherwise BOUNCES the transfer. Unused excess is
      // refunded to the sender.
      value: toNano('0.1'),
      bounce: true,
      body: transferBody,
    });

    let transfer: Cell;

    if (version === 'v5r1') {
      transfer = (contract as WalletContractV5R1).createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [message],
        sendMode:
          SendMode.PAY_GAS_SEPARATELY,
        timeout: Math.floor(Date.now() / 1000) + 60,
      });
    } else {
      transfer = (contract as WalletContractV4).createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [message],
      });
    }

    /**
     * BROADCAST-OUTCOME HANDLING — identical contract to
     * sendTonFromWalletAddress (see its comment block).
     */
    try {
      await this.client.sendMessage(
        this.buildExternalMessage(contract, walletDoc.address, deployed, transfer)
      );
    } catch (error: any) {
      const info = classifyBroadcastError(error);

      if (info.httpStatus || info.bodySnippet) {
        console.error(
          `[WalletService] Broadcast rejected by endpoint` +
          (info.httpStatus ? ` (HTTP ${info.httpStatus})` : '') +
          (info.bodySnippet ? `: ${info.bodySnippet}` : '')
        );
      }

      if (!info.uncertain) {
        throw error; // verified pre-submission rejection
      }

      console.warn(
        `[WalletService] Uncertain jetton broadcast outcome for ${walletDoc.address}` +
        (info.httpStatus ? ` (HTTP ${info.httpStatus})` : '') +
        `. Checking wallet seqno to classify...`
      );

      const consumed = await this.waitForSeqnoAdvance(opened, seqno, 10, 1500);

      if (consumed) {
        console.warn(
          `[WalletService] Seqno advanced — jetton message WAS consumed on-chain despite the error. ` +
          `Returning tracking reference for reconciliation.`
        );
        return `${Address.parse(walletDoc.address).toString({ bounceable: false })}_${seqno}`;
      }

      throw new BroadcastOutcomeUnknownError(
        `Broadcast outcome unknown: endpoint returned an uncertain error` +
        (info.httpStatus ? ` (HTTP ${info.httpStatus})` : '') +
        ` and the wallet seqno did not advance before the verification window timed out. ` +
        `The transaction may still land on-chain — keep the operation pending and reconcile.`,
        walletDoc.address,
        seqno,
        info.httpStatus
      );
    }

    return this.waitForTransaction(opened, walletDoc.address, seqno);
        }


  // ===========================================================================
  // SAFE SEQNO RESOLUTION
  // ===========================================================================

  /**
   * SAFE SEQNO RESOLUTION (replaces the removed unsafe catch→0 fallback).
   *
   * Queries the contract state from the configured RPC and returns BOTH
   * the seqno and the deployment decision:
   *   - 'uninitialized' → { seqno: 0, deployed: false }  (RPC-confirmed)
   *   - 'active'        → { seqno: <real>, deployed: true }
   *   - 'frozen'        → refuse; the wallet must be unfrozen first.
   *
   * If the state or seqno CANNOT be verified (RPC outage), aborts with a
   * meaningful error. An RPC outage is NEVER treated as proof that a
   * wallet is undeployed, and we never guess a seqno.
   */
  private async resolveSeqno(
    opened: ReturnType<TonClient['open']>,
    address: string
  ): Promise<{ seqno: number; deployed: boolean }> {
    const parsed = Address.parse(address);

    let state: { state?: string } | undefined;
    try {
      state = await this.client.getContractState(parsed);
    } catch (error: any) {
      throw new Error(
        `Cannot verify wallet state for ${address} ` +
        `(RPC failure: ${error?.message || error}). ` +
        `Refusing to assume an undeployed wallet or seqno 0.`
      );
    }

    const st = state?.state;

    if (st === 'uninitialized' || st === 'uninit') {
      return { seqno: 0, deployed: false };
    }

    if (st === 'frozen') {
      throw new Error(
        `Wallet ${address} is frozen (storage dues exceeded). ` +
        `Fund it and execute any transaction to unfreeze before sending.`
      );
    }

    if (st === 'active') {
      try {
        return { seqno: await (opened as any).getSeqno(), deployed: true };
      } catch (error: any) {
        throw new Error(
          `Wallet ${address} is active but its seqno could not be read ` +
          `(${error?.message || error}). Refusing to broadcast without a confirmed seqno.`
        );
      }
    }

    throw new Error(
      `Wallet ${address} is in an unverifiable contract state ('${String(st)}'). ` +
      `Refusing to broadcast without a confirmed seqno.`
    );
  }

  // ===========================================================================
  // EXTERNAL MESSAGE CONSTRUCTION
  // ===========================================================================

  /**
   * Build the external message EXPLICITLY from the deployment decision
   * made in resolveSeqno, and send it via client.sendMessage.
   *
   * Replaces client.sendExternalMessage, which makes its OWN independent
   * isContractDeployed RPC call before sending. On toncenter's
   * multi-liteserver pool that second call can hit a server with a stale
   * view and attach the state-init to an already-deployed account (or
   * omit it from a deploy), producing collator rejections like
   * "cannot apply external message … Failed to unpack account state".
   * Here the init decision and the seqno come from the SAME verified
   * state snapshot — one decision, one message.
   */
  private buildExternalMessage(
    contract: WalletContractV4 | WalletContractV5R1,
    address: string,
    deployed: boolean,
    transfer: Cell
  ): Cell {
    if (!deployed && !contract.init) {
      throw new Error(
        `Wallet ${address} is uninitialized but no contract init is available.`
      );
    }

    return beginCell()
      .storeWritable(
        storeMessage({
          info: {
            type: 'external-in',
            to: Address.parse(address),
            importFee: 0n,
          },
          init: deployed ? null : (contract.init as any),
          body: transfer,
        })
      )
      .endCell();
  }

  // ===========================================================================
  // JETTON WALLET
  // ===========================================================================

  async deriveJettonWallet(
    ownerAddress: string,
    jettonMasterAddress: string
  ): Promise<Address> {
    const master =
      this.client.open(
        JettonMaster.create(
          Address.parse(
            jettonMasterAddress
          )
        )
      );

    return master.getWalletAddress(
      Address.parse(ownerAddress)
    );
  }

  // ===========================================================================
  // TRANSACTION WAITING
  // ===========================================================================

  /**
   * Wait briefly for the external message to appear on-chain.
   *
   * RETURN CONTRACT:
   *  - seqno advanced + tx indexed → real transaction hash.
   *  - seqno advanced + indexing lag → the reconciler-compatible
   *    "walletAddress_seqno" tracking reference. This format is ONLY
   *    returned here when seqno advancement was established.
   *  - seqno never advanced within the window → the outcome is genuinely
   *    unknown (mempool eviction, node lag). We do NOT fabricate a
   *    "walletAddress_seqno_timestamp" reference and do NOT declare
   *    failure — we throw BroadcastOutcomeUnknownError so the caller
   *    keeps the operation pending and reconciles.
   */
  private async waitForTransaction(
    opened:
      | ReturnType<
          TonClient['open']
        >,
    address: string,
    previousSeqno: number
  ): Promise<string> {
    const maxAttempts = 10;

    for (
      let attempt = 0;
      attempt < maxAttempts;
      attempt++
    ) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            1500
          )
      );

      try {
        const currentSeqno =
          await (opened as any).getSeqno();

        /**
         * If seqno increased, the external message was consumed.
         */
        if (
          currentSeqno >
          previousSeqno
        ) {
          try {
            const txs =
              await this.client.getTransactions(
                Address.parse(address),
                {
                  limit: 5,
                }
              );

            if (txs.length > 0) {
              return txs[0]
                .hash()
                .toString('hex');
            }
          } catch {
            // Seqno changed but transaction indexing may lag.
          }

          return `${address}_${previousSeqno}`;
        }
      } catch (error) {
        console.error(
          'Failed checking transaction seqno:',
          error
        );
      }
    }

    /**
     * The seqno never advanced. The message may have been dropped by the
     * mempool or the node may be lagging — the outcome is unknown. Throw
     * the distinct error instead of returning a fabricated reference.
     */
    throw new BroadcastOutcomeUnknownError(
      `Broadcast outcome unknown: the wallet seqno did not advance before ` +
      `the verification window timed out. The message may still be accepted ` +
      `by the network later — keep the operation pending and reconcile.`,
      address,
      previousSeqno
    );
  }

  // ===========================================================================
  // GET ADDRESS
  // ===========================================================================

  async getAddress(
    userId: number
  ): Promise<string | null> {
    const wallet =
      await this.getWallet(userId);

    return wallet?.address || null;
  }

  // ===========================================================================
  // GET ACTIVE WALLET VERSION
  // ===========================================================================

  async getWalletVersionForUser(
    userId: number
  ): Promise<WalletVersion | null> {
    const wallet =
      await this.getWallet(userId);

    if (!wallet) {
      return null;
    }

    const keyPair =
      await this.getKeyPairForWallet(
        wallet
      );

    return this.getWalletVersion(
      wallet,
      keyPair
    );
  }

  // ===========================================================================
  // GET BOTH DERIVED ADDRESSES
  // ===========================================================================

  async getDerivedAddresses(
    userId: number
  ): Promise<{
    v4: string;
    v5: string;
  }> {
    const wallet =
      await this.getWallet(userId);

    if (!wallet) {
      throw new Error(
        'Wallet not found'
      );
    }

    const keyPair =
      await this.getKeyPairForWallet(
        wallet
      );

    return {
      v4: this.getAddressFromKeyPair(
        keyPair,
        'v4r2'
      ),

      v5: this.getAddressFromKeyPair(
        keyPair,
        'v5r1'
      ),
    };
  }
    }
