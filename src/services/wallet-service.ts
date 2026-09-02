import { mnemonicNew, mnemonicToWalletKey, KeyPair } from '@ton/crypto';
import { WalletContractV4, TonClient, internal, Address, Cell, beginCell, toNano } from '@ton/ton';
import { JettonMaster, JettonWallet } from '@ton/ton';
import { encrypt, decrypt } from '../utils/encryption';
import { Wallet, IWallet } from '../models/Wallet';
import { User } from '../models/User';
import { config } from '../config';

export interface ISigner {
  getAddress(publicKey: Buffer): string;
  signTransfer(wallet: WalletContractV4, seqno: number, secretKey: Buffer, messages: any[]): Cell;
}

class LocalSigner implements ISigner {
  getAddress(publicKey: Buffer): string {
    const w = WalletContractV4.create({ publicKey, workchain: 0 });
    return w.address.toString({ bounceable: false });
  }

  signTransfer(wallet: WalletContractV4, seqno: number, secretKey: Buffer, messages: any[]): Cell {
    return wallet.createTransfer({ seqno, secretKey, messages });
  }
}

export class WalletService {
  private client: TonClient;
  private signer: ISigner;

  constructor(signer?: ISigner) {
    this.client = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });
    this.signer = signer || new LocalSigner();
  }

  // ─── Create a BRAND NEW wallet (never blocks) ─────────────────────────────
  async createWallet(userId: number): Promise<IWallet> {
    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');

    const mnemonic = await mnemonicNew(24);
    const keyPair = await mnemonicToWalletKey(mnemonic);
    const address = this.signer.getAddress(keyPair.publicKey);

    const { encrypted, iv, tag } = encrypt(mnemonic.join(' '));

    return Wallet.create({
      userId: user._id,
      address,
      encryptedMnemonic: encrypted,
      iv,
      tag,
      isImported: false,
    });
  }

  // ─── Import wallet = ADD NEW (never replaces old) ──────────────────────────
  async importWallet(userId: number, mnemonicPhrase: string): Promise<IWallet> {
    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');

    const words = mnemonicPhrase.trim().split(/\s+/);
    if (words.length !== 24) throw new Error('Invalid mnemonic: must be 24 words');

    const keyPair = await mnemonicToWalletKey(words);
    const address = this.signer.getAddress(keyPair.publicKey);
    const { encrypted, iv, tag } = encrypt(mnemonicPhrase);

    // Always create a NEW wallet document — old wallets stay safe
    return Wallet.create({
      userId: user._id,
      address,
      encryptedMnemonic: encrypted,
      iv,
      tag,
      isImported: true,
    });
  }

  // ─── Get ACTIVE wallet (or most recent fallback) ───────────────────────────
  async getWallet(userId: number): Promise<IWallet | null> {
    const user = await User.findOne({ telegramId: userId });
    if (!user) return null;

    // If user has an active wallet selected, return it
    if (user.activeWalletId) {
      const active = await Wallet.findById(user.activeWalletId);
      if (active) return active;
    }

    // Fallback: return the most recently created wallet for this user
    return Wallet.findOne({ userId: user._id }).sort({ createdAt: -1 });
  }

  // ─── Get all wallets for a user ────────────────────────────────────────────
  async getWallets(userId: number): Promise<IWallet[]> {
    const user = await User.findOne({ telegramId: userId });
    if (!user) return [];
    return Wallet.find({ userId: user._id }).sort({ createdAt: 1 });
  }

  // ─── Get wallet by Mongo _id ───────────────────────────────────────────────
  async getWalletById(walletId: string): Promise<IWallet | null> {
    return Wallet.findById(walletId);
  }

  async getKeyPair(userId: number): Promise<KeyPair> {
    const wallet = await this.getWallet(userId);
    if (!wallet) throw new Error('Wallet not found');

    const mnemonicPhrase = decrypt(wallet.encryptedMnemonic, wallet.iv, wallet.tag);
    const words = mnemonicPhrase.split(' ');
    return mnemonicToWalletKey(words);
  }

  async getBalance(address: string): Promise<{ ton: bigint; atf: bigint }> {
    try {
      const tonBalance = await this.client.getBalance(Address.parse(address));

      const jettonMaster = this.client.open(JettonMaster.create(Address.parse(config.atfJettonAddress)));
      const jettonWalletAddress = await jettonMaster.getWalletAddress(Address.parse(address));
      const jettonWallet = this.client.open(JettonWallet.create(jettonWalletAddress));

      let atfBalance = BigInt(0);
      try {
        atfBalance = await jettonWallet.getBalance();
      } catch {
        // Jetton wallet not deployed yet
      }

      return { ton: tonBalance, atf: atfBalance };
    } catch {
      return { ton: BigInt(0), atf: BigInt(0) };
    }
  }

  async sendTon(
    userId: number,
    toAddress: string,
    amount: bigint,
    body?: Cell | string
  ): Promise<string> {
    const walletDoc = await this.getWallet(userId);
    if (!walletDoc) throw new Error('Wallet not found');

    const keyPair = await this.getKeyPair(userId);
    const walletContract = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    const opened = this.client.open(walletContract);
    const seqno = await opened.getSeqno();

    const transfer = this.signer.signTransfer(
      walletContract,
      seqno,
      keyPair.secretKey,
      [
        internal({
          to: Address.parse(toAddress),
          value: amount,
          bounce: false,
          body,
        }),
      ]
    );

    await this.client.sendExternalMessage(opened, transfer);

    await new Promise(r => setTimeout(r, 1500));
    try {
      const txs = await this.client.getTransactions(opened.address, { limit: 3 });
      if (txs.length > 0) {
        return txs[0].hash().toString('hex');
      }
    } catch (e) {
      console.error('Failed to fetch tx hash after sendTon:', e);
    }
    return `${walletDoc.address}_${seqno}`;
  }

  async sendJetton(
    userId: number,
    toAddress: string,
    jettonMasterAddress: string,
    amount: bigint
  ): Promise<string> {
    const walletDoc = await this.getWallet(userId);
    if (!walletDoc) throw new Error('Wallet not found');

    const keyPair = await this.getKeyPair(userId);
    const ownerAddress = Address.parse(walletDoc.address);
    const destination = Address.parse(toAddress);

    const walletContract = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    const opened = this.client.open(walletContract);
    const seqno = await opened.getSeqno();

    const userJettonWallet = await this.deriveJettonWallet(walletDoc.address, jettonMasterAddress);

    const transferBody = beginCell()
      .storeUint(0xf8a7ea5, 32)
      .storeUint(Date.now(), 64)
      .storeCoins(amount)
      .storeAddress(destination)
      .storeAddress(ownerAddress)
      .storeUint(0, 1)
      .storeCoins(toNano('0.001'))
      .storeUint(0, 1)
      .endCell();

    const transfer = this.signer.signTransfer(
      walletContract,
      seqno,
      keyPair.secretKey,
      [
        internal({
          to: userJettonWallet,
          value: toNano('0.05'),
          bounce: true,
          body: transferBody,
        }),
      ]
    );

    await this.client.sendExternalMessage(opened, transfer);

    await new Promise(r => setTimeout(r, 1500));
    try {
      const txs = await this.client.getTransactions(opened.address, { limit: 3 });
      if (txs.length > 0) {
        return txs[0].hash().toString('hex');
      }
    } catch (e) {
      console.error('Failed to fetch tx hash after sendJetton:', e);
    }
    return `${walletDoc.address}_jetton_${seqno}_${Date.now()}`;
  }

  async getAddress(userId: number): Promise<string | null> {
    const wallet = await this.getWallet(userId);
    return wallet?.address || null;
  }

  async deriveJettonWallet(ownerAddress: string, jettonMasterAddress: string): Promise<Address> {
    const master = this.client.open(JettonMaster.create(Address.parse(jettonMasterAddress)));
    return master.getWalletAddress(Address.parse(ownerAddress));
  }
}
