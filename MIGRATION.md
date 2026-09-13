# Migration: `@polymarket/clob-client` → `@polymarket/client`

This fork’s trading layer now uses Polymarket’s unified TypeScript SDK
([migration guide](https://docs.polymarket.com/getting-started/migrate-from-previous-sdks)).

## Dependency changes

```bash
npm uninstall @polymarket/clob-client
npm install @polymarket/client@latest viem ethers-v5@npm:ethers@^5.8.0
```

Then refresh the lockfile (required after pulling this branch):

```bash
npm install
```

**Node.js:** `@polymarket/client` currently declares `engines.node: >=24`. Prefer Node 24+.

## What changed in code

| Area | Before | After |
|------|--------|--------|
| Auth | `new ClobClient(host, chainId, wallet)` + derive/create API key + re-init | `await createSecureClient({ signer: signerFrom(ethersWallet), credentials? })` via `@polymarket/client/ethers-v5` |
| Limit orders | `createAndPostOrder(...)` | `placeLimitOrder({ tokenId, price, size, side })` (tick/neg-risk auto) |
| Market orders | `createAndPostMarketOrder(...)` | `placeMarketOrder(...)` (BUY uses `amount`; SELL maps legacy `amount` → `shares`) |
| Cancel / open / trades | `cancel*`, `getOpenOrders`, `getTrades` | `cancelOrder({ orderId })`, `listOpenOrders` / `listAccountTrades` paginators |
| Public books/prices | `ClobClient.getOrderBook` etc. | `createPublicClient()` → `fetchOrderBook`, `fetchMidpoint`, `listPriceHistory`, `listMarkets` |
| Rewards | `getCurrentRewards` / earnings day APIs | `listCurrentRewards` / `listUserEarningsForDay` (see gaps) |
| Balance cache | `getBalanceAllowance` / `updateBalanceAllowance` on ClobClient | `@polymarket/client/actions` helpers |

`TradingService` **public methods are unchanged** (`createLimitOrder`, `createMarketOrder`, `cancel*`, `getOpenOrders`, `getTrades`, `getBalanceAllowance`, `getAddress`, `getCredentials`, `isInitialized`, …) so strategies can migrate gradually.

`MarketService` **public API is unchanged**; implementation is split across layered modules (`market-service-*.ts`) that still export `MarketService` from `market-service.ts`.

## Dry-run vs live

- **Dry-run (recommended first):** keep `DRY_RUN=true` (default in bot configs). No live orders are required to validate compile/tests.
- **Live trading:** set `DRY_RUN=false` and provide wallet env vars (typically `POLYMARKET_PRIVATE_KEY`, and optionally `POLYMARKET_WALLET_ADDRESS` if you trade through a proxy/deposit wallet). Never commit `.env`.

## Known gaps

1. **`getCurrentRewards()` shape:** unified `CurrentReward` no longer includes `question` / `marketSlug` / `eventSlug` / `tokens`. Compatibility stubs return empty strings / `[]` for those fields.
2. **`getClobClient()`:** deprecated; returns `null`. Use `getSecureClient()`.
3. **`package-lock.json`:** not regenerated in this PR — run `npm install` locally.
4. **Node engine:** SDK wants Node ≥ 24; older runtimes may fail to install/run.
5. **Balance helpers:** `getBalanceAllowance` / `updateBalanceAllowance` use `@polymarket/client/actions` (not instance methods).

## How to test

```bash
npm install
npm test
npm run build   # if tsc is available
# optional examples (read-only / dry-run):
npm run example:trading
npm run example:rewards
```

Keep dry-run enabled until auth + a tiny live order succeed on Polygon.
