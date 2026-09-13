/**
 * MarketService — midpoint/spread/history + unified getMarket.
 */
import { PriceHistoryInterval } from '@polymarket/client';
import { ApiType } from '../core/rate-limiter.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';
import type { UnifiedMarket } from '../core/types.js';
import type { GammaMarket } from '../clients/gamma-api.js';
import type { PriceHistoryParams, PricePoint, Market, PriceHistoryIntervalString } from './market-service-types.js';
import { MarketServiceCore } from './market-service-core.js';

export class MarketServicePrices extends MarketServiceCore {
  async getPricesHistory(params: PriceHistoryParams): Promise<PricePoint[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const intervalMap: Record<PriceHistoryIntervalString, PriceHistoryInterval> = {
        '1h': PriceHistoryInterval.OneHour,
        '6h': PriceHistoryInterval.SixHours,
        '1d': PriceHistoryInterval.OneDay,
        '1w': PriceHistoryInterval.OneWeek,
        'max': PriceHistoryInterval.Max,
      };

      const request: any = {
        assetId: params.tokenId,
      };
      if (params.startTs !== undefined || params.endTs !== undefined) {
        request.start = params.startTs;
        request.end = params.endTs;
        if (params.fidelity) request.bucketSeconds = params.fidelity;
      } else {
        request.interval = params.interval
          ? intervalMap[params.interval]
          : PriceHistoryInterval.OneDay;
        if (params.fidelity) request.bucketSeconds = params.fidelity;
      }

      const pages = client.listPriceHistory(request);
      const points: PricePoint[] = [];
      for await (const page of pages as any) {
        for (const pt of page.items as Array<{ timestamp: number; price: string | number }>) {
          points.push({
            timestamp: Number(pt.timestamp),
            price: Number(pt.price),
          });
        }
      }
      return points;
    });
  }

  async getMidpoint(tokenId: string): Promise<number> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const midpoint = await client.fetchMidpoint({ tokenId });
      return Number(midpoint);
    });
  }

  async getSpread(tokenId: string): Promise<number> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const spread = await client.fetchSpread({ tokenId });
      return Number(spread);
    });
  }

  async getLastTradePrice(tokenId: string): Promise<number> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const last = await client.fetchLastTradePrice({ tokenId });
      if (last == null) return 0;
      if (typeof last === 'object' && last !== null && 'price' in last) {
        return Number((last as { price: string | number }).price) || 0;
      }
      return Number(last) || 0;
    });
  }

  async getMarket(identifier: string): Promise<UnifiedMarket> {
    const isConditionId = identifier.startsWith('0x') || /^\d+$/.test(identifier);

    if (isConditionId) {
      return this.getMarketByConditionId(identifier);
    } else {
      return this.getMarketBySlug(identifier);
    }
  }

  private async getMarketBySlug(slug: string): Promise<UnifiedMarket> {
    if (!this.gammaApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'GammaApiClient is required for slug-based lookups');
    }
    const gammaMarket = await this.gammaApi.getMarketBySlug(slug);
    if (!gammaMarket) {
      throw new PolymarketError(ErrorCode.MARKET_NOT_FOUND, `Market not found: ${slug}`);
    }

    try {
      const clobMarket = await this.getClobMarket(gammaMarket.conditionId);
      if (clobMarket) {
        return this.mergeMarkets(gammaMarket, clobMarket);
      }
      return this.fromGammaMarket(gammaMarket);
    } catch {
      return this.fromGammaMarket(gammaMarket);
    }
  }

  private async getMarketByConditionId(conditionId: string): Promise<UnifiedMarket> {
    let clobMarket: Market | null = null;
    let gammaMarket: GammaMarket | null = null;

    try {
      clobMarket = await this.getClobMarket(conditionId);
    } catch {
      // CLOB failed, continue to try Gamma
    }

    if (this.gammaApi) {
      try {
        gammaMarket = await this.gammaApi.getMarketByConditionId(conditionId);
      } catch {
        // Gamma failed
      }
    }

    if (gammaMarket && clobMarket) {
      return this.mergeMarkets(gammaMarket, clobMarket);
    }

    if (gammaMarket) {
      return this.fromGammaMarket(gammaMarket);
    }

    if (clobMarket) {
      const market = this.fromClobMarket(clobMarket);
      const questionWords = clobMarket.question.toLowerCase().split(/\s+/).slice(0, 3);
      const slugWords = clobMarket.marketSlug.toLowerCase().split('-');
      const hasMatchingWord = questionWords.some(qw =>
        slugWords.some(sw => sw.includes(qw) || qw.includes(sw))
      );
      if (!hasMatchingWord && clobMarket.marketSlug.length > 0) {
        market.slug = `market-${conditionId.slice(0, 10)}`;
      }
      return market;
    }

    throw new PolymarketError(ErrorCode.MARKET_NOT_FOUND, `Market not found: ${conditionId}`);
  }
}
