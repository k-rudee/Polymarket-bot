import type { Side, OrderType } from '../core/types.js';
import type { SecureClient } from '@polymarket/client';

export type { Side, OrderType } from '../core/types.js';

export const POLYGON_MAINNET = 137;
export const POLYGON_AMOY = 80002;
export const MIN_ORDER_VALUE_USDC = 1;
export const MIN_ORDER_SIZE_SHARES = 5;

export interface ApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

export interface TradingServiceConfig {
  privateKey: string;
  chainId?: number;
  credentials?: ApiCredentials;
  walletAddress?: string;
}

export interface LimitOrderParams {
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD';
  expiration?: number;
}

export interface MarketOrderParams {
  tokenId: string;
  side: Side;
  amount: number;
  price?: number;
  orderType?: 'FOK' | 'FAK';
}

export interface Order {
  id: string;
  status: string;
  tokenId: string;
  side: Side;
  price: number;
  originalSize: number;
  filledSize: number;
  remainingSize: number;
  associateTrades: string[];
  createdAt: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  orderIds?: string[];
  errorMsg?: string;
  transactionHashes?: string[];
}

export interface TradeInfo {
  id: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  fee: number;
  timestamp: number;
}

export interface UserEarning {
  date: string;
  conditionId: string;
  assetAddress: string;
  makerAddress: string;
  earnings: number;
  assetRate: number;
}

export interface MarketReward {
  conditionId: string;
  question: string;
  marketSlug: string;
  eventSlug: string;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  tokens: Array<{ tokenId: string; outcome: string; price: number }>;
  rewardsConfig: Array<{
    assetAddress: string;
    startDate: string;
    endDate: string;
    ratePerDay: number;
    totalRewards: number;
  }>;
}

export type AnySecureClient = SecureClient;

export function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value) {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1e12 ? asNum * 1000 : asNum;
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

export async function collectPaginatorItems<T>(paginator: {
  firstPage: () => Promise<{ items: T[]; nextCursor?: unknown }>;
  from?: (cursor: unknown) => { firstPage: () => Promise<{ items: T[]; nextCursor?: unknown }> };
  [Symbol.asyncIterator]?: () => AsyncIterator<{ items: T[] }>;
}): Promise<T[]> {
  const items: T[] = [];
  if (typeof paginator[Symbol.asyncIterator] === 'function') {
    for await (const page of paginator as AsyncIterable<{ items: T[] }>) {
      items.push(...page.items);
    }
    return items;
  }
  let page = await paginator.firstPage();
  items.push(...page.items);
  while (page.nextCursor && paginator.from) {
    page = await paginator.from(page.nextCursor).firstPage();
    items.push(...page.items);
  }
  return items;
}
