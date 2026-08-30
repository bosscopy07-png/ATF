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
// Set PTON_MASTER_ADDRESS in your .env if you need a different one (e.g. testnet).
const PTON_MASTER_ADDRESS = process.env.PTON_MASTER_ADDRESS || 'EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsCtD_WgIhfw2JTP_0';

function resolveTonAddress(address: string): string {
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
       offerAddress: resolveTonAddress(offerAddress),
       askAddress: resolveTonAddress(askAddress),
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
     const apiMsg = error?.response?.data?.message || error?.response?.data?.error || '';
     if (apiMsg) {
       throw new Error(`STON.fi API: ${apiMsg}`);
     }
     if (error?.message?.includes('400')) {
       throw new Error('Swap amount too small or trading pair unavailable on STON.fi');
     }
     throw error;
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
