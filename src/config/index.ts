import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function requireEnvNumber(key: string, defaultValue?: number): number {
  const value = process.env[key];
  if (!value) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  const num = Number(value);
  if (isNaN(num)) throw new Error(`Invalid number for ${key}`);
  return num;
}

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
  tonApiKey: process.env.TON_API_KEY,
  
  stonfiApiUrl: requireEnv('STONFI_API_URL'),
  stonfiApiKey: process.env.STONFI_API_KEY,
  
  atfJettonAddress: requireEnv('ATF_JETTON_ADDRESS'),
  
  adminFeeWalletAddress: requireEnv('ADMIN_FEE_WALLET_ADDRESS'),
  adminWalletMnemonic: process.env.ADMIN_WALLET_MNEMONIC || '',
  
  platformSwapFeePercent: requireEnvNumber('PLATFORM_SWAP_FEE_PERCENT', 1),
  minSwapTon: requireEnvNumber('MIN_SWAP_TON', 0.1),
  maxSlippagePercent: requireEnvNumber('MAX_SLIPPAGE_PERCENT', 1.0),
  
  botBrandingImageUrl: requireEnv('BOT_BRANDING_IMAGE_URL'),
  
  atfPriceApiUrl: process.env.ATF_PRICE_API_URL || '',
  tonPriceApiUrl: process.env.TON_PRICE_API_URL || 'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
  usdNgnRateApiUrl: process.env.USD_NGN_RATE_API_URL || 'https://api.frankfurter.dev/v2/rate/USD/NGN?providers=CBN',
  
  renderExternalUrl: process.env.RENDER_EXTERNAL_URL || '',
};

export const TON_DECIMALS = 9;
export const ATF_DECIMALS = 9;
