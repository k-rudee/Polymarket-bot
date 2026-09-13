/**
 * Protected market normalizers shared across MarketService layers.
 */
import type { GammaMarket } from '../clients/gamma-api.js';
import type {
  UnifiedMarket,
  MarketToken as UnifiedMarketToken,
  Orderbook,
  ProcessedOrderbook,
  EffectivePrices,
  KLineInterval,
} from '../core/types.js';
import type { ClobMarket, Market, MarketToken } from './market-service-types.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import type { RateLimiter } from '../core/rate-limiter.js';
import type { DataApiClient } from '../clients/data-api.js';
import type { GammaApiClient } from '../clients/gamma-api.js';
import type { BinanceService } from './binance-service.js';

/** Narrow base holding injected deps for subclasses. */
export class MarketServiceDeps {
  constructor(
    protected gammaApi: GammaApiClient | undefined,
    protected dataApi: DataApiClient | undefined,
    protected rateLimiter: RateLimiter,
    protected cache: UnifiedCache,
    protected config?: { privateKey?: string; chainId?: number },
    protected binanceService?: BinanceService
  ) {}
}

export class MarketServiceHelpers extends MarketServiceDeps {
  protected normalizeClobMarket(m: ClobMarket): Market {
    return {
      conditionId: m.condition_id,
      questionId: m.question_id,
      marketSlug: m.market_slug,
      question: m.question,
      description: m.description,
      tokens: m.tokens.map(t => ({
        tokenId: t.token_id,
        outcome: t.outcome,
        price: t.price,
        winner: t.winner,
      })),
      active: m.active,
      closed: m.closed,
      acceptingOrders: m.accepting_orders,
      endDateIso: m.end_date_iso,
      negRisk: m.neg_risk,
      minimumOrderSize: m.minimum_order_size,
      minimumTickSize: m.minimum_tick_size,
    };
  }

  /** Normalize unified `@polymarket/client` Market model into the legacy Market shape. */
  protected normalizeUnifiedMarket(m: any): Market {
    const yes = m?.outcomes?.yes;
    const no = m?.outcomes?.no;
    const tokens: MarketToken[] = [];
    if (yes) {
      tokens.push({
        tokenId: String(yes.tokenId ?? yes.positionId ?? ''),
        outcome: String(yes.label ?? 'Yes'),
        price: Number(yes.price) || 0,
      });
    }
    if (no) {
      tokens.push({
        tokenId: String(no.tokenId ?? no.positionId ?? ''),
        outcome: String(no.label ?? 'No'),
        price: Number(no.price) || 0,
      });
    }

    return {
      conditionId: String(m?.conditionId ?? ''),
      marketSlug: String(m?.slug ?? ''),
      question: String(m?.question ?? ''),
      description: m?.description ?? undefined,
      tokens,
      active: Boolean(m?.state?.active),
      closed: Boolean(m?.state?.closed),
      acceptingOrders: Boolean(m?.state?.acceptingOrders),
      endDateIso: m?.state?.endDate ?? null,
      negRisk: Boolean(m?.state?.negRisk),
      minimumOrderSize: m?.trading?.minimumOrderSize != null
        ? Number(m.trading.minimumOrderSize)
        : undefined,
      minimumTickSize: m?.trading?.minimumTickSize != null
        ? Number(m.trading.minimumTickSize)
        : undefined,
    };
  }

  protected processOrderbooks(
    yesBook: Orderbook,
    noBook: Orderbook,
    yesTokenId?: string,
    noTokenId?: string
  ): ProcessedOrderbook {
    const yesBestBid = yesBook.bids[0]?.price || 0;
    const yesBestAsk = yesBook.asks[0]?.price || 1;
    const noBestBid = noBook.bids[0]?.price || 0;
    const noBestAsk = noBook.asks[0]?.price || 1;

    const yesBidDepth = yesBook.bids.reduce((sum, l) => sum + l.price * l.size, 0);
    const yesAskDepth = yesBook.asks.reduce((sum, l) => sum + l.price * l.size, 0);
    const noBidDepth = noBook.bids.reduce((sum, l) => sum + l.price * l.size, 0);
    const noAskDepth = noBook.asks.reduce((sum, l) => sum + l.price * l.size, 0);

    const askSum = yesBestAsk + noBestAsk;
    const bidSum = yesBestBid + noBestBid;

    const effectivePrices: EffectivePrices = {
      effectiveBuyYes: Math.min(yesBestAsk, 1 - noBestBid),
      effectiveBuyNo: Math.min(noBestAsk, 1 - yesBestBid),
      effectiveSellYes: Math.max(yesBestBid, 1 - noBestAsk),
      effectiveSellNo: Math.max(noBestBid, 1 - yesBestAsk),
    };

    const effectiveLongCost = effectivePrices.effectiveBuyYes + effectivePrices.effectiveBuyNo;
    const effectiveShortRevenue = effectivePrices.effectiveSellYes + effectivePrices.effectiveSellNo;

    const longArbProfit = 1 - effectiveLongCost;
    const shortArbProfit = effectiveShortRevenue - 1;

    const yesSpread = yesBestAsk - yesBestBid;

    return {
      yes: {
        bid: yesBestBid,
        ask: yesBestAsk,
        bidSize: yesBook.bids[0]?.size || 0,
        askSize: yesBook.asks[0]?.size || 0,
        bidDepth: yesBidDepth,
        askDepth: yesAskDepth,
        spread: yesSpread,
        tokenId: yesTokenId,
      },
      no: {
        bid: noBestBid,
        ask: noBestAsk,
        bidSize: noBook.bids[0]?.size || 0,
        askSize: noBook.asks[0]?.size || 0,
        bidDepth: noBidDepth,
        askDepth: noAskDepth,
        spread: noBestAsk - noBestBid,
        tokenId: noTokenId,
      },
      summary: {
        askSum,
        bidSum,
        effectivePrices,
        effectiveLongCost,
        effectiveShortRevenue,
        longArbProfit,
        shortArbProfit,
        totalBidDepth: yesBidDepth + noBidDepth,
        totalAskDepth: yesAskDepth + noAskDepth,
        imbalanceRatio: (yesBidDepth + noBidDepth) / (yesAskDepth + noAskDepth + 0.001),
        yesSpread,
      },
    };
  }

  protected mergeMarkets(gamma: GammaMarket, clob: Market): UnifiedMarket {
    const tokens: UnifiedMarketToken[] = clob.tokens.map((t, index) => ({
      tokenId: t.tokenId,
      outcome: t.outcome,
      price: t.price || gamma.outcomePrices[index] || 0.5,
      winner: t.winner,
    }));

    return {
      conditionId: clob.conditionId,
      slug: gamma.slug,
      question: clob.question,
      description: clob.description || gamma.description,
      tokens,
      volume: gamma.volume,
      volume24hr: gamma.volume24hr,
      liquidity: gamma.liquidity,
      spread: gamma.spread,
      oneDayPriceChange: gamma.oneDayPriceChange,
      oneWeekPriceChange: gamma.oneWeekPriceChange,
      active: clob.active,
      closed: clob.closed,
      acceptingOrders: clob.acceptingOrders,
      endDate: clob.endDateIso ? new Date(clob.endDateIso) : new Date(),
      source: 'merged',
    };
  }

  protected fromGammaMarket(gamma: GammaMarket): UnifiedMarket {
    const outcomes = gamma.outcomes || ['Yes', 'No'];
    const tokens: UnifiedMarketToken[] = [
      { tokenId: '', outcome: outcomes[0], price: gamma.outcomePrices[0] || 0.5 },
      { tokenId: '', outcome: outcomes[1], price: gamma.outcomePrices[1] || 0.5 },
    ];

    return {
      conditionId: gamma.conditionId,
      slug: gamma.slug,
      question: gamma.question,
      description: gamma.description,
      tokens,
      volume: gamma.volume,
      volume24hr: gamma.volume24hr,
      liquidity: gamma.liquidity,
      spread: gamma.spread,
      oneDayPriceChange: gamma.oneDayPriceChange,
      oneWeekPriceChange: gamma.oneWeekPriceChange,
      active: gamma.active,
      closed: gamma.closed,
      acceptingOrders: !gamma.closed,
      endDate: gamma.endDate,
      source: 'gamma',
    };
  }

  protected fromClobMarket(clob: Market): UnifiedMarket {
    const tokens: UnifiedMarketToken[] = clob.tokens.map(t => ({
      tokenId: t.tokenId,
      outcome: t.outcome,
      price: t.price,
      winner: t.winner,
    }));

    return {
      conditionId: clob.conditionId,
      slug: clob.marketSlug,
      question: clob.question,
      description: clob.description,
      tokens,
      volume: 0,
      volume24hr: undefined,
      liquidity: 0,
      spread: undefined,
      active: clob.active,
      closed: clob.closed,
      acceptingOrders: clob.acceptingOrders,
      endDate: clob.endDateIso ? new Date(clob.endDateIso) : new Date(),
      source: 'clob',
    };
  }
}

export function getIntervalMs(interval: KLineInterval): number {
  const map: Record<KLineInterval, number> = {
    '1s': 1 * 1000,
    '5s': 5 * 1000,
    '15s': 15 * 1000,
    '30s': 30 * 1000,
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  };
  return map[interval];
}
