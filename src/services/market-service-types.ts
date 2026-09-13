/**
 * Shared types/constants for MarketService (@polymarket/client).
 */
import type { KLineInterval } from '../core/types.js';
import type { BinanceInterval } from './binance-service.js';

// Chain IDs
export const POLYGON_MAINNET = 137;

/**
 * Normalize timestamp to milliseconds.
 * Polymarket API sometimes returns timestamps in seconds.
 * Timestamps < 1e12 (year ~2001 in ms) are assumed to be in seconds.
 */
export function normalizeTimestamp(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

// Mapping from underlying asset to Binance symbol
export const UNDERLYING_TO_SYMBOL = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
} as const;

// Map from KLineInterval to BinanceInterval (Binance doesn't support 30s or 12h)
export const KLINE_TO_BINANCE_INTERVAL: Partial<Record<KLineInterval, BinanceInterval>> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

// Side and Orderbook are imported from core/types.ts
// Re-export for backward compatibility
export type { Side, Orderbook } from '../core/types.js';

export type PriceHistoryIntervalString = '1h' | '6h' | '1d' | '1w' | 'max';

export interface PriceHistoryParams {
  tokenId: string;
  interval?: PriceHistoryIntervalString;
  startTs?: number;
  endTs?: number;
  fidelity?: number;
}

export interface PricePoint {
  timestamp: number;
  price: number;
}

export interface MarketServiceConfig {
  /** Private key for CLOB client auth (optional, for authenticated endpoints) */
  privateKey?: string;
  /** Chain ID (default: Polygon mainnet 137) */
  chainId?: number;
}

// Internal type for CLOB market data
export interface ClobMarket {
  condition_id: string;
  question_id?: string;
  market_slug: string;
  question: string;
  description?: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner?: boolean;
  }>;
  active: boolean;
  closed: boolean;
  accepting_orders: boolean;
  end_date_iso?: string | null;
  neg_risk?: boolean;
  minimum_order_size?: number;
  minimum_tick_size?: number;
}

/**
 * CLOB Market type (from CLOB API)
 */
export interface Market {
  conditionId: string;
  questionId?: string;
  marketSlug: string;
  question: string;
  description?: string;
  tokens: MarketToken[];
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  endDateIso?: string | null;
  negRisk?: boolean;
  minimumOrderSize?: number;
  minimumTickSize?: number;
}

export interface MarketToken {
  tokenId: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

export interface ResolvedMarketTokens {
  /** Primary outcome token ID (index 0: Yes/Up/Team1) */
  primaryTokenId: string;
  /** Secondary outcome token ID (index 1: No/Down/Team2) */
  secondaryTokenId: string;
  outcomes: [string, string];
  primaryOutcome: string;
  secondaryOutcome: string;
}
