import { StonApiClient } from '@ston-fi/api';
import { dexFactory } from '@ston-fi/sdk';
import {
  TonClient,
  Address,
} from '@ton/ton';

import {
  config,
  NATIVE_GRAM_ADDRESS,
  PTON_MASTER_ADDRESS,
} from '../config';

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
 * Canonical STON.fi native GRAM/TON address.
 *
 * IMPORTANT:
 * This is used for API simulation.
 *
 * Do NOT use:
 *
 *   "ton"
 *   "gram"
 *   pTON master
 *
 * in simulateSwap().
 */
const NATIVE_ASSET_ADDRESS =
  NATIVE_GRAM_ADDRESS;

/*
 * pTON is used only by the SDK when
 * constructing the actual transaction.
 */
const PTON_MASTER =
  PTON_MASTER_ADDRESS;

function normalizeAsset(
  address: string
): string {
  return address.trim();
}

/**
 * Determines whether the supplied application
 * asset identifier represents native GRAM.
 *
 * Supports old and new application naming:
 *
 *   gram
 *   ton
 *   native
 *   native-gram
 *   native-ton
 *
 * Also accepts the canonical STON.fi address.
 */
function isNativeGram(
  address: string
): boolean {
  const normalized =
    normalizeAsset(address)
      .toLowerCase();

  return (
    normalized === 'gram' ||
    normalized === 'ton' ||
    normalized === 'native' ||
    normalized === 'native-gram' ||
    normalized === 'native-ton' ||
    normalized ===
      NATIVE_ASSET_ADDRESS.toLowerCase()
  );
}

/**
 * Convert application asset identifiers
 * into STON.fi API asset addresses.
 *
 * GRAM -> canonical native TON address
 * Jetton -> unchanged address
 */
function toApiAssetAddress(
  address: string
): string {
  if (
    isNativeGram(address)
  ) {
    return NATIVE_ASSET_ADDRESS;
  }

  return normalizeAsset(address);
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
   * Simulate a swap through STON.fi.
   *
   * Native GRAM is translated to the canonical
   * TON address before calling simulateSwap().
   */
  async getQuote(
    offerAddress: string,
    askAddress: string,
    offerUnits: string,
    slippageTolerance: string = '0.01'
  ): Promise<SwapQuote> {
    const offer =
      normalizeAsset(
        offerAddress
      );

    const ask =
      normalizeAsset(
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
        'Cannot swap GRAM to GRAM'
      );
    }

    /*
     * THIS IS THE IMPORTANT FIX.
     *
     * The API expects an address.
     *
     * For native GRAM:
     *
     * gram -> EQAAAAAAAA...AM9c
     *
     * NOT:
     *
     * gram -> "ton"
     *
     * and NOT:
     *
     * gram -> pTON master.
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
       * routerAddress.
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
       * @ston-fi/api 0.29+ can return the
       * router object directly.
       *
       * Your project currently uses 0.14.x,
       * so fallback to configured pTON.
       */
      const ptonMasterAddress =
        result.router?.ptonMasterAddress ||
        result.ptonMasterAddress ||
        result.pton_master_address ||
        PTON_MASTER;

      const returnedOfferUnits =
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

      const feeUnits =
        String(
          result.feeUnits ??
          result.fee_units ??
          '0'
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

      const route =
        result.route ||
        routerAddress;

      console.log(
        '[STON.fi] Quote received',
        {
          offerUnits:
            returnedOfferUnits,

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
          returnedOfferUnits,

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
   * Build the transaction after a successful quote.
   *
   * For native GRAM:
   *
   * API:
   *   canonical native address
   *
   * SDK:
   *   pTON proxy contract
   */
  async buildSwapTransaction(
    userWalletAddress: string,
    quote: SwapQuote,
    offerAddress: string,
    askAddress: string
  ): Promise<SwapTxParams> {
    const offer =
      normalizeAsset(
        offerAddress
      );

    const ask =
      normalizeAsset(
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

    const ptonMasterAddress =
      quote.ptonMasterAddress ||
      PTON_MASTER;

    /*
     * Build router configuration.
     */
    const routerInfo = {
      address:
        quote.routerAddress,

      ptonMasterAddress,

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
      const proxyTon =
        dexContracts.pTON.create(
          ptonMasterAddress
        );

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
      const proxyTon =
        dexContracts.pTON.create(
          ptonMasterAddress
        );

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
     * Exact nanoGRAM -> GRAM
     * conversion without floating-point
     * precision problems.
     */
    const whole =
      valueNano /
      1_000_000_000n;

    const remainder =
      valueNano %
      1_000_000_000n;

    const gasTon =
      `${whole}.${remainder
        .toString()
        .padStart(
          9,
          '0'
        )}`;

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
   * Check swap status.
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
