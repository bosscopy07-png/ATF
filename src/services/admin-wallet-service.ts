import { mnemonicToWalletKey } from '@ton/crypto';
import { WalletContractV4, TonClient, internal, Address } from '@ton/ton';
import { config } from '../config';

/**
 * AdminWalletService
 * 
 * Dedicated signer for the platform admin wallet.
 * Used exclusively for:
 * - Paying TON gas on behalf of users during AFT→TON swaps
 * - Receiving platform fees
 * 
 * In production, replace with HSM/KMS signer.
 */

export class AdminWalletService {
  private client: TonClient;
  private keyPair: any;
  private wallet: WalletContractV4;
  private address: string;

  constructor() {
    this.client = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });

    if (!config.adminWalletMnemonic) {
      throw new Error('ADMIN_WALLET_MNEMONIC not configured');
    }
  }

  async initialize(): Promise<void> {
    const words = config.adminWalletMnemonic.trim().split(/\s+/);
    if (words.length !== 24) {
      throw new Error('Admin mnemonic must be 24 words');
    }

    this.keyPair = await mnemonicToWalletKey(words);
    this.wallet = WalletContractV4.create({ publicKey: this.keyPair.publicKey, workchain: 0 });
    this.address = this.wallet.address.toString({ bounceable: false });

    console.log(`Admin wallet initialized: ${this.address}`);
  }

  getAddress(): string {
    return this.address;
  }

  async getBalance(): Promise<bigint> {
    return this.client.getBalance(this.wallet.address);
  }

  /**
   * Send TON from admin wallet to fund user swap gas
   */
  async sendTon(toAddress: string, amount: bigint): Promise<string> {
    const opened = this.client.open(this.wallet);
    const seqno = await opened.getSeqno();

    const transfer = opened.createTransfer({
      seqno,
      secretKey: this.keyPair.secretKey,
      messages: [
        internal({
          to: Address.parse(toAddress),
          value: amount,
          bounceable: false,
        }),
      ],
    });

    await this.client.sendExternalMessage(opened, transfer);
    return `${this.address}_${seqno}`;
  }

  /**
   * Send Jetton (AFT) from admin fee wallet to wherever needed
   */
  async sendJetton(toAddress: string, jettonMasterAddress: string, amount: bigint): Promise<string> {
    // Implementation mirrors user jetton transfer but from admin wallet
    // Requires deriving admin's jetton wallet and building transfer body
    // Placeholder for production implementation
    throw new Error('Admin jetton transfer requires full Cell implementation');
  }
}
