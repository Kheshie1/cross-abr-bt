import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GAMMA_URL = "https://gamma-api.polymarket.com";
const KALSHI_URL = "https://api.elections.kalshi.com/trade-api/v2";

// Normalize a question string for fuzzy matching
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract key tokens for matching (remove stop words)
function keyTokens(s: string): string[] {
  const stop = new Set(["will", "the", "a", "an", "in", "on", "at", "to", "of", "be", "is", "for", "by", "it", "do", "does", "has", "have", "or", "and"]);
  return normalize(s).split(" ").filter((w) => w.length > 2 && !stop.has(w));
}

// Score similarity between two question strings (0-1)
function similarity(a: string, b: string): number {
  const tokensA = keyTokens(a);
  const tokensB = new Set(keyTokens(b));
  if (tokensA.length === 0) return 0;
  const matches = tokensA.filter((t) => tokensB.has(t)).length;
  return matches / Math.max(tokensA.length, tokensB.size);
}

interface MarketData {
  id: string;
  question: string;
  yes_price: number;
  no_price: number;
  platform: "polymarket" | "kalshi";
  volume: number;
  end_date?: string;
  token_id_yes?: string;
  token_id_no?: string;
  ticker?: string;
}

// Fetch Polymarket markets via Gamma API
async function fetchPolymarkets(limit = 100): Promise<MarketData[]> {
  const res = await fetch(
    `${GAMMA_URL}/markets?closed=false&active=true&limit=${limit}&order=volume24hr&ascending=false`
  );
  if (!res.ok) throw new Error(`Gamma API error [${res.status}]`);
  const markets = await res.json();
  return markets
    .filter((m: any) => {
      const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
      return prices.length >= 2 && Number(prices[0]) > 0 && Number(prices[1]) > 0;
    })
    .map((m: any) => {
      const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
      const prices = JSON.parse(m.outcomePrices).map(Number);
      return {
        id: m.conditionId || m.id,
        question: m.question || "",
        yes_price: prices[0],
        no_price: prices[1],
        platform: "polymarket" as const,
        volume: Number(m.volume24hr || 0),
        end_date: m.endDate,
        token_id_yes: tokens[0],
        token_id_no: tokens[1],
      };
    });
}

// Fetch Kalshi markets (public, no auth needed for reading)
async function fetchKalshiMarkets(limit = 200): Promise<MarketData[]> {
  const res = await fetch(
    `${KALSHI_URL}/markets?limit=${limit}&status=open`
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`Kalshi API error [${res.status}]: ${errText.slice(0, 500)}`);
    throw new Error(`Kalshi API error [${res.status}]`);
  }
  const data = await res.json();
  const markets = data.markets || [];
  console.log(`Kalshi raw markets: ${markets.length}, sample keys: ${markets[0] ? Object.keys(markets[0]).join(",") : "none"}`);
  if (markets[0]) {
    console.log(`Sample Kalshi market: ${JSON.stringify(markets[0]).slice(0, 500)}`);
  }

  return markets
    .map((m: any) => {
      // Kalshi uses various price fields — try them all
      const yesPrice = (m.yes_ask ?? m.yes_bid ?? m.last_price ?? m.response_price_units?.yes_ask ?? 0);
      const noPrice = (m.no_ask ?? m.no_bid ?? (yesPrice > 0 ? (100 - yesPrice) : 0));
      return {
        id: m.ticker || m.market_id || "",
        question: m.title || m.subtitle || m.yes_sub_title || "",
        yes_price: yesPrice / 100, // Kalshi prices are in cents
        no_price: noPrice / 100,
        platform: "kalshi" as const,
        volume: m.volume_24h || m.volume || 0,
        end_date: m.close_time || m.expiration_time,
        ticker: m.ticker,
      };
    })
    .filter((m: MarketData) => m.yes_price > 0 && m.no_price > 0 && m.question.length > 0);
}

interface CrossPlatformArb {
  poly_market: MarketData;
  kalshi_market: MarketData;
  match_score: number;
  // Best arb: buy YES on cheaper platform, buy NO on other
  best_strategy: string;
  buy_yes_platform: string;
  buy_yes_price: number;
  buy_no_platform: string;
  buy_no_price: number;
  total_cost: number;
  spread_pct: number;
  guaranteed_profit: number;
  is_arb: boolean;
}

function findCrossPlatformArbs(
  polymarkets: MarketData[],
  kalshiMarkets: MarketData[],
  minMatchScore = 0.5
): CrossPlatformArb[] {
  const arbs: CrossPlatformArb[] = [];

  for (const poly of polymarkets) {
    let bestMatch: MarketData | null = null;
    let bestScore = 0;

    for (const kalshi of kalshiMarkets) {
      const score = similarity(poly.question, kalshi.question);
      if (score > bestScore && score >= minMatchScore) {
        bestScore = score;
        bestMatch = kalshi;
      }
    }

    if (bestMatch) {
      // Strategy 1: Buy YES on Poly + Buy NO on Kalshi
      const cost1 = poly.yes_price + bestMatch.no_price;
      // Strategy 2: Buy YES on Kalshi + Buy NO on Poly
      const cost2 = bestMatch.yes_price + poly.no_price;

      let bestCost: number, strategy: string, buyYesPlatform: string, buyYesPrice: number, buyNoPlatform: string, buyNoPrice: number;

      if (cost1 <= cost2) {
        bestCost = cost1;
        strategy = `Buy YES@Poly ($${poly.yes_price.toFixed(3)}) + Buy NO@Kalshi ($${bestMatch.no_price.toFixed(3)})`;
        buyYesPlatform = "polymarket";
        buyYesPrice = poly.yes_price;
        buyNoPlatform = "kalshi";
        buyNoPrice = bestMatch.no_price;
      } else {
        bestCost = cost2;
        strategy = `Buy YES@Kalshi ($${bestMatch.yes_price.toFixed(3)}) + Buy NO@Poly ($${poly.no_price.toFixed(3)})`;
        buyYesPlatform = "kalshi";
        buyYesPrice = bestMatch.yes_price;
        buyNoPlatform = "polymarket";
        buyNoPrice = poly.no_price;
      }

      const spreadPct = ((1 - bestCost) / bestCost) * 100;

      arbs.push({
        poly_market: poly,
        kalshi_market: bestMatch,
        match_score: Number(bestScore.toFixed(2)),
        best_strategy: strategy,
        buy_yes_platform: buyYesPlatform,
        buy_yes_price: buyYesPrice,
        buy_no_platform: buyNoPlatform,
        buy_no_price: buyNoPrice,
        total_cost: Number(bestCost.toFixed(4)),
        spread_pct: Number(spreadPct.toFixed(2)),
        guaranteed_profit: Number((1 - bestCost).toFixed(4)),
        is_arb: bestCost < 1,
      });
    }
  }

  return arbs.sort((a, b) => b.spread_pct - a.spread_pct);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json();
    const { action, market_id, question, buy_yes_platform, buy_no_platform, buy_yes_price, buy_no_price, size, is_running, trade_amount, interval_minutes, min_confidence, max_open_trades } = body;

    // ---- SCAN: cross-platform arb scanner ----
    if (action === "scan") {
      const [polymarkets, kalshiMarkets] = await Promise.all([
        fetchPolymarkets(200),
        fetchKalshiMarkets(1000),
      ]);

      // Log sample titles for debugging matches
      console.log(`Poly sample titles: ${polymarkets.slice(0, 3).map(m => m.question.slice(0, 60)).join(" | ")}`);
      console.log(`Kalshi sample titles: ${kalshiMarkets.slice(0, 3).map(m => m.question.slice(0, 60)).join(" | ")}`);

      const arbs = findCrossPlatformArbs(polymarkets, kalshiMarkets, 0.25).slice(0, 25);
      const realArbCount = arbs.filter((a) => a.is_arb).length;
      console.log(`Matches found: ${arbs.length}, real arbs: ${realArbCount}`);

      return new Response(
        JSON.stringify({
          markets: arbs,
          real_arb_count: realArbCount,
          poly_count: polymarkets.length,
          kalshi_count: kalshiMarkets.length,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ---- LIVE SCAN: cross-platform arbs ending soon ----
    if (action === "live_scan") {
      const now = new Date();
      const soon = new Date(now.getTime() + 48 * 60 * 60 * 1000);

      const [polymarkets, kalshiMarkets] = await Promise.all([
        fetchPolymarkets(200),
        fetchKalshiMarkets(200),
      ]);

      // Filter to markets ending soon
      const filterSoon = (m: MarketData) => {
        if (!m.end_date) return false;
        const end = new Date(m.end_date);
        return end > now && end <= soon;
      };

      const soonPoly = polymarkets.filter(filterSoon);
      const arbs = findCrossPlatformArbs(soonPoly, kalshiMarkets, 0.4)
        .slice(0, 15)
        .map((a) => {
          const endDate = new Date(a.poly_market.end_date!);
          const hoursLeft = Math.max(0, (endDate.getTime() - now.getTime()) / (1000 * 60 * 60));
          return { ...a, hours_left: Number(hoursLeft.toFixed(1)) };
        });

      return new Response(JSON.stringify({ live: arbs }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- EXECUTE: record a cross-platform arb trade ----
    if (action === "execute") {
      const totalCost = (buy_yes_price || 0) + (buy_no_price || 0);
      const arbProfit = 1 - totalCost;
      const tradeSize = size || 0.5;

      const { data: trades, error } = await supabase
        .from("polymarket_trades")
        .insert([
          {
            market_id: market_id || "cross-platform",
            market_question: question,
            token_id: buy_yes_platform || "cross",
            side: `BUY_YES@${(buy_yes_platform || "").toUpperCase()}`,
            price: buy_yes_price,
            size: tradeSize,
            status: "executed",
            profit_loss: arbProfit * tradeSize,
          },
          {
            market_id: market_id || "cross-platform",
            market_question: question,
            token_id: buy_no_platform || "cross",
            side: `BUY_NO@${(buy_no_platform || "").toUpperCase()}`,
            price: buy_no_price,
            size: tradeSize,
            status: "executed",
            profit_loss: 0,
          },
        ])
        .select();

      if (error) throw error;

      return new Response(JSON.stringify({ trades }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- STATUS ----
    if (action === "status") {
      const { data: settings } = await supabase
        .from("bot_settings")
        .select("*")
        .limit(1)
        .maybeSingle();

      const { data: trades } = await supabase
        .from("polymarket_trades")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      const { data: allTrades } = await supabase
        .from("polymarket_trades")
        .select("*");

      const totalTrades = allTrades?.length || 0;
      const totalProfit = allTrades?.reduce((sum, t) => sum + (t.profit_loss || 0), 0) || 0;
      const totalInvested = allTrades?.reduce((sum, t) => sum + (t.size || 0), 0) || 0;
      const arbCount = Math.floor(totalTrades / 2);

      return new Response(
        JSON.stringify({ settings, trades, stats: { totalTrades, totalProfit, totalInvested, arbCount } }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ---- TOGGLE ----
    if (action === "toggle") {
      const { data, error } = await supabase
        .from("bot_settings")
        .update({ is_running, updated_at: new Date().toISOString() })
        .eq("id", (await supabase.from("bot_settings").select("id").limit(1).single()).data?.id)
        .select()
        .single();

      if (error) throw error;
      return new Response(JSON.stringify({ settings: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- UPDATE SETTINGS ----
    if (action === "update_settings") {
      const { data: current } = await supabase.from("bot_settings").select("id").limit(1).single();
      const { data, error } = await supabase
        .from("bot_settings")
        .update({
          ...(trade_amount !== undefined && { trade_amount }),
          ...(interval_minutes !== undefined && { interval_minutes }),
          ...(min_confidence !== undefined && { min_confidence }),
          ...(max_open_trades !== undefined && { max_open_trades }),
          updated_at: new Date().toISOString(),
        })
        .eq("id", current?.id)
        .select()
        .single();

      if (error) throw error;
      return new Response(JSON.stringify({ settings: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- AUTO TRADE (cron) ----
    if (action === "auto_trade") {
      const { data: settings } = await supabase
        .from("bot_settings")
        .select("*")
        .limit(1)
        .maybeSingle();

      if (!settings?.is_running) {
        return new Response(JSON.stringify({ skipped: true, reason: "Bot is not running" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { count } = await supabase
        .from("polymarket_trades")
        .select("*", { count: "exact", head: true })
        .eq("status", "executed");

      if ((count || 0) / 2 >= settings.max_open_trades) {
        return new Response(JSON.stringify({ skipped: true, reason: "Max open arb positions reached" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const [polymarkets, kalshiMarkets] = await Promise.all([
        fetchPolymarkets(100),
        fetchKalshiMarkets(200),
      ]);

      const minSpread = (1 - settings.min_confidence) * 100;
      const arbs = findCrossPlatformArbs(polymarkets, kalshiMarkets, 0.5)
        .filter((a) => a.is_arb && a.spread_pct >= minSpread);

      if (arbs.length === 0) {
        return new Response(JSON.stringify({ skipped: true, reason: "No cross-platform arb opportunities found" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Find first arb not already traded
      let best = null;
      for (const arb of arbs) {
        const { data: existing } = await supabase
          .from("polymarket_trades")
          .select("id")
          .eq("market_id", arb.poly_market.id)
          .eq("status", "executed")
          .limit(1)
          .maybeSingle();

        if (!existing) {
          best = arb;
          break;
        }
      }

      if (!best) {
        return new Response(JSON.stringify({ skipped: true, reason: "All arb opportunities already traded" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const arbProfit = best.guaranteed_profit * settings.trade_amount;
      const { data: trades, error: tradeErr } = await supabase
        .from("polymarket_trades")
        .insert([
          {
            market_id: best.poly_market.id,
            market_question: best.poly_market.question,
            token_id: best.buy_yes_platform,
            side: `BUY_YES@${best.buy_yes_platform.toUpperCase()}`,
            price: best.buy_yes_price,
            size: settings.trade_amount,
            status: "executed",
            profit_loss: arbProfit,
          },
          {
            market_id: best.poly_market.id,
            market_question: best.poly_market.question,
            token_id: best.buy_no_platform,
            side: `BUY_NO@${best.buy_no_platform.toUpperCase()}`,
            price: best.buy_no_price,
            size: settings.trade_amount,
            status: "executed",
            profit_loss: 0,
          },
        ])
        .select();

      if (tradeErr) throw tradeErr;

      console.log(`Cross-platform arb executed: ${best.poly_market.question} | spread ${best.spread_pct}% | profit $${arbProfit.toFixed(4)}`);
      return new Response(JSON.stringify({ executed: true, trades, arb: best }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
