import { mnemonicToWalletKey } from '@ton/crypto';
import { WalletContractV4, TonClient, internal, Address } from '@ton/ton';
import { config } from '../config';

export class AdminWalletService {
  private client: TonClient;
  private keyPair: any;
  private walletContract!: WalletContractV4;
  private openedWallet!: any;
  address!: string;

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
    this.walletContract = WalletContractV4.create({ publicKey: this.keyPair.publicKey, workchain: 0 });
    this.openedWallet = this.client.open(this.walletContract);
    this.address = this.walletContract.address.toString({ bounceable: false });

    console.log(`Admin wallet initialized: ${this.address}`);
  }

  getAddress(): string {
    return this.address;
  }

  async getBalance(): Promise<bigint> {
    return this.client.getBalance(this.walletContract.address);
  }

  async sendTon(toAddress: string, amount: bigint): Promise<string> {
    const seqno = await this.openedWallet.getSeqno();

    const transfer = this.walletContract.createTransfer({
      seqno,
      secretKey: this.keyPair.secretKey,
      messages: [
        internal({
          to: Address.parse(toAddress),
          value: amount,
          bounce: false,
        }),
      ],
    });

    await this.client.sendExternalMessage(this.openedWallet, transfer);
    return `${this.address}_${seqno}`;
  }

  async sendJetton(toAddress: string, jettonMasterAddress: string, amount: bigint): Promise<string> {
    throw new Error('Admin jetton transfer requires full Cell implementation');
  }
}
