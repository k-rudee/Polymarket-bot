/**
 * MarketService - realtime spread wrappers.
 */
import type { ProcessedOrderbook, RealtimeSpreadAnalysis } from '../core/types.js';
import { MarketServiceKlines } from './market-service-klines.js';

export class MarketServiceAnalysis extends MarketServiceKlines {
  async getRealtimeSpread(conditionId: string): Promise<RealtimeSpreadAnalysis> {
    const orderbook = await this.getProcessedOrderbook(conditionId);
    return this.calculateRealtimeSpread(orderbook);
  }

  async getOrderbook(conditionId: string): Promise<ProcessedOrderbook> {
    return this.getProcessedOrderbook(conditionId);
  }
}
