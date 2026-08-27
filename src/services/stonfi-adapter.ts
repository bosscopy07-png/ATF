import { StonApiClient } from '@ston-fi/api';
import { dexFactory } from '@ston-fi/sdk';
import { TonClient, Address } from '@ton/ton';
import { config } from '../config';

export interface SwapQuote {
  offerUnits: string;
  askUnits: string;
  minAskUnits: string;
  feeUnits: string;
  slippageTolerance: string;
  routerAddress: string;
  ptonMasterAddress: string;
  route: string;
  expiresAt: Date;
}

export interface SwapTxParams {
  to: Address;
  value: bigint;
  body: any;
  gasTon: string; // Human-readable TON required for gas
}

export class STONFiAdapter {
  private apiClient: StonApiClient;
  private tonClient: TonClient;

  constructor() {
    this.apiClient = new StonApiClient({ baseURL: config.stonfiApiUrl });
    this.tonClient = new TonClient({
      endpoint: config.tonRpcUrl,
      apiKey: config.tonApiKey,
    });
  }

  async getQuote(
    offerAddress: string,
    askAddress: string,
    offerUnits: string,
    slippageTolerance: string = '0.01'
  ): Promise<SwapQuote> {
    const result = await this.apiClient.simulateSwap({
      offerAddress,
      askAddress,
      offerUnits,
      slippageTolerance,
    });

    const router = result.router;

    return {
      offerUnits: result.offerUnits,
      askUnits: result.askUnits,
      minAskUnits: result.minAskUnits,
      feeUnits: result.feeUnits || '0',
      slippageTolerance,
      routerAddress: router.address,
      ptonMasterAddress: router.ptonMasterAddress || '',
      route: router.address,
      expiresAt: new Date(Date.now() + 30000),
    };
  }

  async buildSwapTransaction(
    userWalletAddress: string,
    quote: SwapQuote,
    offerAddress: string,
    askAddress: string
  ): Promise<SwapTxParams> {
    const routerInfo = {
      address: quote.routerAddress,
      ptonMasterAddress: quote.ptonMasterAddress,
      majorVersion: 2,
      minorVersion: 1,
      routerType: 'ConstantProduct',
    };

    const dexContracts = dexFactory(routerInfo);
    const router = this.tonClient.open(dexContracts.Router.create(routerInfo.address));

    const sharedParams = {
      userWalletAddress,
      offerAmount: quote.offerUnits,
      minAskAmount: quote.minAskUnits,
    };

    const isTonToJetton = offerAddress.toLowerCase() === 'ton';
    const isJettonToTon = askAddress.toLowerCase() === 'ton';
    let rawParams: any;

    if (isTonToJetton) {
      const proxyTon = dexContracts.pTON.create(quote.ptonMasterAddress);
      rawParams = await router.getSwapTonToJettonTxParams({
        ...sharedParams,
        proxyTon,
        askJettonAddress: askAddress,
      });
    } else if (isJettonToTon) {
      const proxyTon = dexContracts.pTON.create(quote.ptonMasterAddress);
      rawParams = await router.getSwapJettonToTonTxParams({
        ...sharedParams,
        proxyTon,
        offerJettonAddress: offerAddress,
      });
    } else {
      rawParams = await router.getSwapJettonToJettonTxParams({
        ...sharedParams,
        offerJettonAddress: offerAddress,
        askJettonAddress: askAddress,
      });
    }

    // Extract TON gas requirement from the transaction value
    const valueNano = BigInt(rawParams.value.toString());
    const gasTon = (Number(valueNano) / 1e9).toFixed(9);

    return {
      to: Address.parse(rawParams.to.toString()),
      value: valueNano,
      body: rawParams.body,
      gasTon,
    };
  }

  async getSwapStatus(routerAddress: string, ownerAddress: string, queryId: string): Promise<any> {
    return this.apiClient.getSwapStatus({
      routerAddress,
      ownerAddress,
      queryId,
    });
  }
}
