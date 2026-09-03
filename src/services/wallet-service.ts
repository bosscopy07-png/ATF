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

import { encrypt, decrypt } from '../utils/encryption';
import { Wallet, IWallet } from '../models/Wallet';
import { User } from '../models/User';
import { config } from '../config';

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
          SendMode.PAY_GAS_SEPARATELY |
          SendMode.IGNORE_ERRORS,
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

  constructor(signer?: ISigner) {
    this.client = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
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
    const {
      walletDoc,
      keyPair,
      contract,
      version,
    } = await this.getWalletContext(userId);

    const destination = Address.parse(toAddress);
    const opened = this.client.open(contract);
    const seqno = await opened.getSeqno();

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
        sendMode:
          SendMode.PAY_GAS_SEPARATELY |
          SendMode.IGNORE_ERRORS,
        timeout: Math.floor(Date.now() / 1000) + 60,
      });
    } else {
      transfer = (contract as WalletContractV4).createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [message],
      });
    }

    await this.client.sendExternalMessage(opened, transfer);
    return this.waitForTransaction(opened, walletDoc.address, seqno);
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
    const seqno = await opened.getSeqno();

    const message = internal({
      to: userJettonWallet,
      value: toNano('0.05'),
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
          SendMode.PAY_GAS_SEPARATELY |
          SendMode.IGNORE_ERRORS,
        timeout: Math.floor(Date.now() / 1000) + 60,
      });
    } else {
      transfer = (contract as WalletContractV4).createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [message],
      });
    }

    await this.client.sendExternalMessage(opened, transfer);
    return this.waitForTransaction(opened, walletDoc.address, seqno);
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
   * IMPORTANT:
   * We don't treat "not indexed yet" as a failed transaction.
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
     * We don't claim that a fabricated value is a blockchain
     * transaction hash.
     *
     * This is only a tracking identifier when the provider has
     * not indexed the transaction yet.
     */
    return `${address}_${previousSeqno}_${Date.now()}`;
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
