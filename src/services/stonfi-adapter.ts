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
  gasTon: string;
}

// STON.fi wrapped-TON (pTON) master on mainnet.
// If you are on testnet, set PTON_MASTER_ADDRESS in your .env.
const PTON_MASTER_ADDRESS = process.env.PTON_MASTER_ADDRESS || 'EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsCtD_WgIhfw2JTP_0';

// The API simulateSwap needs real addresses. "ton" is not valid there.
function resolveApiAddress(address: string): string {
  return address.toLowerCase() === 'ton' ? PTON_MASTER_ADDRESS : address;
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
    try {
      const result = await this.apiClient.simulateSwap({
        offerAddress: resolveApiAddress(offerAddress),
        askAddress: resolveApiAddress(askAddress),
        offerUnits,
        slippageTolerance,
      }) as any;

      const routerAddress = result.routerAddress || result.router?.address || '';
      const ptonMasterAddress = result.ptonMasterAddress || result.router?.ptonMasterAddress || PTON_MASTER_ADDRESS;

      return {
        offerUnits: result.offerUnits,
        askUnits: result.askUnits,
        minAskUnits: result.minAskUnits,
        feeUnits: result.feeUnits || '0',
        slippageTolerance,
        routerAddress,
        ptonMasterAddress,
        route: result.route || routerAddress,
        expiresAt: new Date(Date.now() + 30000),
      };
    } catch (error: any) {
      const status = error?.response?.status;
      const data = error?.response?.data;
      // The STON.fi client sometimes throws the request object as the message
      const apiMsg = typeof data === 'string' ? data : (data?.message || data?.error || data?.detail || JSON.stringify(data || {}));
      const reqInfo = `${offerUnits} units (${resolveApiAddress(offerAddress)} → ${resolveApiAddress(askAddress)})`;

      console.error(`[STON.fi] getQuote failed | status=${status} | req=[${reqInfo}] | response=`, data || error?.message);

      if (status === 400) {
        throw new Error(`STON.fi rejected the swap. Amount too small, pool missing, or pair not listed. [${reqInfo}] | API: ${apiMsg}`);
      }
      throw new Error(`STON.fi request failed: ${apiMsg || error?.message} [${reqInfo}]`);
    }
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

    // SDK uses "ton" sentinel to pick the native-TON swap method
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
        
