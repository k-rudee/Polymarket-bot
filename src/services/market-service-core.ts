/**
 * MarketService - client init + CLOB market/orderbook APIs.
 */
import {
  createPublicClient,
  createSecureClient,
  type PublicClient,
  type SecureClient,
} from '@polymarket/client';
import { signerFrom } from '@polymarket/client/ethers-v5';
import { Wallet } from 'ethers';
import { CACHE_TTL } from '../core/unified-cache.js';
import { ApiType } from '../core/rate-limiter.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';
import type { ProcessedOrderbook, Orderbook, Side } from '../core/types.js';
import {
  type Market,
  type ResolvedMarketTokens,
} from './market-service-types.js';

import { MarketServiceHelpers } from './market-service-helpers.js';

export class MarketServiceCore extends MarketServiceHelpers {
  protected publicClient: PublicClient | null = null;
  protected secureClient: SecureClient | null = null;
  protected initialized = false;

  protected async ensureInitialized(): Promise<PublicClient | SecureClient> {
    if (!this.initialized || (!this.publicClient && !this.secureClient)) {
      if (this.config?.privateKey) {
        const wallet = new Wallet(this.config.privateKey);
        this.secureClient = await createSecureClient({
          signer: signerFrom(wallet as any),
        });
      } else {
        this.publicClient = createPublicClient();
      }
      this.initialized = true;
    }
    return (this.secureClient || this.publicClient)!;
  }

  async getClobMarket(conditionId: string): Promise<Market | null> {
    const cacheKey = `clob:market:${conditionId}`;
    return this.cache.getOrSet(cacheKey, CACHE_TTL.MARKET_INFO, async () => {
      const client = await this.ensureInitialized();
      return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
        try {
          const page = await client
            .listMarkets({ conditionIds: [conditionId] })
            .firstPage();
          const market = page.items[0];
          if (!market) {
            return null;
          }
          return this.normalizeUnifiedMarket(market);
        } catch (error) {
          if (error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 404) {
            return null;
          }
          throw error;
        }
      });
    });
  }

  async resolveMarketTokens(conditionId: string): Promise<ResolvedMarketTokens | null> {
    try {
      const market = await this.getClobMarket(conditionId);
      if (!market?.tokens?.length || market.tokens.length < 2) {
        return null;
      }
      const primary = market.tokens[0];
      const secondary = market.tokens[1];
      return {
        primaryTokenId: primary.tokenId,
        secondaryTokenId: secondary.tokenId,
        outcomes: [primary.outcome, secondary.outcome],
        primaryOutcome: primary.outcome,
        secondaryOutcome: secondary.outcome,
      };
    } catch {
      return null;
    }
  }

  async getClobMarkets(nextCursor?: string): Promise<{ markets: Market[]; nextCursor: string }> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const paginator = client.listMarkets({
        closed: false,
        pageSize: 100,
        ...(nextCursor ? { cursor: nextCursor as any } : {}),
      });
      const page = nextCursor && typeof (paginator as any).from === 'function'
        ? await (paginator as any).from(nextCursor).firstPage()
        : await paginator.firstPage();
      return {
        markets: page.items.map((m: any) => this.normalizeUnifiedMarket(m)),
        nextCursor: page.nextCursor ? String(page.nextCursor) : '',
      };
    });
  }

  async getTokenOrderbook(tokenId: string): Promise<Orderbook> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const book = await client.fetchOrderBook({ tokenId });
      const bids = (book.bids || [])
        .map((l: { price: string | number; size: string | number }) => ({
          price: parseFloat(String(l.price)),
          size: parseFloat(String(l.size)),
        }))
        .sort((a, b) => b.price - a.price);
      const asks = (book.asks || [])
        .map((l: { price: string | number; size: string | number }) => ({
          price: parseFloat(String(l.price)),
          size: parseFloat(String(l.size)),
        }))
        .sort((a, b) => a.price - b.price);
      const assetId = String((book as any).assetId ?? (book as any).tokenId ?? tokenId);
      const tsRaw = (book as any).timestamp;
      const timestamp =
        typeof tsRaw === 'number'
          ? tsRaw
          : parseInt(String(tsRaw || '0'), 10) || Date.now();
      return {
        tokenId: assetId,
        assetId,
        bids,
        asks,
        timestamp,
        market: String((book as any).conditionId ?? (book as any).market ?? ''),
        hash: String((book as any).hash ?? ''),
      };
    });
  }

  async getTokenOrderbooks(
    params: Array<{ tokenId: string; side: Side }>
  ): Promise<Map<string, Orderbook>> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const bookParams = params.map(p => ({ tokenId: p.tokenId }));
      const books = await client.fetchOrderBooks(bookParams);
      const result = new Map<string, Orderbook>();
      for (const book of books) {
        const bids = (book.bids || [])
          .map((l: { price: string | number; size: string | number }) => ({
            price: parseFloat(String(l.price)),
            size: parseFloat(String(l.size)),
          }))
          .sort((a, b) => b.price - a.price);
        const asks = (book.asks || [])
          .map((l: { price: string | number; size: string | number }) => ({
            price: parseFloat(String(l.price)),
            size: parseFloat(String(l.size)),
          }))
          .sort((a, b) => a.price - b.price);
        const assetId = String((book as any).assetId ?? (book as any).tokenId ?? '');
        const tsRaw = (book as any).timestamp;
        const timestamp =
          typeof tsRaw === 'number'
            ? tsRaw
            : parseInt(String(tsRaw || '0'), 10) || Date.now();
        result.set(assetId, {
          tokenId: assetId,
          assetId,
          bids,
          asks,
          timestamp,
          market: String((book as any).conditionId ?? (book as any).market ?? ''),
          hash: String((book as any).hash ?? ''),
        });
      }
      return result;
    });
  }

  async getProcessedOrderbook(conditionId: string): Promise<ProcessedOrderbook> {
    const market = await this.getClobMarket(conditionId);
    if (!market) {
      throw new PolymarketError(ErrorCode.MARKET_NOT_FOUND, `Market not found: ${conditionId}`);
    }
    const yesToken = market.tokens[0];
    const noToken = market.tokens[1];
    if (!yesToken || !noToken) {
      throw new PolymarketError(ErrorCode.INVALID_RESPONSE, 'Missing tokens in market');
    }
    const [yesBook, noBook] = await Promise.all([
      this.getTokenOrderbook(yesToken.tokenId),
      this.getTokenOrderbook(noToken.tokenId),
    ]);
    return this.processOrderbooks(yesBook, noBook, yesToken.tokenId, noToken.tokenId);
  }
}
