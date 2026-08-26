import { mnemonicNew, mnemonicToWalletKey, KeyPair } from '@ton/crypto';
import { WalletContractV4, TonClient, internal, Address, Cell, beginCell, toNano, storeMessageRelaxed } from '@ton/ton';
import { JettonMaster, JettonWallet } from '@ton/ton';
import { encrypt, decrypt } from '../utils/encryption';
import { Wallet, IWallet } from '../models/Wallet';
import { User } from '../models/User';
import { config } from '../config';
import { Precision } from '../utils/precision';

/**
 * Signer Interface — Production Architecture
 * 
 * LocalSigner: Decrypts mnemonic and signs locally (current)
 * HSMSigner: Calls external HSM/KMS for signing (production target)
 */
export interface ISigner {
  getAddress(publicKey: Buffer): string;
  signTransfer(wallet: WalletContractV4, seqno: number, secretKey: Buffer, messages: any[]): Promise<Cell>;
}

class LocalSigner implements ISigner {
  getAddress(publicKey: Buffer): string {
    const w = WalletContractV4.create({ publicKey, workchain: 0 });
    return w.address.toString({ bounceable: false });
  }

  signTransfer(wallet: WalletContractV4, seqno: number, secretKey: Buffer, messages: any[]): Cell {
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

  constructor(signer?: ISigner) {
    this.client = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });
    this.signer = signer || new LocalSigner();
  }

  async createWallet(userId: number): Promise<IWallet> {
    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');

    const existing = await Wallet.findOne({ userId: user._id });
    if (existing) return existing;

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

  async importWallet(userId: number, mnemonicPhrase: string): Promise<IWallet> {
    const user = await User.findOne({ telegramId: userId });
    if (!user) throw new Error('User not found');

    const words = mnemonicPhrase.trim().split(/\s+/);
    if (words.length !== 24) throw new Error('Invalid mnemonic: must be 24 words');

    const keyPair = await mnemonicToWalletKey(words);
    const address = this.signer.getAddress(keyPair.publicKey);

    const existing = await Wallet.findOne({ userId: user._id });
    const { encrypted, iv, tag } = encrypt(mnemonicPhrase);

    if (existing) {
      existing.encryptedMnemonic = encrypted;
      existing.iv = iv;
      existing.tag = tag;
      existing.address = address;
      existing.isImported = true;
      await existing.save();
      return existing;
    }

    return Wallet.create({
      userId: user._id,
      address,
      encryptedMnemonic: encrypted,
      iv,
      tag,
      isImported: true,
    });
  }

  async getWallet(userId: number): Promise<IWallet | null> {
    const user = await User.findOne({ telegramId: userId });
    if (!user) return null;
    return Wallet.findOne({ userId: user._id });
  }

  async getKeyPair(userId: number): Promise<KeyPair> {
    const wallet = await this.getWallet(userId);
    if (!wallet) throw new Error('Wallet not found');

    const mnemonicPhrase = decrypt(wallet.encryptedMnemonic, wallet.iv, wallet.tag);
    const words = mnemonicPhrase.split(' ');
    return mnemonicToWalletKey(words);
  }

  async getBalance(address: string): Promise<{ ton: bigint; aft: bigint }> {
    try {
      const tonBalance = await this.client.getBalance(Address.parse(address));
      
      // Query AFT jetton balance
      const jettonMaster = this.client.open(JettonMaster.create(Address.parse(config.aftJettonAddress)));
      const jettonWalletAddress = await jettonMaster.getWalletAddress(Address.parse(address));
      const jettonWallet = this.client.open(JettonWallet.create(jettonWalletAddress));
      
      let aftBalance = BigInt(0);
      try {
        const balance = await jettonWallet.getBalance();
        aftBalance = balance;
      } catch {
        // Jetton wallet doesn't exist yet (no AFT received)
      }

      return { ton: tonBalance, aft: aftBalance };
    } catch {
      return { ton: BigInt(0), aft: BigInt(0) };
    }
  }

  async sendTon(userId: number, toAddress: string, amount: bigint): Promise<string> {
    const walletDoc = await this.getWallet(userId);
    if (!walletDoc) throw new Error('Wallet not found');

    const keyPair = await this.getKeyPair(userId);
    const wallet = this.client.open(
      WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 })
    );

    const seqno = await wallet.getSeqno();

    const transfer = this.signer.signTransfer(
      wallet,
      seqno,
      keyPair.secretKey,
      [
        internal({
          to: Address.parse(toAddress),
          value: amount,
          bounceable: false,
        }),
      ]
    );

    await this.client.sendExternalMessage(wallet, transfer);
    return `${walletDoc.address}_${seqno}`;
  }

  /**
   * Production Jetton Transfer
   * 
   * 1. Derives user's jetton wallet from master + owner
   * 2. Builds transfer_notification opcode 0xf8a7ea5 payload
   * 3. Sends via user's TON wallet to their jetton wallet
   */
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

    // Derive jetton wallet address from master + owner
    const jettonMaster = this.client.open(JettonMaster.create(Address.parse(jettonMasterAddress)));
    const jettonWalletAddress = await jettonMaster.getWalletAddress(ownerAddress);

    // Build jetton transfer body: op::transfer = 0xf8a7ea5
    const transferBody = beginCell()
      .storeUint(0xf8a7ea5, 32)        // op::transfer
      .storeUint(0, 64)                 // query_id
      .storeCoins(amount)               // jetton amount
      .storeAddress(destination)        // destination
      .storeAddress(ownerAddress)       // response_destination (for excess)
      .storeUint(0, 1)                 // custom_payload: None
      .storeCoins(toNano('0.001'))     // forward_ton_amount
      .storeUint(0, 1)                 // forward_payload in-cell: None
      .endCell();

    const wallet = this.client.open(
      WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 })
    );

    const seqno = await wallet.getSeqno();

    const transfer = this.signer.signTransfer(
      wallet,
      seqno,
      keyPair.secretKey,
      [
        internal({
          to: jettonWalletAddress,
          value: toNano('0.05'),        // Gas for jetton transfer
          bounceable: true,
          body: transferBody,
        }),
      ]
    );

    await this.client.sendExternalMessage(wallet, transfer);
    return `${walletDoc.address}_jetton_${seqno}`;
  }

  async getAddress(userId: number): Promise<string | null> {
    const wallet = await this.getWallet(userId);
    return wallet?.address || null;
  }

  /**
   * Derive jetton wallet address for deposit verification
   */
  async deriveJettonWallet(ownerAddress: string, jettonMasterAddress: string): Promise<Address> {
    const master = this.client.open(JettonMaster.create(Address.parse(jettonMasterAddress)));
    return master.getWalletAddress(Address.parse(ownerAddress));
  }
}
