/**
 * MarketService - arbitrage, gamma search, crypto short-term scan.
 */
import { PolymarketError, ErrorCode } from '../core/errors.js';
import type { ArbitrageOpportunity } from '../core/types.js';
import type { GammaMarket } from '../clients/gamma-api.js';
import { MarketServiceAnalysis } from './market-service-analysis.js';

export class MarketService extends MarketServiceAnalysis {
  async detectArbitrage(conditionId: string, threshold = 0.005): Promise<ArbitrageOpportunity | null> {
    const orderbook = await this.getOrderbook(conditionId);
    const { effectivePrices } = orderbook.summary;

    if (orderbook.summary.longArbProfit > threshold) {
      return {
        type: 'long',
        profit: orderbook.summary.longArbProfit,
        action: `Buy YES @ ${effectivePrices.effectiveBuyYes.toFixed(4)} + NO @ ${effectivePrices.effectiveBuyNo.toFixed(4)}, Merge for $1`,
        expectedProfit: orderbook.summary.longArbProfit,
      };
    }

    if (orderbook.summary.shortArbProfit > threshold) {
      return {
        type: 'short',
        profit: orderbook.summary.shortArbProfit,
        action: `Split $1, Sell YES @ ${effectivePrices.effectiveSellYes.toFixed(4)} + NO @ ${effectivePrices.effectiveSellNo.toFixed(4)}`,
        expectedProfit: orderbook.summary.shortArbProfit,
      };
    }

    return null;
  }

  async getTrendingMarkets(limit = 20): Promise<GammaMarket[]> {
    if (!this.gammaApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'GammaApiClient is required for trending markets');
    }
    return this.gammaApi.getTrendingMarkets(limit);
  }

  async searchMarkets(params: {
    active?: boolean;
    closed?: boolean;
    limit?: number;
    offset?: number;
    order?: string;
  }): Promise<GammaMarket[]> {
    if (!this.gammaApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'GammaApiClient is required for market search');
    }
    return this.gammaApi.getMarkets(params);
  }

  async scanCryptoShortTermMarkets(options?: {
    minMinutesUntilEnd?: number;
    maxMinutesUntilEnd?: number;
    limit?: number;
    sortBy?: 'endDate' | 'volume' | 'liquidity';
    duration?: '5m' | '15m' | 'all';
    coin?: 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'all';
  }): Promise<GammaMarket[]> {
    if (!this.gammaApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'GammaApiClient is required for market scanning');
    }

    const {
      minMinutesUntilEnd = 5,
      maxMinutesUntilEnd = 60,
      limit = 20,
      sortBy = 'endDate',
      duration = 'all',
      coin = 'all',
    } = options ?? {};

    const durationIntervals: Record<string, number> = {
      '5m': 300,
      '15m': 900,
    };

    const allCoins = ['btc', 'eth', 'sol', 'xrp'] as const;
    const targetCoins = coin === 'all' ? allCoins : [coin.toLowerCase()];
    const targetDurations = duration === 'all' ? ['5m', '15m'] : [duration];

    const nowSeconds = Math.floor(Date.now() / 1000);
    const minEndSeconds = nowSeconds + minMinutesUntilEnd * 60;
    const maxEndSeconds = nowSeconds + maxMinutesUntilEnd * 60;

    const slugsToFetch: string[] = [];

    for (const dur of targetDurations) {
      const intervalSeconds = durationIntervals[dur];
      const durationStr = dur.replace('m', 'm');
      const minSlotStart = Math.floor((minEndSeconds - intervalSeconds) / intervalSeconds) * intervalSeconds;
      const maxSlotStart = Math.ceil(maxEndSeconds / intervalSeconds) * intervalSeconds;

      for (let slotStart = minSlotStart; slotStart <= maxSlotStart; slotStart += intervalSeconds) {
        for (const coinName of targetCoins) {
          slugsToFetch.push(`${coinName}-updown-${durationStr}-${slotStart}`);
        }
      }
    }

    const BATCH_SIZE = 10;
    const allMarkets: GammaMarket[] = [];

    for (let i = 0; i < slugsToFetch.length; i += BATCH_SIZE) {
      const batch = slugsToFetch.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (slug) => {
          try {
            const markets = await this.gammaApi!.getMarkets({ slug, limit: 1 });
            return markets.length > 0 ? markets[0] : null;
          } catch {
            return null;
          }
        })
      );

      for (const market of results) {
        if (market && market.active && !market.closed) {
          allMarkets.push(market);
        }
      }
    }

    const nowMs = Date.now();
    const minEndTime = nowMs + minMinutesUntilEnd * 60 * 1000;
    const maxEndTime = nowMs + maxMinutesUntilEnd * 60 * 1000;

    const filteredMarkets = allMarkets.filter((market) => {
      const endTime = market.endDate ? new Date(market.endDate).getTime() : 0;
      return endTime >= minEndTime && endTime <= maxEndTime;
    });

    if (sortBy === 'volume') {
      filteredMarkets.sort((a, b) => (b.volume24hr ?? 0) - (a.volume24hr ?? 0));
    } else if (sortBy === 'liquidity') {
      filteredMarkets.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
    } else {
      filteredMarkets.sort((a, b) => {
        const aEnd = a.endDate ? new Date(a.endDate).getTime() : Infinity;
        const bEnd = b.endDate ? new Date(b.endDate).getTime() : Infinity;
        return aEnd - bEnd;
      });
    }

    return filteredMarkets.slice(0, limit);
  }

  async detectMarketSignals(conditionId: string): Promise<
    Array<{
      type: 'volume_surge' | 'depth_imbalance' | 'whale_trade' | 'momentum';
      severity: 'low' | 'medium' | 'high';
      details: Record<string, unknown>;
    }>
  > {
    const signals: Array<{
      type: 'volume_surge' | 'depth_imbalance' | 'whale_trade' | 'momentum';
      severity: 'low' | 'medium' | 'high';
      details: Record<string, unknown>;
    }> = [];

    if (!this.dataApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'DataApiClient is required for signal detection');
    }
    const market = await this.getMarket(conditionId);
    const orderbook = await this.getOrderbook(conditionId);
    const trades = await this.dataApi.getTradesByMarket(conditionId, 100);

    if (market.volume24hr && market.volume > 0) {
      const avgDaily = market.volume / 7;
      const ratio = market.volume24hr / avgDaily;
      if (ratio > 2) {
        signals.push({
          type: 'volume_surge',
          severity: ratio > 5 ? 'high' : ratio > 3 ? 'medium' : 'low',
          details: { volume24hr: market.volume24hr, avgDaily, ratio },
        });
      }
    }

    if (orderbook.summary.imbalanceRatio > 1.5 || orderbook.summary.imbalanceRatio < 0.67) {
      const ratio = orderbook.summary.imbalanceRatio;
      signals.push({
        type: 'depth_imbalance',
        severity: ratio > 3 || ratio < 0.33 ? 'high' : 'medium',
        details: {
          imbalanceRatio: ratio,
          bidDepth: orderbook.summary.totalBidDepth,
          askDepth: orderbook.summary.totalAskDepth,
          direction: ratio > 1 ? 'BUY_PRESSURE' : 'SELL_PRESSURE',
        },
      });
    }

    const recentLargeTrades = trades.filter((t) => t.size * t.price > 1000);
    for (const trade of recentLargeTrades.slice(0, 3)) {
      const value = trade.size * trade.price;
      signals.push({
        type: 'whale_trade',
        severity: value > 10000 ? 'high' : value > 5000 ? 'medium' : 'low',
        details: {
          size: trade.size,
          price: trade.price,
          usdValue: value,
          side: trade.side,
          outcome: trade.outcome,
        },
      });
    }

    return signals;
  }
}

export {
  POLYGON_MAINNET,
  UNDERLYING_TO_SYMBOL,
  type PriceHistoryParams,
  type PricePoint,
  type MarketServiceConfig,
  type Market,
  type MarketToken,
  type ResolvedMarketTokens,
  type ClobMarket,
} from './market-service-types.js';
