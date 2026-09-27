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
    if (defaultValue !== undefined) {
      return defaultValue;
    }
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
  stonfiApiUrl: process.env.STONFI_API_URL || 'https://api.ston.fi',
  stonfiApiKey: process.env.STONFI_API_KEY || undefined,
  nativeAsset: process.env.NATIVE_ASSET || 'gram',
  nativeGramAddress: NATIVE_GRAM_ADDRESS,
  ptonMasterAddress: PTON_MASTER_ADDRESS,
  atfJettonAddress: requireEnv('ATF_JETTON_ADDRESS'),
  adminFeeWalletAddress: requireEnv('ADMIN_FEE_WALLET_ADDRESS'),
  adminWalletMnemonic: process.env.ADMIN_WALLET_MNEMONIC || '',
  platformSwapFeePercent: requireEnvNumber('PLATFORM_SWAP_FEE_PERCENT', 1),
  minSwapTon: requireEnvNumber('MIN_SWAP_TON', 0.1),
  maxSlippagePercent: requireEnvNumber('MAX_SLIPPAGE_PERCENT', 1.0),
  botBrandingImageUrl: requireEnv('BOT_BRANDING_IMAGE_URL'),
  platformWithdrawalFeePercent: 1.0, 
  platformDepositFeePercent: 1.0,   
  renderExternalUrl: process.env.RENDER_EXTERNAL_URL || '',

  // ─── Bot identity ─────────────────────────────────────────
  botUsername: process.env.BOT_USERNAME || 'ATFswapbot',
  supportChannelUrl: process.env.SUPPORT_CHANNEL_URL || 'https://t.me/atfswap',

  // ─── Price APIs (primary + built-in fallbacks in service) ─
  atfPriceApiUrl:
    process.env.ATF_PRICE_API_URL ||
    '', // empty = auto-build from atfJettonAddress

  tonPriceApiUrl:
    process.env.TON_PRICE_API_URL ||
    '', // empty = use built-in fallback chain

  usdNgnRateApiUrl:
    process.env.USD_NGN_RATE_API_URL ||
    '', // empty = use built-in fallback chain

  priceCacheTtlMs: requireEnvNumber('PRICE_CACHE_TTL_MS', 60000),

  // ─── TON admin gas recovery safety (all in nanoTON) ────────
  // No dedicated on-chain fee estimator exists in this project, so this is a
  // configurable conservative reserve, NOT the exact network fee. A plain
  // wallet-to-wallet TON transfer typically costs well under this on mainnet.
  tonTransferFeeReserveNano: BigInt(requireEnvNumber('TON_TRANSFER_FEE_RESERVE_NANO', 10_000_000)), // 0.01 TON
  // Extra safety margin on top of the fee reserve before we attempt a recovery send.
  gasRecoveryBufferNano: BigInt(requireEnvNumber('TON_GAS_RECOVERY_BUFFER_NANO', 20_000_000)), // 0.02 TON
  // Floor balance recovery must never dip below (protects unrelated user funds/dust).
  gasRecoveryMinBalanceNano: BigInt(requireEnvNumber('TON_GAS_RECOVERY_MIN_BALANCE_NANO', 0)),
  // How often the retry worker re-attempts pending/partial gas recoveries.
  gasRecoveryRetryIntervalMs: requireEnvNumber('GAS_RECOVERY_RETRY_INTERVAL_MS', 120_000),

  // ─── Swap rate limiting / idempotency ──────────────────────
  swapPrepareRateLimit: requireEnvNumber('SWAP_PREPARE_RATE_LIMIT', 8),
  swapPrepareRateWindowMs: requireEnvNumber('SWAP_PREPARE_RATE_WINDOW_MS', 10_000),
  swapExecuteRateLimit: requireEnvNumber('SWAP_EXECUTE_RATE_LIMIT', 3),
  swapExecuteRateWindowMs: requireEnvNumber('SWAP_EXECUTE_RATE_WINDOW_MS', 10_000),
  swapLockTtlMs: requireEnvNumber('SWAP_LOCK_TTL_MS', 30_000),
};

export const TON_DECIMALS = 9;
export const GRAM_DECIMALS = 9;
export const ATF_DECIMALS = 9;

