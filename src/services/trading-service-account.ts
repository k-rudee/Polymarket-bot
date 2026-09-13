import { AssetType } from '@polymarket/client';
import {
  fetchBalanceAllowance,
  updateBalanceAllowance,
} from '@polymarket/client/actions';
import { Wallet } from 'ethers';
import { ApiType } from '../core/rate-limiter.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';
import type { Side } from '../core/types.js';
import {
  type Order,
  type OrderResult,
  type TradeInfo,
  type UserEarning,
  type MarketReward,
  type ApiCredentials,
  type AnySecureClient,
  toEpochMs,
  collectPaginatorItems,
} from './trading-types.js';
import { TradingServiceBase } from './trading-service-orders.js';

/** Order management, rewards, balances, account accessors */
export class TradingService extends TradingServiceBase {
  async cancelOrder(orderId: string): Promise<OrderResult> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrder({ orderId });
        return {
          success: Array.isArray(result.canceled) ? result.canceled.length > 0 : Boolean(result.canceled),
          orderId,
        };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelOrders(orderIds: string[]): Promise<OrderResult> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrders({ orderIds });
        return {
          success: Array.isArray(result.canceled) ? result.canceled.length > 0 : Boolean(result.canceled),
          orderIds,
        };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel orders failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelAllOrders(): Promise<OrderResult> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelAll();
        return {
          success: Array.isArray(result.canceled) ? result.canceled.length > 0 : Boolean(result.canceled),
        };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel all failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async getOpenOrders(marketId?: string): Promise<Order[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const pages = client.listOpenOrders(marketId ? { market: marketId } : undefined);
      const orders = await collectPaginatorItems(pages);
      return orders.map((o: any) => {
        const originalSize = Number(o.originalSize ?? o.original_size) || 0;
        const filledSize = Number(o.sizeMatched ?? o.size_matched) || 0;
        const createdAt = toEpochMs(o.createdAt ?? o.created_at);
        return {
          id: String(o.id),
          status: String(o.status ?? ''),
          tokenId: String(o.assetId ?? o.tokenId ?? o.asset_id ?? ''),
          side: String(o.side ?? '').toUpperCase() as Side,
          price: Number(o.price) || 0,
          originalSize,
          filledSize,
          remainingSize: originalSize - filledSize,
          associateTrades: o.associateTrades || o.associate_trades || [],
          createdAt,
        };
      });
    });
  }

  async getTrades(marketId?: string): Promise<TradeInfo[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const pages = client.listAccountTrades(marketId ? { market: marketId } : undefined);
      const trades = await collectPaginatorItems(pages);
      return trades.map((t: any) => ({
        id: String(t.id),
        tokenId: String(t.assetId ?? t.tokenId ?? t.asset_id ?? ''),
        side: String(t.side).toUpperCase() as Side,
        price: Number(t.price) || 0,
        size: Number(t.size) || 0,
        fee: Number(t.feeRateBps ?? t.fee_rate_bps) || 0,
        timestamp: toEpochMs(t.matchedAt ?? t.match_time ?? t.updatedAt),
      }));
    });
  }

  async isOrderScoring(orderId: string): Promise<boolean> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      return await client.fetchOrderScoring({ orderId });
    });
  }

  async areOrdersScoring(orderIds: string[]): Promise<Record<string, boolean>> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.fetchOrdersScoring({ orderIds });
      return result as Record<string, boolean>;
    });
  }

  async getEarningsForDay(date: string): Promise<UserEarning[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const pages = client.listUserEarningsForDay({ date });
      const earnings = await collectPaginatorItems(pages);
      return earnings.map((e: any) => ({
        date: String(e.date ?? date),
        conditionId: String(e.conditionId ?? e.condition_id ?? ''),
        assetAddress: String(e.assetAddress ?? e.asset_address ?? ''),
        makerAddress: String(e.makerAddress ?? e.maker_address ?? ''),
        earnings: Number(e.earnings) || 0,
        assetRate: Number(e.assetRate ?? e.asset_rate) || 0,
      }));
    });
  }

  /**
   * Gap: unified CurrentReward omits question/marketSlug/eventSlug/tokens.
   */
  async getCurrentRewards(): Promise<MarketReward[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const pages = client.listCurrentRewards();
      const rewards = await collectPaginatorItems(pages);
      return rewards.map((r: any) => ({
        conditionId: String(r.conditionId ?? r.condition_id ?? ''),
        question: String(r.question ?? ''),
        marketSlug: String(r.marketSlug ?? r.market_slug ?? ''),
        eventSlug: String(r.eventSlug ?? r.event_slug ?? ''),
        rewardsMaxSpread: Number(r.rewardsMaxSpread ?? r.rewards_max_spread) || 0,
        rewardsMinSize: Number(r.rewardsMinSize ?? r.rewards_min_size) || 0,
        tokens: Array.isArray(r.tokens)
          ? r.tokens.map((t: any) => ({
              tokenId: String(t.tokenId ?? t.token_id ?? t.assetId ?? ''),
              outcome: String(t.outcome ?? ''),
              price: Number(t.price) || 0,
            }))
          : [],
        rewardsConfig: (r.rewardsConfig ?? r.rewards_config ?? []).map((c: any) => ({
          assetAddress: String(c.assetAddress ?? c.asset_address ?? ''),
          startDate: String(c.startDate ?? c.start_date ?? ''),
          endDate: String(c.endDate ?? c.end_date ?? ''),
          ratePerDay: Number(c.ratePerDay ?? c.rate_per_day) || 0,
          totalRewards: Number(c.totalRewards ?? c.total_rewards) || 0,
        })),
      }));
    });
  }

  async getBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<{ balance: string; allowance: string }> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await fetchBalanceAllowance(client as any, {
        assetType: assetType === 'COLLATERAL' ? AssetType.COLLATERAL : AssetType.CONDITIONAL,
        ...(tokenId ? { tokenId } : {}),
      });
      const balance = String(result.balance ?? '0');
      const allowances = (result as any).allowances as Record<string, unknown> | undefined;
      let allowance = '0';
      if (allowances && typeof allowances === 'object') {
        const values = Object.values(allowances);
        if (values.length > 0) allowance = String(values[0]);
      } else if ((result as any).allowance !== undefined) {
        allowance = String((result as any).allowance);
      }
      return { balance, allowance };
    });
  }

  async updateBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<void> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      await updateBalanceAllowance(client as any, {
        assetType: assetType === 'COLLATERAL' ? AssetType.COLLATERAL : AssetType.CONDITIONAL,
        ...(tokenId ? { tokenId } : {}),
      });
    });
  }

  getAddress(): string {
    if (this.client?.account?.wallet) {
      return String(this.client.account.wallet);
    }
    return this.wallet.address;
  }

  getWallet(): Wallet {
    return this.wallet;
  }

  getCredentials(): ApiCredentials | null {
    return this.credentials;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /** @deprecated Prefer getSecureClient(). */
  getClobClient(): null {
    return null;
  }

  getSecureClient(): AnySecureClient | null {
    return this.client;
  }
}
