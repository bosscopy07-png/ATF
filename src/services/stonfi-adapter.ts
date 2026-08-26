import { StonApiClient } from '@ston-fi/api';
import { dexFactory, pTON } from '@ston-fi/sdk';
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
  ): Promise<any> {
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

    if (isTonToJetton) {
      const proxyTon = dexContracts.pTON.create(quote.ptonMasterAddress);
      return router.getSwapTonToJettonTxParams({
        ...sharedParams,
        proxyTon,
        askJettonAddress: askAddress,
      });
    }

    if (isJettonToTon) {
      const proxyTon = dexContracts.pTON.create(quote.ptonMasterAddress);
      return router.getSwapJettonToTonTxParams({
        ...sharedParams,
        proxyTon,
        offerJettonAddress: offerAddress,
      });
    }

    return router.getSwapJettonToJettonTxParams({
      ...sharedParams,
      offerJettonAddress: offerAddress,
      askJettonAddress: askAddress,
    });
  }

  async getSwapStatus(routerAddress: string, ownerAddress: string, queryId: string): Promise<any> {
    return this.apiClient.getSwapStatus({
      routerAddress,
      ownerAddress,
      queryId,
    });
  }

  /**
   * Verify swap completion by checking STON.fi API and on-chain state
   */
  async verifySwapExecution(
    routerAddress: string,
    ownerAddress: string,
    queryId: string
  ): Promise<{ success: boolean; outputAmount?: string }> {
    try {
      const status = await this.getSwapStatus(routerAddress, ownerAddress, queryId);
      if (status && status.success) {
        return { success: true, outputAmount: status.askUnits };
      }
      return { success: false };
    } catch {
      return { success: false };
    }
  }
}
