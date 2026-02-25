

## Plan: Use Kalshi Balance Instead of Polymarket Balance

### Problem
The Polymarket balance detection is unreliable — the $40.19 cash sits inside Polymarket's internal L2 system and the profile API endpoint returns 404. Meanwhile, Kalshi balance fetching (`fetchKalshiBalance`) already works correctly using authenticated RSA-PSS signing.

### Changes

#### 1. `src/components/BalanceCard.tsx`
- Change header from "Polymarket Account" to "Kalshi Account"
- Switch data source from `data?.balances?.polymarket` to `data?.balances?.kalshi`
- Display `kalshi.balance` as Cash and `kalshi.portfolio_value` as Portfolio
- Keep the positions list (Polymarket positions can remain as secondary info, or be removed)
- Update total calculation to use Kalshi values

#### 2. `supabase/functions/polymarket-trade/index.ts` — `fetchTotalCashBalance`
- Remove the broken `fetchPolymarketProfileBalance` calls (lines 333-347, 355-356)
- Use Kalshi balance as the primary cash source for trade sizing
- In the balance action response, keep Kalshi as the primary display balance

#### 3. No new secrets needed
- `KALSHI_API_KEY` and `KALSHI_PRIVATE_KEY` are already configured and `fetchKalshiBalance` already works

### Summary of file changes
| File | Change |
|------|--------|
| `src/components/BalanceCard.tsx` | Switch UI to display Kalshi balance as primary |
| `supabase/functions/polymarket-trade/index.ts` | Remove broken `fetchPolymarketProfileBalance`, use Kalshi balance for cash display |

