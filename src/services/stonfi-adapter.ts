import { StonApiClient } from '@ston-fi/api';
import { dexFactory } from '@ston-fi/sdk';
import {
  TonClient,
  Address,
} from '@ton/ton';

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
  to: Address;
  value: bigint;
  body: any;
  gasTon: string;
}

/*
 * STON.fi API uses "ton" for the native blockchain asset.
 *
 * The application may call it GRAM.
 *
 * DO NOT send the pTON master address to simulateSwap()
 * when the user is swapping the native asset.
 */
const NATIVE_ASSET =
  config.nativeAsset || 'ton';

const PTON_MASTER_ADDRESS =
  config.ptonMasterAddress;

/**
 * Normalize an asset identifier.
 */
function normalizeAddress(
  address: string
): string {
  return address.trim();
}

/**
 * Detect native GRAM.
 *
 * Supports:
 *   gram
 *   ton
 *   native
 *   native-gram
 *   native-ton
 *
 * This keeps compatibility with older parts
 * of the application.
 */
function isNativeGram(
  address: string
): boolean {
  const value =
    normalizeAddress(address)
      .toLowerCase();

  return (
    value === 'gram' ||
    value === 'ton' ||
    value === 'native' ||
    value === 'native-gram' ||
    value === 'native-ton'
  );
}

/**
 * Convert the application's native asset
 * representation to the STON.fi API representation.
 *
 * IMPORTANT:
 *
 * Native GRAM/TON -> "ton"
 *
 * Jetton -> unchanged address
 */
function toApiAssetAddress(
  address: string
): string {
  if (isNativeGram(address)) {
    return NATIVE_ASSET;
  }

  return normalizeAddress(address);
}

export class STONFiAdapter {
  private readonly apiClient: StonApiClient;

  private readonly tonClient: TonClient;

  constructor() {
    this.apiClient =
      new StonApiClient({
        baseURL:
          config.stonfiApiUrl,
      });

    this.tonClient =
      new TonClient({
        endpoint:
          config.tonRpcUrl,

        apiKey:
          config.tonApiKey,
      });
  }

  /**
   * Get a STON.fi swap quote.
   *
   * Example:
   *
   * GRAM -> ATF
   *
   * application:
   *   gram -> ATF_ADDRESS
   *
   * STON.fi:
   *   ton -> ATF_ADDRESS
   */
  async getQuote(
    offerAddress: string,
    askAddress: string,
    offerUnits: string,
    slippageTolerance: string = '0.01'
  ): Promise<SwapQuote> {
    const offer =
      normalizeAddress(
        offerAddress
      );

    const ask =
      normalizeAddress(
        askAddress
      );

    /*
     * Validate amount.
     */
    if (
      !offerUnits ||
      !/^\d+$/.test(offerUnits)
    ) {
      throw new Error(
        `Invalid swap amount: ${offerUnits}`
      );
    }

    const amount =
      BigInt(offerUnits);

    if (amount <= 0n) {
      throw new Error(
        'Swap amount must be greater than zero'
      );
    }

    /*
     * Validate slippage.
     *
     * STON.fi expects decimal representation:
     *
     * 0.01 = 1%
     * 0.005 = 0.5%
     */
    const slippage =
      Number(
        slippageTolerance
      );

    if (
      !Number.isFinite(slippage) ||
      slippage < 0 ||
      slippage >= 1
    ) {
      throw new Error(
        `Invalid slippage tolerance: ${slippageTolerance}`
      );
    }

    const nativeOffer =
      isNativeGram(offer);

    const nativeAsk =
      isNativeGram(ask);

    if (
      nativeOffer &&
      nativeAsk
    ) {
      throw new Error(
        'Cannot swap GRAM to GRAM'
      );
    }

    /*
     * CRITICAL FIX:
     *
     * Native GRAM is sent to STON.fi as "ton".
     *
     * It is NOT replaced with:
     *
     * EQCM3B12...
     *
     * That address is pTON and is only required
     * later when constructing the transaction.
     */
    const apiOfferAddress =
      toApiAssetAddress(
        offer
      );

    const apiAskAddress =
      toApiAssetAddress(
        ask
      );

    try {
      console.log(
        '[STON.fi] Simulating swap',
        {
          offerAddress:
            apiOfferAddress,

          askAddress:
            apiAskAddress,

          offerUnits,

          slippageTolerance:
            slippageTolerance,
        }
      );

      const result =
        await this.apiClient.simulateSwap({
          offerAddress:
            apiOfferAddress,

          askAddress:
            apiAskAddress,

          offerUnits,

          slippageTolerance,
        }) as any;

      if (!result) {
        throw new Error(
          'STON.fi returned an empty simulation response'
        );
      }

      /*
       * @ston-fi/api 0.14.0 returns
       * routerAddress rather than the newer
       * embedded router object.
       */
      const routerAddress =
        result.routerAddress ||
        result.router_address ||
        '';

      if (!routerAddress) {
        throw new Error(
          'STON.fi simulation did not return a router address'
        );
      }

      /*
       * v0.14 does not reliably provide the
       * pTON address directly in the simulation.
       *
       * Use configured mainnet pTON.
       */
      const ptonMasterAddress =
        result.ptonMasterAddress ||
        result.pton_master_address ||
        PTON_MASTER_ADDRESS;

      const simulatedOfferUnits =
        String(
          result.offerUnits ??
          result.offer_units ??
          offerUnits
        );

      const askUnits =
        String(
          result.askUnits ??
          result.ask_units ??
          ''
        );

      const minAskUnits =
        String(
          result.minAskUnits ??
          result.min_ask_units ??
          ''
        );

      if (!askUnits) {
        throw new Error(
          'STON.fi simulation did not return askUnits'
        );
      }

      if (!minAskUnits) {
        throw new Error(
          'STON.fi simulation did not return minAskUnits'
        );
      }

      const feeUnits =
        String(
          result.feeUnits ??
          result.fee_units ??
          '0'
        );

      const route =
        result.route ||
        routerAddress;

      console.log(
        '[STON.fi] Quote received',
        {
          offerUnits:
            simulatedOfferUnits,

          askUnits,

          minAskUnits,

          feeUnits,

          routerAddress,

          ptonMasterAddress,
        }
      );

      return {
        offerAddress:
          apiOfferAddress,

        askAddress:
          apiAskAddress,

        offerUnits:
          simulatedOfferUnits,

        askUnits,

        minAskUnits,

        feeUnits,

        slippageTolerance,

        routerAddress,

        ptonMasterAddress,

        route,

        expiresAt:
          new Date(
            Date.now() + 30_000
          ),
      };
    } catch (error: any) {
      const status =
        error?.response?.status ??
        error?.status;

      const responseData =
        error?.response?.data ??
        error?.data;

      let apiMessage =
        '';

      if (
        typeof responseData ===
        'string'
      ) {
        apiMessage =
          responseData;
      } else if (
        responseData &&
        typeof responseData ===
          'object'
      ) {
        apiMessage =
          responseData.message ||
          responseData.error ||
          responseData.detail ||
          responseData.reason ||
          JSON.stringify(
            responseData
          );
      }

      if (!apiMessage) {
        apiMessage =
          error?.message ||
          'Unknown STON.fi error';
      }

      console.error(
        '[STON.fi] getQuote failed',
        {
          status,

          applicationOffer:
            offer,

          applicationAsk:
            ask,

          apiOfferAddress,

          apiAskAddress,

          offerUnits,

          slippageTolerance,

          response:
            responseData,

          error:
            error?.message,
        }
      );

      if (status === 400) {
        throw new Error(
          `STON.fi rejected the swap (HTTP 400). ` +
          `Pair: ${apiOfferAddress} -> ${apiAskAddress}. ` +
          `Amount: ${offerUnits}. ` +
          `API: ${apiMessage}`
        );
      }

      throw new Error(
        `STON.fi request failed. ` +
        `Pair: ${apiOfferAddress} -> ${apiAskAddress}. ` +
        `API: ${apiMessage}`
      );
    }
  }

  /**
   * Build the actual swap transaction.
   *
   * The quote MUST already have been obtained
   * from getQuote().
   *
   * pTON is used here only for native GRAM
   * transaction construction.
   */
  async buildSwapTransaction(
    userWalletAddress: string,
    quote: SwapQuote,
    offerAddress: string,
    askAddress: string
  ): Promise<SwapTxParams> {
    const offer =
      normalizeAddress(
        offerAddress
      );

    const ask =
      normalizeAddress(
        askAddress
      );

    if (!userWalletAddress) {
      throw new Error(
        'User wallet address is required'
      );
    }

    if (!quote.routerAddress) {
      throw new Error(
        'Swap quote is missing router address'
      );
    }

    if (!quote.ptonMasterAddress) {
      throw new Error(
        'Swap quote is missing pTON master address'
      );
    }

    /*
     * Router information required by SDK v2.
     */
    const routerInfo = {
      address:
        quote.routerAddress,

      ptonMasterAddress:
        quote.ptonMasterAddress,

      majorVersion: 2,

      minorVersion: 1,

      routerType:
        'ConstantProduct',
    };

    const dexContracts =
      dexFactory(
        routerInfo
      );

    const router =
      this.tonClient.open(
        dexContracts.Router.create(
          routerInfo.address
        )
      );

    const nativeOffer =
      isNativeGram(
        offer
      );

    const nativeAsk =
      isNativeGram(
        ask
      );

    if (
      nativeOffer &&
      nativeAsk
    ) {
      throw new Error(
        'Cannot build GRAM to GRAM swap'
      );
    }

    /*
     * pTON is required by the SDK for
     * native GRAM transactions.
     */
    const proxyTon =
      dexContracts.pTON.create(
        quote.ptonMasterAddress ||
        PTON_MASTER_ADDRESS
      );

    /*
     * Never recalculate the minimum output.
     *
     * Use exactly what STON.fi returned.
     */
    const sharedParams = {
      userWalletAddress,

      offerAmount:
        quote.offerUnits,

      minAskAmount:
        quote.minAskUnits,
    };

    let rawParams: any;

    /*
     * GRAM -> Jetton
     */
    if (
      nativeOffer &&
      !nativeAsk
    ) {
      rawParams =
        await router.getSwapTonToJettonTxParams({
          ...sharedParams,

          proxyTon,

          askJettonAddress:
            ask,
        });
    }

    /*
     * Jetton -> GRAM
     */
    else if (
      !nativeOffer &&
      nativeAsk
    ) {
      rawParams =
        await router.getSwapJettonToTonTxParams({
          ...sharedParams,

          proxyTon,

          offerJettonAddress:
            offer,
        });
    }

    /*
     * Jetton -> Jetton
     */
    else {
      rawParams =
        await router.getSwapJettonToJettonTxParams({
          ...sharedParams,

          offerJettonAddress:
            offer,

          askJettonAddress:
            ask,
        });
    }

    if (
      !rawParams ||
      !rawParams.to ||
      rawParams.value ===
        undefined ||
      !rawParams.body
    ) {
      throw new Error(
        'STON.fi failed to build the swap transaction'
      );
    }

    const valueNano =
      BigInt(
        rawParams.value.toString()
      );

    /*
     * Convert nanoGRAM to GRAM
     * without losing precision.
     */
    const whole =
      valueNano / 1_000_000_000n;

    const remainder =
      valueNano %
      1_000_000_000n;

    const gasTon =
      `${whole}.${remainder
        .toString()
        .padStart(9, '0')}`;

    return {
      to:
        Address.parse(
          rawParams.to.toString()
        ),

      value:
        valueNano,

      body:
        rawParams.body,

      gasTon,
    };
  }

  /**
   * Get swap execution status.
   */
  async getSwapStatus(
    routerAddress: string,
    ownerAddress: string,
    queryId: string
  ): Promise<any> {
    if (!routerAddress) {
      throw new Error(
        'Router address is required'
      );
    }

    if (!ownerAddress) {
      throw new Error(
        'Owner address is required'
      );
    }

    if (!queryId) {
      throw new Error(
        'Query ID is required'
      );
    }

    return this.apiClient.getSwapStatus({
      routerAddress,

      ownerAddress,

      queryId,
    });
  }
          }
