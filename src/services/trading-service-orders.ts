import {
  OrderSide,
  OrderType as SdkOrderType,
  type ApiKeyCreds,
} from '@polymarket/client';
import { signerFrom } from '@polymarket/client/ethers-v5';
import { Wallet } from 'ethers';
import { RateLimiter, ApiType } from '../core/rate-limiter.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import type { Side } from '../core/types.js';
import {
  POLYGON_MAINNET,
  MIN_ORDER_VALUE_USDC,
  MIN_ORDER_SIZE_SHARES,
  type ApiCredentials,
  type TradingServiceConfig,
  type LimitOrderParams,
  type MarketOrderParams,
  type OrderResult,
  type AnySecureClient,
} from './trading-types.js';
import { createSecureClient } from '@polymarket/client';

/** Base construction + auth + order placement */
export class TradingServiceBase {
  protected client: AnySecureClient | null = null;
  protected wallet: Wallet;
  protected chainId: number;
  protected credentials: ApiCredentials | null = null;
  protected initialized = false;
  protected tickSizeCache: Map<string, string> = new Map();
  protected negRiskCache: Map<string, boolean> = new Map();

  constructor(
    protected rateLimiter: RateLimiter,
    protected cache: UnifiedCache,
    protected config: TradingServiceConfig
  ) {
    this.wallet = new Wallet(config.privateKey);
    this.chainId = config.chainId || POLYGON_MAINNET;
    this.credentials = config.credentials || null;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const credentials = this.credentials
      ? ({
          key: this.credentials.key,
          secret: this.credentials.secret,
          passphrase: this.credentials.passphrase,
        } as ApiKeyCreds)
      : undefined;
    this.client = await createSecureClient({
      wallet: this.config.walletAddress,
      signer: signerFrom(this.wallet as any),
      ...(credentials ? { credentials } : {}),
    });
    const liveCreds = this.client.credentials;
    if (liveCreds) {
      this.credentials = {
        key: String(liveCreds.key),
        secret: String(liveCreds.secret),
        passphrase: String(liveCreds.passphrase),
      };
    }
    this.initialized = true;
  }

  protected async ensureInitialized(): Promise<AnySecureClient> {
    if (!this.initialized || !this.client) {
      await this.initialize();
    }
    return this.client!;
  }

  async getTickSize(tokenId: string): Promise<string> {
    if (this.tickSizeCache.has(tokenId)) {
      return this.tickSizeCache.get(tokenId)!;
    }
    const client = await this.ensureInitialized();
    const page = await client.listMarkets({ clobTokenIds: [tokenId] }).firstPage();
    const market = page.items[0];
    const tickSize = String(market?.trading?.minimumTickSize ?? '0.01');
    this.tickSizeCache.set(tokenId, tickSize);
    return tickSize;
  }

  async isNegRisk(tokenId: string): Promise<boolean> {
    if (this.negRiskCache.has(tokenId)) {
      return this.negRiskCache.get(tokenId)!;
    }
    const client = await this.ensureInitialized();
    const page = await client.listMarkets({ clobTokenIds: [tokenId] }).firstPage();
    const market = page.items[0];
    const negRisk = Boolean(market?.state?.negRisk);
    this.negRiskCache.set(tokenId, negRisk);
    return negRisk;
  }

  async createLimitOrder(params: LimitOrderParams): Promise<OrderResult> {
    if (params.size < MIN_ORDER_SIZE_SHARES) {
      return {
        success: false,
        errorMsg: `Order size (${params.size}) is below Polymarket minimum (${MIN_ORDER_SIZE_SHARES} shares)`,
      };
    }
    const orderValue = params.price * params.size;
    if (orderValue < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order value ($${orderValue.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.placeLimitOrder({
          tokenId: params.tokenId,
          price: params.price,
          size: params.size,
          side: params.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
          ...(params.orderType === 'GTD' || params.expiration
            ? { expiration: params.expiration || Math.floor(Date.now() / 1000) + 3600 }
            : {}),
        });
        if (result.ok) {
          return {
            success: true,
            orderId: String(result.orderId),
            transactionHashes: (result.transactionsHashes || []).map(String),
          };
        }
        return { success: false, errorMsg: result.message || String(result.code) };
      } catch (error) {
        return {
          success: false,
          errorMsg: `Order failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  }

  async createMarketOrder(params: MarketOrderParams): Promise<OrderResult> {
    if (params.amount < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order amount ($${params.amount.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const orderType = params.orderType === 'FAK' ? SdkOrderType.FAK : SdkOrderType.FOK;
        const result =
          params.side === 'BUY'
            ? await client.placeMarketOrder({
                tokenId: params.tokenId,
                side: OrderSide.BUY,
                amount: params.amount,
                maxSpend: params.amount,
                ...(params.price !== undefined ? { maxPrice: params.price } : {}),
                orderType,
              })
            : await client.placeMarketOrder({
                tokenId: params.tokenId,
                side: OrderSide.SELL,
                shares: params.amount,
                ...(params.price !== undefined ? { minPrice: params.price } : {}),
                orderType,
              });
        if (result.ok) {
          return {
            success: true,
            orderId: String(result.orderId),
            transactionHashes: (result.transactionsHashes || []).map(String),
          };
        }
        return { success: false, errorMsg: result.message || String(result.code) };
      } catch (error) {
        return {
          success: false,
          errorMsg: `Market order failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  }
}
