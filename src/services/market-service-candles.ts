/**
 * MarketService - K-line aggregation.
 */
import type { Trade } from '../clients/data-api.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';
import type {
  ProcessedOrderbook,
  KLineInterval,
  KLineCandle,
  DualKLineData,
  SpreadDataPoint,
  RealtimeSpreadAnalysis,
} from '../core/types.js';
import { normalizeTimestamp } from './market-service-types.js';
import { getIntervalMs } from './market-service-helpers.js';
import { MarketServicePrices } from './market-service-prices.js';

export class MarketServiceCandles extends MarketServicePrices {
  async getKLines(
    conditionId: string,
    interval: KLineInterval,
    options?: {
      limit?: number;
      tokenId?: string;
      outcomeIndex?: number;
      startTimestamp?: number;
      endTimestamp?: number;
    }
  ): Promise<KLineCandle[]> {
    if (!this.dataApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'DataApiClient is required for K-Line data');
    }
    const trades = await this.dataApi.getTrades({
      market: conditionId,
      limit: options?.limit || 1000,
      startTimestamp: options?.startTimestamp,
      endTimestamp: options?.endTimestamp,
    });

    let filteredTrades = trades;
    if (options?.tokenId) {
      filteredTrades = trades.filter((t) => t.asset === options.tokenId);
    } else if (options?.outcomeIndex !== undefined) {
      filteredTrades = trades.filter((t) => t.outcomeIndex === options.outcomeIndex);
    }

    return this.aggregateToKLines(filteredTrades, interval);
  }

  async getDualKLines(
    conditionId: string,
    interval: KLineInterval,
    options?: {
      limit?: number;
      startTimestamp?: number;
      endTimestamp?: number;
    }
  ): Promise<DualKLineData> {
    if (!this.dataApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'DataApiClient is required for K-Line data');
    }
    const market = await this.getMarket(conditionId);
    const trades = await this.dataApi.getTrades({
      market: conditionId,
      limit: options?.limit || 1000,
      startTimestamp: options?.startTimestamp,
      endTimestamp: options?.endTimestamp,
    });

    const yesTrades = trades.filter((t) => t.outcomeIndex === 0);
    const noTrades = trades.filter((t) => t.outcomeIndex === 1);

    const yesCandles = this.aggregateToKLines(yesTrades, interval);
    const noCandles = this.aggregateToKLines(noTrades, interval);

    let currentOrderbook: ProcessedOrderbook | undefined;
    let realtimeSpread: RealtimeSpreadAnalysis | undefined;
    try {
      currentOrderbook = await this.getProcessedOrderbook(conditionId);
      realtimeSpread = this.calculateRealtimeSpread(currentOrderbook);
    } catch {
    }

    const spreadAnalysis = this.analyzeHistoricalSpread(yesCandles, noCandles);

    return {
      conditionId,
      interval,
      market,
      yes: yesCandles,
      no: noCandles,
      spreadAnalysis,
      realtimeSpread,
      currentOrderbook,
    };
  }

  private aggregateToKLines(trades: Trade[], interval: KLineInterval): KLineCandle[] {
    const intervalMs = getIntervalMs(interval);
    const buckets = new Map<number, Trade[]>();

    for (const trade of trades) {
      const tradeTs = normalizeTimestamp(trade.timestamp);
      const bucketTime = Math.floor(tradeTs / intervalMs) * intervalMs;
      const bucket = buckets.get(bucketTime) || [];
      bucket.push(trade);
      buckets.set(bucketTime, bucket);
    }

    const candles: KLineCandle[] = [];
    for (const [timestamp, bucketTrades] of buckets) {
      if (bucketTrades.length === 0) continue;

      bucketTrades.sort((a, b) => normalizeTimestamp(a.timestamp) - normalizeTimestamp(b.timestamp));

      const prices = bucketTrades.map((t) => t.price);
      const buyTrades = bucketTrades.filter((t) => t.side === 'BUY');
      const sellTrades = bucketTrades.filter((t) => t.side === 'SELL');

      candles.push({
        timestamp,
        open: bucketTrades[0].price,
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: bucketTrades[bucketTrades.length - 1].price,
        volume: bucketTrades.reduce((sum, t) => sum + t.size * t.price, 0),
        tradeCount: bucketTrades.length,
        buyVolume: buyTrades.reduce((sum, t) => sum + t.size * t.price, 0),
        sellVolume: sellTrades.reduce((sum, t) => sum + t.size * t.price, 0),
      });
    }

    return candles.sort((a, b) => a.timestamp - b.timestamp);
  }

  private analyzeHistoricalSpread(
    yesCandles: KLineCandle[],
    noCandles: KLineCandle[]
  ): SpreadDataPoint[] {
    const yesMap = new Map(yesCandles.map((c) => [c.timestamp, c]));
    const noMap = new Map(noCandles.map((c) => [c.timestamp, c]));

    const allTimestamps = [...new Set([...yesMap.keys(), ...noMap.keys()])].sort();

    let lastYes = 0.5;
    let lastNo = 0.5;
    const analysis: SpreadDataPoint[] = [];

    for (const ts of allTimestamps) {
      const yesCandle = yesMap.get(ts);
      const noCandle = noMap.get(ts);

      if (yesCandle) lastYes = yesCandle.close;
      if (noCandle) lastNo = noCandle.close;

      const priceSum = lastYes + lastNo;
      const priceSpread = priceSum - 1;

      let arbOpportunity: 'LONG' | 'SHORT' | '' = '';
      if (priceSpread < -0.005) arbOpportunity = 'LONG';
      else if (priceSpread > 0.005) arbOpportunity = 'SHORT';

      analysis.push({
        timestamp: ts,
        yesPrice: lastYes,
        noPrice: lastNo,
        priceSum,
        priceSpread,
        arbOpportunity,
      });
    }

    return analysis;
  }

  protected calculateRealtimeSpread(orderbook: ProcessedOrderbook): RealtimeSpreadAnalysis {
    const { yes, no, summary } = orderbook;

    let arbOpportunity: 'LONG' | 'SHORT' | '' = '';
    let arbProfitPercent = 0;

    if (summary.longArbProfit > 0.001) {
      arbOpportunity = 'LONG';
      arbProfitPercent = summary.longArbProfit * 100;
    } else if (summary.shortArbProfit > 0.001) {
      arbOpportunity = 'SHORT';
      arbProfitPercent = summary.shortArbProfit * 100;
    }

    return {
      timestamp: Date.now(),
      yesBid: yes.bid,
      yesAsk: yes.ask,
      noBid: no.bid,
      noAsk: no.ask,
      askSum: summary.askSum,
      bidSum: summary.bidSum,
      askSpread: summary.askSum - 1,
      bidSpread: summary.bidSum - 1,
      longArbProfit: summary.longArbProfit,
      shortArbProfit: summary.shortArbProfit,
      arbOpportunity,
      arbProfitPercent,
    };
  }
}
