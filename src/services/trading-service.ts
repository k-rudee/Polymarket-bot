/**
 * TradingService public entry — keep import path `./trading-service.js` stable.
 */
export {
  POLYGON_MAINNET,
  POLYGON_AMOY,
  MIN_ORDER_VALUE_USDC,
  MIN_ORDER_SIZE_SHARES,
  type ApiCredentials,
  type TradingServiceConfig,
  type LimitOrderParams,
  type MarketOrderParams,
  type Order,
  type OrderResult,
  type TradeInfo,
  type UserEarning,
  type MarketReward,
} from './trading-types.js';
export type { Side, OrderType } from '../core/types.js';
export { TradingService } from './trading-service-account.js';
