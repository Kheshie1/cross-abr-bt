import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GAMMA_URL = "https://gamma-api.polymarket.com";
const KALSHI_URL = "https://api.elections.kalshi.com/trade-api/v2";

// ──────────── MATCHING ENGINE ────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Generate bigrams for fuzzy matching (more robust than single tokens)
function bigrams(s: string): Set<string> {
  const norm = normalize(s);
  const set = new Set<string>();
  for (let i = 0; i < norm.length - 1; i++) {
    set.add(norm.slice(i, i + 2));
  }
  return set;
}

// Dice coefficient — robust fuzzy similarity (0-1)
function diceCoefficient(a: string, b: string): number {
  const biA = bigrams(a);
  const biB = bigrams(b);
  if (biA.size === 0 || biB.size === 0) return 0;
  let intersection = 0;
  for (const bi of biA) {
    if (biB.has(bi)) intersection++;
  }
  return (2 * intersection) / (biA.size + biB.size);
}

// Extract key entities (proper nouns, numbers, named things)
function extractEntities(s: string): string[] {
  const norm = normalize(s);
  const stop = new Set([
    "will", "the", "does", "what", "when", "where", "who", "which",
    "that", "this", "with", "from", "into", "over", "under", "about",
    "before", "after", "between", "during", "above", "below", "more",
    "than", "next", "last", "first", "second", "third", "most",
    "each", "every", "other", "another", "some", "many", "much",
    "very", "just", "also", "only", "even", "still", "already",
    "been", "being", "have", "having", "here", "there",
    "win", "won", "lose", "lost", "beat", "game", "match",
    "price", "market", "high", "low", "day", "week", "month", "year",
    "today", "tomorrow", "yesterday", "points", "team",
    "cup", "open", "final", "finals",
    "2026", "2025", "2027",
  ]);
  return norm
    .split(" ")
    .filter((w) => w.length > 2 && !stop.has(w));
}

// Match quality — relaxed for more coverage
function matchMarkets(polyQ: string, kalshiQ: string, polyEnts: string[], kalshiEnts: Set<string>): number {
  const entityMatches = polyEnts.filter((e) => kalshiEnts.has(e));
  const matchCount = entityMatches.length;

  const dice = diceCoefficient(polyQ, kalshiQ);

  // Allow single entity match IF dice similarity is strong
  if (matchCount === 0) return 0;
  if (matchCount === 1 && dice < 0.35) return 0;

  const entityScore = matchCount / Math.max(polyEnts.length, kalshiEnts.size);

  // 55% entity, 45% bigram — more weight on fuzzy for broader matching
  const combined = entityScore * 0.55 + dice * 0.45;

  const bonus = matchCount >= 3 ? 0.1 : matchCount >= 2 ? 0.05 : 0;

  return Math.min(1, combined + bonus);
}

// ──────────── MARKET DATA ────────────

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
  category?: string;
}

// ──────────── POLYMARKET FETCH ────────────

async function fetchPolymarkets(limit = 500): Promise<MarketData[]> {
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
        category: m.groupSlug || "",
      };
    });
}

// ──────────── KALSHI FETCH (multi-page, MVE excluded) ────────────

async function fetchKalshiMarkets(maxPages = 5): Promise<MarketData[]> {
  const allMarkets: MarketData[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      limit: "1000",
      status: "open",
      mve_filter: "exclude", // Only single binary markets
    });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`${KALSHI_URL}/markets?${params}`);
    if (!res.ok) {
      console.error(`Kalshi API error [${res.status}]`);
      break;
    }
    const data = await res.json();
    const markets = data.markets || [];
    cursor = data.cursor;
    console.log(`Kalshi page ${page}: ${markets.length} markets (cursor: ${cursor ? "yes" : "no"})`);

    for (const m of markets) {
      // ─── SKIP MVE / parlay markets (multi-leg combos) ───
      if (m.mve_collection_ticker) continue;
      if (m.market_type === "multi_variate") continue;
      const title = m.title || "";
      // MVE titles look like "yes Team1,yes Team2,no Team3"
      if (/^(yes|no) .+,(yes|no) /i.test(title)) continue;

      // ─── Use subtitle as primary (cleaner question format) ───
      const question = m.subtitle || m.title || m.yes_sub_title || "";
      if (question.length < 5) continue;

      // ─── Price: use midpoint of bid/ask for accuracy ───
      const yesBid = m.yes_bid ?? 0;
      const yesAsk = m.yes_ask ?? 0;
      const noBid = m.no_bid ?? 0;
      const noAsk = m.no_ask ?? 0;

      // Use ask for buying (worst case for us = conservative arb)
      const yesPrice = yesAsk > 0 ? yesAsk : (m.last_price ?? 0);
      const noPrice = noAsk > 0 ? noAsk : (100 - (m.last_price ?? 50));

      if (yesPrice <= 0 || noPrice <= 0) continue;
      if (yesPrice >= 99 || noPrice >= 99) continue; // Skip illiquid extremes

      allMarkets.push({
        id: m.ticker || "",
        question,
        yes_price: yesPrice / 100,
        no_price: noPrice / 100,
        platform: "kalshi" as const,
        volume: m.volume_24h || m.volume || 0,
        end_date: m.close_time || m.expiration_time,
        ticker: m.ticker,
        category: m.event_ticker || "",
      });
    }

    if (!cursor || markets.length < 1000) break;
  }

  console.log(`Kalshi: ${allMarkets.length} single-binary markets after filtering`);
  return allMarkets;
}

// ──────────── CROSS-PLATFORM ARB FINDER ────────────

interface CrossPlatformArb {
  poly_market: MarketData;
  kalshi_market: MarketData;
  match_score: number;
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
  minMatchScore = 0.2
): CrossPlatformArb[] {
  const arbs: CrossPlatformArb[] = [];

  // Build inverted index: entity → list of kalshi indices
  const kalshiData = kalshiMarkets.map((k) => ({
    market: k,
    entities: new Set(extractEntities(k.question)),
  }));
  const entityIndex = new Map<string, number[]>();
  for (let i = 0; i < kalshiData.length; i++) {
    for (const ent of kalshiData[i].entities) {
      if (!entityIndex.has(ent)) entityIndex.set(ent, []);
      entityIndex.get(ent)!.push(i);
    }
  }

  for (const poly of polymarkets) {
    let bestMatch: MarketData | null = null;
    let bestScore = 0;

    const polyEntities = extractEntities(poly.question);
    if (polyEntities.length < 1) continue;

    // Only check Kalshi markets that share at least one entity
    const candidateIndices = new Set<number>();
    for (const ent of polyEntities) {
      const indices = entityIndex.get(ent);
      if (indices) for (const idx of indices) candidateIndices.add(idx);
    }

    for (const idx of candidateIndices) {
      const { market: kalshi, entities: kalshiEnts } = kalshiData[idx];
      const score = matchMarkets(poly.question, kalshi.question, polyEntities, kalshiEnts);
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

      let bestCost: number,
        strategy: string,
        buyYesPlatform: string,
        buyYesPrice: number,
        buyNoPlatform: string,
        buyNoPrice: number;

      if (cost1 <= cost2) {
        bestCost = cost1;
        strategy = `YES@Poly $${poly.yes_price.toFixed(3)} + NO@Kalshi $${bestMatch.no_price.toFixed(3)}`;
        buyYesPlatform = "polymarket";
        buyYesPrice = poly.yes_price;
        buyNoPlatform = "kalshi";
        buyNoPrice = bestMatch.no_price;
      } else {
        bestCost = cost2;
        strategy = `YES@Kalshi $${bestMatch.yes_price.toFixed(3)} + NO@Poly $${poly.no_price.toFixed(3)}`;
        buyYesPlatform = "kalshi";
        buyYesPrice = bestMatch.yes_price;
        buyNoPlatform = "polymarket";
        buyNoPrice = poly.no_price;
      }

      const spreadPct = ((1 - bestCost) / bestCost) * 100;

      arbs.push({
        poly_market: poly,
        kalshi_market: bestMatch,
        match_score: Number(bestScore.toFixed(3)),
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

// ──────────── MAIN HANDLER ────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json();
    const {
      action, market_id, question,
      buy_yes_platform, buy_no_platform, buy_yes_price, buy_no_price,
      size, is_running, trade_amount, interval_minutes, min_confidence, max_open_trades,
    } = body;

    // ──── SCAN ────
    if (action === "scan") {
      const [polymarkets, kalshiMarkets] = await Promise.all([
        fetchPolymarkets(500),
        fetchKalshiMarkets(5),
      ]);

      console.log(`Scan: ${polymarkets.length} Poly × ${kalshiMarkets.length} Kalshi`);

      const arbs = findCrossPlatformArbs(polymarkets, kalshiMarkets, 0.15).slice(0, 50);
      const realArbCount = arbs.filter((a) => a.is_arb).length;

      console.log(`Results: ${arbs.length} matches, ${realArbCount} real arbs`);
      if (arbs.length > 0) {
        console.log(`Top match: "${arbs[0].poly_market.question}" ↔ "${arbs[0].kalshi_market.question}" (score: ${arbs[0].match_score}, spread: ${arbs[0].spread_pct}%)`);
      }

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

    // ──── LIVE SCAN ────
    if (action === "live_scan") {
      const now = new Date();
      const soon = new Date(now.getTime() + 72 * 60 * 60 * 1000); // 72h window

      const [polymarkets, kalshiMarkets] = await Promise.all([
        fetchPolymarkets(500),
        fetchKalshiMarkets(5),
      ]);

      const filterSoon = (m: MarketData) => {
        if (!m.end_date) return false;
        const end = new Date(m.end_date);
        return end > now && end <= soon;
      };

      const soonPoly = polymarkets.filter(filterSoon);
      const soonKalshi = kalshiMarkets.filter(filterSoon);

      const arbs1 = findCrossPlatformArbs(soonPoly, kalshiMarkets, 0.15);
      const arbs2 = findCrossPlatformArbs(polymarkets, soonKalshi, 0.15);

      // Deduplicate by poly market id
      const seen = new Set<string>();
      const combined: (CrossPlatformArb & { hours_left: number })[] = [];
      for (const a of [...arbs1, ...arbs2]) {
        if (seen.has(a.poly_market.id)) continue;
        seen.add(a.poly_market.id);
        const endStr = a.poly_market.end_date || a.kalshi_market.end_date;
        const endDate = endStr ? new Date(endStr) : now;
        const hoursLeft = Math.max(0, (endDate.getTime() - now.getTime()) / (1000 * 60 * 60));
        combined.push({ ...a, hours_left: Number(hoursLeft.toFixed(1)) });
      }

      combined.sort((a, b) => b.spread_pct - a.spread_pct);

      return new Response(JSON.stringify({ live: combined.slice(0, 20) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ──── EXECUTE ────
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

    // ──── STATUS ────
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

    // ──── TOGGLE ────
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

    // ──── UPDATE SETTINGS ────
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

    // ──── AUTO TRADE (executes ALL available arbs per cycle) ────
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

      // Get ALL existing traded market IDs to avoid duplicates
      const { data: existingTrades } = await supabase
        .from("polymarket_trades")
        .select("market_id, market_question")
        .eq("status", "executed");

      const tradedMarketIds = new Set((existingTrades || []).map((t) => t.market_id));
      const tradedQuestions = new Set((existingTrades || []).map((t) => normalize(t.market_question || "")));
      const openPositions = tradedMarketIds.size / 2; // each arb = 2 rows

      if (openPositions >= settings.max_open_trades) {
        console.log(`Auto-trade: skipped — ${openPositions}/${settings.max_open_trades} positions filled`);
        return new Response(JSON.stringify({ skipped: true, reason: "Max open arb positions reached" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const [polymarkets, kalshiMarkets] = await Promise.all([
        fetchPolymarkets(500),
        fetchKalshiMarkets(5),
      ]);

      const minSpread = (1 - settings.min_confidence) * 100;
      const arbs = findCrossPlatformArbs(polymarkets, kalshiMarkets, 0.2)
        .filter((a) => a.is_arb && a.spread_pct >= minSpread);

      // Filter out already-traded markets (by ID AND by normalized question)
      const newArbs = arbs.filter((a) => {
        if (tradedMarketIds.has(a.poly_market.id)) return false;
        if (tradedQuestions.has(normalize(a.poly_market.question))) return false;
        return true;
      });

      const slotsAvailable = settings.max_open_trades - openPositions;
      const toExecute = newArbs.slice(0, slotsAvailable);

      if (toExecute.length === 0) {
        console.log(`Auto-trade: no new arbs (${arbs.length} found, all already traded)`);
        return new Response(JSON.stringify({ skipped: true, reason: "No new cross-platform arbs" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Execute ALL available arbs
      const allInserts = [];
      for (const arb of toExecute) {
        const arbProfit = arb.guaranteed_profit * settings.trade_amount;
        allInserts.push(
          {
            market_id: arb.poly_market.id,
            market_question: arb.poly_market.question,
            token_id: arb.buy_yes_platform,
            side: `BUY_YES@${arb.buy_yes_platform.toUpperCase()}`,
            price: arb.buy_yes_price,
            size: settings.trade_amount,
            status: "executed",
            profit_loss: arbProfit,
          },
          {
            market_id: arb.poly_market.id,
            market_question: arb.poly_market.question,
            token_id: arb.buy_no_platform,
            side: `BUY_NO@${arb.buy_no_platform.toUpperCase()}`,
            price: arb.buy_no_price,
            size: settings.trade_amount,
            status: "executed",
            profit_loss: 0,
          }
        );
      }

      const { data: trades, error: tradeErr } = await supabase
        .from("polymarket_trades")
        .insert(allInserts)
        .select();

      if (tradeErr) throw tradeErr;

      for (const arb of toExecute) {
        const arbProfit = arb.guaranteed_profit * settings.trade_amount;
        console.log(`✅ Arb executed: ${arb.poly_market.question} | ${arb.spread_pct}% spread | +$${arbProfit.toFixed(4)}`);
      }

      return new Response(JSON.stringify({
        executed: true,
        count: toExecute.length,
        trades,
        arbs: toExecute.map((a) => ({ question: a.poly_market.question, spread: a.spread_pct })),
      }), {
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
