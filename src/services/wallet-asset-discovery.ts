import axios from 'axios';
import { Address } from '@ton/core';
import { config } from '../config';

export type DiscoveredVerification =
  | 'verified'
  | 'community'
  | 'suspicious'
  | 'blacklisted';

export interface DiscoveredJetton {
  /** Canonical Jetton master address. */
  masterAddress: string;

  /** Canonical Jetton wallet address belonging to the user. */
  walletAddress: string;

  symbol: string;
  name: string;
  decimals: number;
  imageUrl?: string;
  verification?: DiscoveredVerification;

  /** Integer base-unit balance, represented as bigint for large balances. */
  balanceBase: bigint;

  priceUsd?: string | null;
  priceSource?: string | null;
  priceUpdatedAt?: Date | null;
}

interface JettonMetadata {
  symbol: string;
  name: string;
  decimals: number;
  imageUrl?: string;
  verification?: DiscoveredVerification;
}

interface WalletCacheEntry {
  expiresAt: number;
  items: DiscoveredJetton[];
}

interface MetadataCacheEntry {
  expiresAt: number;
  metadata: JettonMetadata;
}

const VERIFICATIONS = new Set<DiscoveredVerification>([
  'verified',
  'community',
  'suspicious',
  'blacklisted',
]);

function asVerification(value: any): DiscoveredVerification {
  const normalized = String(value ?? '').toLowerCase();
  return VERIFICATIONS.has(normalized as DiscoveredVerification)
    ? (normalized as DiscoveredVerification)
    : 'community';
}

/**
 * Discovers the Jettons actually held by a TON wallet.
 *
 * Default indexer: TonAPI.
 *
 * Optional environment variables:
 *  - TON_INDEXER_URL         Default: https://tonapi.io
 *  - TON_INDEXER_TIMEOUT_MS  Default: 8000
 *
 * TON_API_KEY is reused for authenticated indexer requests when configured.
 */
export class WalletAssetDiscoveryService {
  private static instance: WalletAssetDiscoveryService | null = null;

  private readonly walletCacheTtlMs = 30_000;
  private readonly metadataCacheTtlMs = 6 * 60 * 60 * 1000;
  private readonly maxWalletCacheEntries = 500;
  private readonly maxMetadataCacheEntries = 2_000;

  private readonly indexerBaseUrl = (
    process.env.TON_INDEXER_URL || 'https://tonapi.io'
  ).replace(/\/+$/, '');

  private readonly requestTimeoutMs = (() => {
    const configured = Number(
      process.env.TON_INDEXER_TIMEOUT_MS || 8_000
    );

    return Number.isFinite(configured) && configured > 0
      ? configured
      : 8_000;
  })();

  private readonly walletCache = new Map<string, WalletCacheEntry>();
  private readonly metadataCache = new Map<string, MetadataCacheEntry>();

  private constructor() {}

  static getInstance(): WalletAssetDiscoveryService {
    if (!WalletAssetDiscoveryService.instance) {
      WalletAssetDiscoveryService.instance =
        new WalletAssetDiscoveryService();
    }

    return WalletAssetDiscoveryService.instance;
  }

  /**
   * Returns all positive Jetton balances reported by the configured indexer.
   *
   * Balances are canonicalized, deduplicated by Jetton master address, and
   * returned as bigint base units.
   */
  async discover(walletAddress: string): Promise<DiscoveredJetton[]> {
    const owner = Address.parse(walletAddress).toString();

    const cached = this.walletCache.get(owner);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.items;
    }

    const response = await this.get(
      `/v2/accounts/${encodeURIComponent(owner)}/jettons`,
      {
        currencies: 'usd',
        limit: 1000,
      }
    );

    const payload: any = response.data;

    const rows: any[] = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.balances)
        ? payload.balances
        : [];

    const items: DiscoveredJetton[] = [];
    const seenMasters = new Set<string>();

    for (const row of rows) {
      try {
        const item = await this.readJettonItem(owner, row);

        if (
          item &&
          item.balanceBase > 0n &&
          !seenMasters.has(item.masterAddress)
        ) {
          seenMasters.add(item.masterAddress);
          items.push(item);
        }
      } catch {
        // Ignore malformed Jetton rows; one bad row must not hide other assets.
      }
    }

    this.rememberWallet(owner, items);
    return items;
  }

  private async readJettonItem(
    owner: string,
    row: any
  ): Promise<DiscoveredJetton | null> {
    const rawMasterAddress =
      row?.jetton?.address ??
      row?.jetton_address ??
      row?.master_address ??
      row?.master ??
      row?.address;

    if (!rawMasterAddress) return null;

    const masterAddress = Address.parse(
      String(rawMasterAddress)
    ).toString();

    const balanceBase = this.toPositiveBigInt(
      row?.balance ?? row?.amount ?? row?.quantity
    );

    if (balanceBase === null) return null;

    const metadata = await this.resolveMetadata(masterAddress, row);

    const jettonWalletAddress =
      this.toOptionalAddress(
        row?.wallet_address ??
          row?.jetton_wallet ??
          row?.jettonWallet
      ) ?? owner;

    const price = this.extractPrice(row);

    return {
      masterAddress,
      walletAddress: jettonWalletAddress,
      ...metadata,
      balanceBase,
      ...price,
    };
  }

  private async resolveMetadata(
    masterAddress: string,
    balanceRow: any
  ): Promise<JettonMetadata> {
    const cached = this.metadataCache.get(masterAddress);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }

    const inlineMetadata = this.metadataFromPayload(
      balanceRow?.jetton ?? balanceRow?.metadata ?? balanceRow
    );

    if (inlineMetadata) {
      return this.rememberMetadata(masterAddress, inlineMetadata);
    }

    const fetchedMetadata = await this.fetchMetadata(
      masterAddress
    ).catch(() => null);

    /*
     * This fallback only applies when the indexer returns a positive balance
     * but omits usable metadata. It ensures the token remains visible instead
     * of being hidden.
     */
    const metadata =
      fetchedMetadata ??
      ({
        name: 'TON Jetton',
        symbol: `JET-${masterAddress.slice(3, 7).toUpperCase()}`,
        decimals: 9,
        verification: 'community',
      } satisfies JettonMetadata);

    return this.rememberMetadata(masterAddress, metadata);
  }

  private async fetchMetadata(
    masterAddress: string
  ): Promise<JettonMetadata | null> {
    const response = await this.get(
      `/v2/jettons/${encodeURIComponent(masterAddress)}`
    );

    return this.metadataFromPayload(response.data);
  }

  private metadataFromPayload(payload: any): JettonMetadata | null {
    const source =
      payload?.jetton ?? payload?.metadata ?? payload;

    const symbol = String(
      source?.symbol ?? ''
    ).trim().toUpperCase();
      const name = String(
      source?.name ?? source?.display_name ?? ''
    ).trim();

    const decimals = Number(
      source?.decimals ?? payload?.decimals
    );

    if (
      !symbol ||
      !name ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 18
    ) {
      return null;
    }

    const imageUrl =
      source?.image ??
      source?.image_url ??
      source?.imageUrl ??
      payload?.image ??
      payload?.image_url;

    return {
      symbol,
      name,
      decimals,
      imageUrl: imageUrl ? String(imageUrl) : undefined,
      verification: asVerification(
        source?.verification ?? payload?.verification
      ),
    };
  }

  private extractPrice(row: any): {
    priceUsd: string | null;
    priceSource: string | null;
    priceUpdatedAt: Date | null;
  } {
    const price =
      row?.price ??
      row?.jetton?.price ??
      row?.token_price ??
      row?.rates;

    const candidates = [
      price?.prices?.USD,
      price?.prices?.usd,
      price?.USD,
      price?.usd,
      price?.price,
      price?.value,
      row?.priceUsd,
      row?.price_usd,
      row?.usd_price,
      row?.jetton?.priceUsd,
    ];

    for (const candidate of candidates) {
      const parsed = this.toPositiveNumberString(candidate);

      if (parsed) {
        const updatedAt = this.toDate(
          row?.priceUpdatedAt ??
            row?.price_updated_at ??
            price?.date ??
            price?.timestamp ??
            price?.updated_at
        );

        return {
          priceUsd: parsed,
          priceSource: String(
            row?.priceSource ?? price?.source ?? 'TON Indexer'
          ),
          priceUpdatedAt: updatedAt ?? new Date(),
        };
      }
    }

    return {
      priceUsd: null,
      priceSource: null,
      priceUpdatedAt: null,
    };
  }

  private toPositiveNumberString(
    value: any
  ): string | null {
    if (
      value === null ||
      value === undefined ||
      value === ''
    ) {
      return null;
    }

    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return String(parsed);
  }

  private toPositiveBigInt(value: any): bigint | null {
    const text =
      typeof value === 'string'
        ? value.trim()
        : value === null || value === undefined
          ? null
          : String(value?.value ?? value?.amount ?? value);

    if (!text || !/^-?\d+$/.test(text)) {
      return null;
    }

    try {
      const parsed = BigInt(text);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }

  private toOptionalAddress(value: any): string | null {
    const raw =
      typeof value === 'string'
        ? value
        : value?.address ?? value?.user_friendly;

    if (!raw) return null;

    try {
      return Address.parse(String(raw)).toString();
    } catch {
      return null;
    }
  }

  private toDate(value: any): Date | null {
    if (!value) return null;

    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value : null;
    }

    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }

  /**
   * GET against the configured indexer.
   *
   * If a configured API key is rejected (401/403) — e.g. a revoked or
   * rotated key — retry once WITHOUT credentials instead of failing the
   * whole discovery. TonAPI also serves unauthenticated requests at a
   * lower rate limit, so discovery keeps working while the key is fixed.
   */
  private async get(
    path: string,
    params?: Record<string, any>,
  ): Promise<any> {
    const attempt = (authenticated: boolean) =>
      axios.get(`${this.indexerBaseUrl}${path}`, {
        timeout: this.requestTimeoutMs,
        params,
        headers: this.indexerHeaders(authenticated),
        validateStatus: (status) =>
          status >= 200 && status < 300,
      });

    const hasKey = !!config.tonApiKey;

    try {
      return await attempt(hasKey);
    } catch (error: any) {
      const status = error?.response?.status;

      if (hasKey && (status === 401 || status === 403)) {
        console.warn(
          '[WalletAssetDiscovery] Indexer key rejected ' +
            `(${status}); retrying without credentials. ` +
            'Update TON_API_KEY.'
        );

        return await attempt(false);
      }

      throw error;
    }
  }

  private indexerHeaders(
    authenticated = true,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (authenticated && config.tonApiKey) {
      headers.Authorization = `Bearer ${config.tonApiKey}`;
    }

    return headers;
  }

  private rememberWallet(
    owner: string,
    items: DiscoveredJetton[]
  ): void {
    if (this.walletCache.size >= this.maxWalletCacheEntries) {
      const oldestKey = this.walletCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.walletCache.delete(oldestKey);
      }
    }

    this.walletCache.set(owner, {
      expiresAt: Date.now() + this.walletCacheTtlMs,
      items,
    });
  }

  private rememberMetadata(
    masterAddress: string,
    metadata: JettonMetadata
  ): JettonMetadata {
    if (this.metadataCache.size >= this.maxMetadataCacheEntries) {
      const oldestKey = this.metadataCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.metadataCache.delete(oldestKey);
      }
    }

    this.metadataCache.set(masterAddress, {
      expiresAt: Date.now() + this.metadataCacheTtlMs,
      metadata,
    });

    return metadata;
  }
    }
