/**
 * MarketService - token vs underlying correlation.
 */
import { PolymarketError, ErrorCode } from '../core/errors.js';
import type {
  KLineInterval,
  UnderlyingAsset,
  TokenUnderlyingCorrelation,
  TokenUnderlyingDataPoint,
} from '../core/types.js';
import type { BinanceInterval } from './binance-service.js';
import {
  UNDERLYING_TO_SYMBOL,
  KLINE_TO_BINANCE_INTERVAL,
} from './market-service-types.js';
import { MarketServiceCandles } from './market-service-candles.js';

export class MarketServiceKlines extends MarketServiceCandles {
  async getTokenUnderlyingData(
    conditionId: string,
    underlying: UnderlyingAsset,
    interval: KLineInterval,
    options?: {
      limit?: number;
      calculateCorrelation?: boolean;
    }
  ): Promise<TokenUnderlyingCorrelation> {
    if (!this.binanceService) {
      throw new PolymarketError(
        ErrorCode.INVALID_CONFIG,
        'BinanceService is required for token-underlying correlation analysis'
      );
    }

    const binanceInterval = KLINE_TO_BINANCE_INTERVAL[interval];
    if (!binanceInterval) {
      throw new PolymarketError(
        ErrorCode.INVALID_CONFIG,
        `Interval ${interval} is not supported for correlation analysis. ` +
        `Supported intervals: ${Object.keys(KLINE_TO_BINANCE_INTERVAL).join(', ')}`
      );
    }

    const limit = options?.limit || 500;

    const [dualKLines, binanceKLines] = await Promise.all([
      this.getDualKLines(conditionId, interval, { limit }),
      this.binanceService.getKLines(
        UNDERLYING_TO_SYMBOL[underlying],
        binanceInterval,
        { limit }
      ),
    ]);

    const upMap = new Map(dualKLines.yes.map(c => [c.timestamp, c.close]));
    const downMap = new Map(dualKLines.no.map(c => [c.timestamp, c.close]));
    const binanceMap = new Map(binanceKLines.map(c => [c.timestamp, c.close]));

    const allTimestamps = new Set([
      ...upMap.keys(),
      ...downMap.keys(),
      ...binanceMap.keys(),
    ]);
    const sortedTimestamps = [...allTimestamps].sort((a, b) => a - b);

    const firstBinancePrice = binanceKLines.length > 0 ? binanceKLines[0].close : 0;

    const alignedData: TokenUnderlyingDataPoint[] = [];
    let lastUpPrice: number | undefined;
    let lastDownPrice: number | undefined;
    let lastBinancePrice: number | undefined;

    for (const timestamp of sortedTimestamps) {
      const upPrice = upMap.get(timestamp) ?? this.findNearestPrice(timestamp, upMap, sortedTimestamps);
      const downPrice = downMap.get(timestamp) ?? this.findNearestPrice(timestamp, downMap, sortedTimestamps);
      const binancePrice = binanceMap.get(timestamp) ?? this.findNearestPrice(timestamp, binanceMap, sortedTimestamps);

      if (upPrice !== undefined) lastUpPrice = upPrice;
      if (downPrice !== undefined) lastDownPrice = downPrice;
      if (binancePrice !== undefined) lastBinancePrice = binancePrice;

      if (lastBinancePrice === undefined) continue;

      const priceSum = (lastUpPrice !== undefined && lastDownPrice !== undefined)
        ? lastUpPrice + lastDownPrice
        : undefined;

      const underlyingChange = firstBinancePrice > 0
        ? ((lastBinancePrice - firstBinancePrice) / firstBinancePrice) * 100
        : 0;

      alignedData.push({
        timestamp,
        upPrice: lastUpPrice,
        downPrice: lastDownPrice,
        priceSum,
        underlyingPrice: lastBinancePrice,
        underlyingChange,
      });
    }

    let correlation: TokenUnderlyingCorrelation['correlation'];
    if (options?.calculateCorrelation && alignedData.length >= 2) {
      correlation = this.calculatePearsonCorrelation(alignedData);
    }

    return {
      conditionId,
      underlying,
      interval,
      data: alignedData,
      correlation,
    };
  }

  private findNearestPrice(
    targetTimestamp: number,
    priceMap: Map<number, number>,
    sortedTimestamps: number[]
  ): number | undefined {
    if (priceMap.size === 0) return undefined;

    let nearestTimestamp: number | undefined;
    let minDiff = Infinity;

    for (const ts of sortedTimestamps) {
      if (priceMap.has(ts)) {
        const diff = Math.abs(ts - targetTimestamp);
        if (diff < minDiff) {
          minDiff = diff;
          nearestTimestamp = ts;
        }
      }
    }

    return nearestTimestamp !== undefined ? priceMap.get(nearestTimestamp) : undefined;
  }

  private calculatePearsonCorrelation(
    data: TokenUnderlyingDataPoint[]
  ): TokenUnderlyingCorrelation['correlation'] {
    const upData = data.filter(d => d.upPrice !== undefined && d.underlyingPrice !== undefined);
    const downData = data.filter(d => d.downPrice !== undefined && d.underlyingPrice !== undefined);

    const upVsUnderlying = this.pearson(
      upData.map(d => d.upPrice!),
      upData.map(d => d.underlyingPrice)
    );

    const downVsUnderlying = this.pearson(
      downData.map(d => d.downPrice!),
      downData.map(d => d.underlyingPrice)
    );

    return {
      upVsUnderlying,
      downVsUnderlying,
    };
  }

  private pearson(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;

    let sumX = 0, sumY = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
    }
    const meanX = sumX / n;
    const meanY = sumY / n;

    let numerator = 0;
    let sumSqX = 0;
    let sumSqY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      numerator += dx * dy;
      sumSqX += dx * dx;
      sumSqY += dy * dy;
    }

    const denominator = Math.sqrt(sumSqX * sumSqY);
    if (denominator === 0) return 0;

    return numerator / denominator;
  }
}
