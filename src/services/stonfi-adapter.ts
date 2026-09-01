import { StonApiClient } from '@ston-fi/api';
import { dexFactory } from '@ston-fi/sdk';
import { TonClient, Address } from '@ton/ton';
import { config } from '../config';

export interface SwapQuote {
  offerAddress: string;
  askAddress: string;
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
  to: string;           // ← CHANGED: string, not Address object
  value: bigint;
  body: any;            // Cell from STON.fi SDK
  gasTon: string;
}

const NATIVE_API_ADDRESS: string = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const PTON_MASTER_ADDRESS: string = 'EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsCtD_WgIhfw2JTP_0';

function normalizeAsset(address: string): string {
  return address.trim();
}

function isNativeGram(address: string): boolean {
  const n = normalizeAsset(address).toLowerCase();
  return (
    n === 'gram' ||
    n === 'ton' ||
    n === 'native' ||
    n === 'native-gram' ||
    n === 'native-ton' ||
    n === NATIVE_API_ADDRESS.toLowerCase()
  );
}

function toApiAssetAddress(address: string): string {
  return isNativeGram(address) ? NATIVE_API_ADDRESS : normalizeAsset(address);
}

/** Safely extract address string from STON.fi SDK response */
function extractAddress(raw: any): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Address) return raw.toString();
  if (raw?.toString && typeof raw.toString === 'function') {
    const s = raw.toString();
    if (s !== '[object Object]') return s;
  }
  if (raw?.address) return String(raw.address);
  throw new Error(`Cannot extract address from: ${JSON.stringify(raw)}`);
}

export class STONFiAdapter {
  private readonly apiClient: StonApiClient;
  private readonly tonClient: TonClient;

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
    const offer = normalizeAsset(offerAddress);
    const ask = normalizeAsset(askAddress);

    if (!offerUnits || !/^\d+$/.test(offerUnits)) {
      throw new Error(`Invalid swap amount: ${offerUnits}`);
    }
    if (BigInt(offerUnits) <= 0n) {
      throw new Error('Swap amount must be greater than zero');
    }

    const slippage = Number(slippageTolerance);
    if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) {
      throw new Error(`Invalid slippage tolerance: ${slippageTolerance}`);
    }

    if (isNativeGram(offer) && isNativeGram(ask)) {
      throw new Error('Cannot swap GRAM to GRAM');
    }

    const apiOfferAddress = toApiAssetAddress(offer);
    const apiAskAddress = toApiAssetAddress(ask);

    try {
      const result = await this.apiClient.simulateSwap({
        offerAddress: apiOfferAddress,
        askAddress: apiAskAddress,
        offerUnits,
        slippageTolerance,
      }) as any;

      if (!result) throw new Error('STON.fi returned an empty simulation response');

      const routerAddress: string = result.routerAddress || result.router_address || '';
      if (!routerAddress) throw new Error('STON.fi simulation did not return a router address');

      const ptonMasterAddress: string =
        result.router?.ptonMasterAddress ||
        result.ptonMasterAddress ||
        result.pton_master_address ||
        PTON_MASTER_ADDRESS;

      const returnedOfferUnits = String(result.offerUnits ?? result.offer_units ?? offerUnits);
      const askUnits = String(result.askUnits ?? result.ask_units ?? '');
      const minAskUnits = String(result.minAskUnits ?? result.min_ask_units ?? '');
      const feeUnits = String(result.feeUnits ?? result.fee_units ?? '0');

      if (!askUnits) throw new Error('STON.fi simulation did not return askUnits');
      if (!minAskUnits) throw new Error('STON.fi simulation did not return minAskUnits');

      return {
        offerAddress: apiOfferAddress,
        askAddress: apiAskAddress,
        offerUnits: returnedOfferUnits,
        askUnits,
        minAskUnits,
        feeUnits,
        slippageTolerance,
        routerAddress,
        ptonMasterAddress,
        route: result.route || routerAddress,
        expiresAt: new Date(Date.now() + 30_000),
      };
    } catch (error: any) {
      const status = error?.response?.status ?? error?.status;
      const responseData = error?.response?.data ?? error?.data;
      let apiMessage = '';

      if (typeof responseData === 'string') {
        apiMessage = responseData;
      } else if (responseData && typeof responseData === 'object') {
        apiMessage =
          responseData.message ||
          responseData.error ||
          responseData.detail ||
          responseData.reason ||
          JSON.stringify(responseData);
      }
      if (!apiMessage) apiMessage = error?.message || 'Unknown STON.fi error';

      console.error(
        `[STON.fi] getQuote failed | status=${status} | pair=${apiOfferAddress}->${apiAskAddress} | amount=${offerUnits} | response=`,
        responseData || error?.message
      );

      if (status === 400) {
        throw new Error(
          `STON.fi rejected the swap (HTTP 400). ` +
          `Pair: ${apiOfferAddress} -> ${apiAskAddress}. ` +
          `Amount: ${offerUnits}. API: ${apiMessage}`
        );
      }
      throw new Error(
        `STON.fi request failed. ` +
        `Pair: ${apiOfferAddress} -> ${apiAskAddress}. ` +
        `API: ${apiMessage}`
      );
    }
  }

  async buildSwapTransaction(
    userWalletAddress: string,
    quote: SwapQuote,
    offerAddress: string,
    askAddress: string
  ): Promise<SwapTxParams> {
    const offer = normalizeAsset(offerAddress);
    const ask = normalizeAsset(askAddress);

    if (!userWalletAddress) throw new Error('User wallet address is required');
    if (!quote.routerAddress) throw new Error('Swap quote is missing router address');

    const ptonMasterAddress: string = quote.ptonMasterAddress || PTON_MASTER_ADDRESS;

    const routerInfo = {
      address: quote.routerAddress,
      ptonMasterAddress,
      majorVersion: 2,
      minorVersion: 1,
      routerType: 'ConstantProduct' as const,
    };

    const dexContracts = dexFactory(routerInfo);
    const router = this.tonClient.open(dexContracts.Router.create(routerInfo.address));

    const nativeOffer = isNativeGram(offer);
    const nativeAsk = isNativeGram(ask);

    if (nativeOffer && nativeAsk) throw new Error('Cannot build GRAM to GRAM swap');

    const sharedParams = {
      userWalletAddress,
      offerAmount: quote.offerUnits,
      minAskAmount: quote.minAskUnits,
    };

    let rawParams: any;

    if (nativeOffer && !nativeAsk) {
      const proxyTon = dexContracts.pTON.create(ptonMasterAddress);
      rawParams = await router.getSwapTonToJettonTxParams({
        ...sharedParams,
        proxyTon,
        askJettonAddress: ask,
      });
    } else if (!nativeOffer && nativeAsk) {
      const proxyTon = dexContracts.pTON.create(ptonMasterAddress);
      rawParams = await router.getSwapJettonToTonTxParams({
        ...sharedParams,
        proxyTon,
        offerJettonAddress: offer,
      });
    } else {
      rawParams = await router.getSwapJettonToJettonTxParams({
        ...sharedParams,
        offerJettonAddress: offer,
        askJettonAddress: ask,
      });
    }

    if (!rawParams || !rawParams.to || rawParams.value === undefined || !rawParams.body) {
      throw new Error('STON.fi failed to build the swap transaction');
    }

    const valueNano = BigInt(rawParams.value.toString());
    const whole = valueNano / 1_000_000_000n;
    const remainder = valueNano % 1_000_000_000n;
    const gasTon = `${whole}.${remainder.toString().padStart(9, '0')}`;

    return {
      to: extractAddress(rawParams.to),   // ← safe string extraction
      value: valueNano,
      body: rawParams.body,
      gasTon,
    };
  }

  async getSwapStatus(routerAddress: string, ownerAddress: string, queryId: string): Promise<any> {
    if (!routerAddress) throw new Error('Router address is required');
    if (!ownerAddress) throw new Error('Owner address is required');
    if (!queryId) throw new Error('Query ID is required');

    return this.apiClient.getSwapStatus({ routerAddress, ownerAddress, queryId });
  }
  }
  
