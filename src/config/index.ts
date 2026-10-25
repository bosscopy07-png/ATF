import dotenv from 'dotenv';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function requireEnvNumber(key: string, defaultValue?: number): number {
  const value = process.env[key];
  if (!value) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid number for ${key}: ${value}`);
  }
  return num;
}

export const NATIVE_GRAM_ADDRESS =
  'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';

export const PTON_MASTER_ADDRESS =
  process.env.PTON_MASTER_ADDRESS ||
  'EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsCtD_WgIhfw2JTP_0';

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',

  port: requireEnvNumber('PORT', 10000),

  appMode: (process.env.APP_MODE || 'server') as 'server' | 'worker',

  mongodbUri: requireEnv('MONGODB_URI'),

  telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),

  superAdminTelegramId: requireEnvNumber('SUPER_ADMIN_TELEGRAM_ID'),

  adminSessionSecret: requireEnv('ADMIN_SESSION_SECRET'),

  encryptionKey: requireEnv('ENCRYPTION_KEY'),

  tonNetwork: process.env.TON_NETWORK || 'mainnet',

  tonRpcUrl: requireEnv('TON_RPC_URL'),

  tonApiKey: process.env.TON_API_KEY || undefined,

  // FIX E: dedicated RPC endpoints/API keys per workload, so a rate-limit
  // or 5xx storm on one path can't corrupt another. All fall back to the
  // existing values — nothing breaks if the new env vars are unset.
  tonRpcUrlSwap:
    process.env.TON_RPC_URL_SWAP || requireEnv('TON_RPC_URL'),
  tonApiKeySwap:
    process.env.TON_API_KEY_SWAP || process.env.TON_API_KEY || undefined,
  tonRpcUrlFee:
    process.env.TON_RPC_URL_FEE || requireEnv('TON_RPC_URL'),
  tonApiKeyFee:
    process.env.TON_API_KEY_FEE || process.env.TON_API_KEY || undefined,

  stonfiApiUrl: process.env.STONFI_API_URL || 'https://api.ston.fi',

  stonfiApiKey: process.env.STONFI_API_KEY || undefined,

  nativeAsset: process.env.NATIVE_ASSET || 'gram',

  nativeGramAddress: NATIVE_GRAM_ADDRESS,

  ptonMasterAddress: PTON_MASTER_ADDRESS,

  atfJettonAddress: requireEnv('ATF_JETTON_ADDRESS'),

  adminFeeWalletAddress: requireEnv('ADMIN_FEE_WALLET_ADDRESS'),

  // FIX A: the admin treasury wallet that sends gas advances. Optional
  // but strongly recommended — the deposit watcher excludes transfers
  // from this address (and from adminFeeWalletAddress) so platform
  // loans are never booked as user deposits.
  adminWalletAddress: process.env.ADMIN_WALLET_ADDRESS || undefined,

  adminWalletMnemonic: process.env.ADMIN_WALLET_MNEMONIC || '',

  platformSwapFeePercent: requireEnvNumber('PLATFORM_SWAP_FEE_PERCENT', 1),

  minSwapTon: requireEnvNumber('MIN_SWAP_TON', 0.1),

  maxSlippagePercent: requireEnvNumber('MAX_SLIPPAGE_PERCENT', 1.0),

  botBrandingImageUrl: requireEnv('BOT_BRANDING_IMAGE_URL'),

  platformWithdrawalFeePercent: 1.0,

  platformDepositFeePercent: 1.0,

  renderExternalUrl: process.env.RENDER_EXTERNAL_URL || '',

  // ─────────────────────────────────────────────
  // Bot identity
  // ─────────────────────────────────────────────

  botUsername: process.env.BOT_USERNAME || 'ATFswapbot',

  supportChannelUrl: process.env.SUPPORT_CHANNEL_URL || 'https://t.me/atfswap',

  // ─────────────────────────────────────────────
  // Price APIs
  // ─────────────────────────────────────────────

  atfPriceApiUrl: process.env.ATF_PRICE_API_URL || '',

  tonPriceApiUrl: process.env.TON_PRICE_API_URL || '',

  usdNgnRateApiUrl: process.env.USD_NGN_RATE_API_URL || '',

  priceCacheTtlMs: requireEnvNumber('PRICE_CACHE_TTL_MS', 60000),

  // ─────────────────────────────────────────────
  // TON ADMIN GAS RECOVERY
  // All monetary values below are nanoTON.
  // ─────────────────────────────────────────────

  tonTransferFeeReserveNano: BigInt(
    requireEnvNumber('TON_TRANSFER_FEE_RESERVE_NANO', 10_000_000)
  ),

  gasRecoveryBufferNano: BigInt(
    requireEnvNumber('TON_GAS_RECOVERY_BUFFER_NANO', 20_000_000)
  ),

  gasRecoveryMinBalanceNano: BigInt(
    requireEnvNumber('TON_GAS_RECOVERY_MIN_BALANCE_NANO', 0)
  ),

  gasRecoveryRetryIntervalMs: requireEnvNumber(
    'GAS_RECOVERY_RETRY_INTERVAL_MS',
    15_000
  ),

  gasRecoveryLockTtlMs: requireEnvNumber('GAS_RECOVERY_LOCK_TTL_MS', 90_000),

  gasRecoveryProcessingTimeoutMs: requireEnvNumber(
    'GAS_RECOVERY_PROCESSING_TIMEOUT_MS',
    120_000
  ),

  postSwapGasRecoveryDelayMs: requireEnvNumber(
    'POST_SWAP_GAS_RECOVERY_DELAY_MS',
    3_000
  ),

  // Minimum TON the user wallet must hold before we attach gas to a
  // jetton fee transfer. 0.1 TON matches sendJetton's forward amount; the
  // earlier hardcoded 0.15 was higher than post-swap balances and blocked
  // all ATF fee collection. Optional env override, safe default.
  minTonForFeeTransferNano: BigInt(
    requireEnvNumber('MIN_TON_FOR_FEE_TRANSFER_NANO', 100_000_000)
  ),

  // ─────────────────────────────────────────────
  // Swap rate limiting / idempotency
  // ─────────────────────────────────────────────

  swapPrepareRateLimit: requireEnvNumber('SWAP_PREPARE_RATE_LIMIT', 8),

  swapPrepareRateWindowMs: requireEnvNumber('SWAP_PREPARE_RATE_WINDOW_MS', 10_000),

  swapExecuteRateLimit: requireEnvNumber('SWAP_EXECUTE_RATE_LIMIT', 3),

  swapExecuteRateWindowMs: requireEnvNumber('SWAP_EXECUTE_RATE_WINDOW_MS', 10_000),

  swapLockTtlMs: requireEnvNumber('SWAP_LOCK_TTL_MS', 30_000),

   /**
   * Extra TON reserve required ON TOP of STON.fi's swap value, to cover
   * the wallet's own processing fee in the exact-balance edge case.
   * Default 0 = trust STON.fi's computation (original behavior).
   */
  swapGasReserveNano: BigInt(requireEnvNumber('SWAP_GAS_RESERVE_NANO', 0)),

  // ─────────────────────────────────────────────
  // ⛳ Feature flags — ALL new capabilities OFF by default
  // ─────────────────────────────────────────────

  features: {
    portfolioScreen:
      (process.env.FEATURE_PORTFOLIO_SCREEN || 'false') === 'true',

    multiTokenSwap:
      (process.env.FEATURE_MULTITOKEN_SWAP || 'false') === 'true',

    transferRelay:
      (process.env.FEATURE_TRANSFER_RELAY || 'false') === 'true',

    treasurySweep:
      (process.env.FEATURE_TREASURY_SWEEP || 'false') === 'true',
  },

  // ─────────────────────────────────────────────
  // 💱 Fee policy (centralized — do NOT scatter fees)
  // ─────────────────────────────────────────────

  feePolicy: {
    /**
     * 'input'  = % deducted from input amount (matches existing TON↔ATF semantics)
     * 'output' = % deducted from DEX output amount
     *
     * ⚠️ PRODUCT OWNER DECISION REQUIRED before enabling multiTokenSwap.
     */
    platformFeeBase: (process.env.FEE_PLATFORM_BASE || 'input') as 'input' | 'output',

    tonToTokenPercent: requireEnvNumber('FEE_TON_TO_TOKEN_PERCENT', 2),

    tokenToTonInputPercent: requireEnvNumber('FEE_TOKEN_TO_TON_INPUT_PERCENT', 2),

    tokenToTonOutputPercent: requireEnvNumber('FEE_TOKEN_TO_TON_OUTPUT_PERCENT', 1),

    tokenToTokenPercent: requireEnvNumber('FEE_TOKEN_TO_TOKEN_PERCENT', 2),

    relayTransferPercent: requireEnvNumber('FEE_RELAY_TRANSFER_PERCENT', 2),

    rounding: 'down' as const,
  },

  // ─────────────────────────────────────────────
  // 🚀 Transfer relay
  // ─────────────────────────────────────────────

  relay: {
    addressesPerUser: requireEnvNumber('RELAY_ADDRESSES_PER_USER', 10),

    walletVersion: (process.env.RELAY_WALLET_VERSION || 'v5r1') as 'v4r2' | 'v5r1',

    minRelayReserveNano: BigInt(
      requireEnvNumber('RELAY_MIN_RESERVE_NANO', 10_000_000)
    ),

    forwardFeeEstimateNano: BigInt(
      requireEnvNumber('RELAY_FORWARD_FEE_NANO', 15_000_000)
    ),

    /** Per-address reuse cooldown after a completed transfer (days). */
    reuseCooldownDays: requireEnvNumber('RELAY_REUSE_COOLDOWN_DAYS', 3),

    /** Successful transfers each address needs before a fresh batch unlocks. */
    minTransfersPerAddress: requireEnvNumber('RELAY_MIN_TRANSFERS_PER_ADDRESS', 5),

    quoteTtlMs: requireEnvNumber('RELAY_QUOTE_TTL_MS', 900_000),

    lockTtlMs: requireEnvNumber('RELAY_LOCK_TTL_MS', 120_000),

    prepareRateLimit: requireEnvNumber('RELAY_PREPARE_RATE_LIMIT', 6),

    prepareRateWindowMs: requireEnvNumber('RELAY_PREPARE_RATE_WINDOW_MS', 60_000),

    treasuryAddress: process.env.TREASURY_ADDRESS || '',
  },
};

export const TON_DECIMALS = 9;

export const GRAM_DECIMALS = 9;

export const ATF_DECIMALS = 9;
    
