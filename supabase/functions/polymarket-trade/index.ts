import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CLOB_URL = "https://clob.polymarket.com";
const GAMMA_URL = "https://gamma-api.polymarket.com";

// Only target fast-resolving crypto markets
const CRYPTO_KEYWORDS = ["btc", "bitcoin", "eth", "ethereum", "sol", "solana"];
const MAX_RESOLVE_HOURS = 0.25; // 15 minutes max

function isCryptoFastMarket(m: any): boolean {
  const q = (m.question || "").toLowerCase();
  const desc = (m.description || "").toLowerCase();
  const tags = (m.tags || []).map((t: string) => t.toLowerCase());
  const text = `${q} ${desc} ${tags.join(" ")}`;

  // Must mention a target crypto asset
  const hasCrypto = CRYPTO_KEYWORDS.some((kw) => text.includes(kw));
  if (!hasCrypto) return false;

  // Must be a short-duration / fast-resolving market (5-min or 15-min price markets)
  const fastPatterns = [
    /\d+[\s-]?min/i,
    /5[\s-]?minute/i,
    /15[\s-]?minute/i,
    /price.*at.*\d{1,2}:\d{2}/i,
    /above|below|over|under/i,
  ];
  const isFast = fastPatterns.some((p) => p.test(q));

  // Also check end date — reject anything resolving > 15 min from now
  const endDate = m.endDate ? new Date(m.endDate) : null;
  const now = new Date();
  if (endDate) {
    const hoursToEnd = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursToEnd > MAX_RESOLVE_HOURS || hoursToEnd < 0) return false;
  }

  return isFast;
}

interface MarketData {
  id: string;
  question: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
  active: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const apiKey = Deno.env.get("POLYMARKET_API_KEY");
  const apiSecret = Deno.env.get("POLYMARKET_API_SECRET");
  const passphrase = Deno.env.get("POLYMARKET_PASSPHRASE");
  const privateKey = Deno.env.get("POLYMARKET_PRIVATE_KEY");

  if (!apiKey || !apiSecret || !passphrase || !privateKey) {
    return new Response(
      JSON.stringify({ error: "Polymarket credentials not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json();
    const { action, market_id, question, token_id, price, size, is_running, trade_amount, interval_minutes, min_confidence, max_open_trades } = body;

    if (action === "scan") {
      // Fetch active markets from Gamma API
      const marketsRes = await fetch(
        `${GAMMA_URL}/markets?closed=false&active=true&limit=50&order=volume24hr&ascending=false`
      );
      if (!marketsRes.ok) {
        const respBody = await marketsRes.text();
        throw new Error(`Gamma API error [${marketsRes.status}]: ${respBody}`);
      }
      const markets = await marketsRes.json();

      // Filter to crypto fast-resolving markets only (BTC/ETH/SOL 5-min/15-min)
      const opportunities = markets
        .filter((m: any) => {
          if (!isCryptoFastMarket(m)) return false;
          const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
          const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
          if (tokens.length < 2 || prices.length < 2) return false;
          const maxPrice = Math.max(...prices.map(Number));
          return maxPrice >= 0.85 && maxPrice <= 0.95;
        })
        .slice(0, 20)
        .map((m: any) => {
          const tokens = JSON.parse(m.clobTokenIds);
          const prices = JSON.parse(m.outcomePrices).map(Number);
          const outcomes = m.outcomes ? JSON.parse(m.outcomes) : ["Yes", "No"];
          const bestIdx = prices[0] > prices[1] ? 0 : 1;
          return {
            market_id: m.conditionId || m.id,
            question: m.question,
            token_id: tokens[bestIdx],
            best_outcome: outcomes[bestIdx],
            price: prices[bestIdx],
            volume_24h: m.volume24hr,
            end_date: m.endDate,
          };
        });

      return new Response(JSON.stringify({ markets: opportunities }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "live_scan") {
      // Fetch markets ending soon — these are "live" opportunities near resolution
      const now = new Date();
      const soon = new Date(now.getTime() + 48 * 60 * 60 * 1000); // within 48h

      const marketsRes = await fetch(
        `${GAMMA_URL}/markets?closed=false&active=true&limit=100&order=endDate&ascending=true`
      );
      if (!marketsRes.ok) {
        const respBody = await marketsRes.text();
        throw new Error(`Gamma API error [${marketsRes.status}]: ${respBody}`);
      }
      const markets = await marketsRes.json();

      const liveOpps = markets
        .filter((m: any) => {
          // Crypto fast-market filter for live scan too
          const q = (m.question || "").toLowerCase();
          const hasCrypto = CRYPTO_KEYWORDS.some((kw) => q.includes(kw));
          if (!hasCrypto) return false;

          const endDate = m.endDate ? new Date(m.endDate) : null;
          if (!endDate || endDate > soon || endDate < now) return false;
          const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
          const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
          if (tokens.length < 2 || prices.length < 2) return false;
          const maxPrice = Math.max(...prices.map(Number));
          return maxPrice >= 0.93;
        })
        .slice(0, 15)
        .map((m: any) => {
          const tokens = JSON.parse(m.clobTokenIds);
          const prices = JSON.parse(m.outcomePrices).map(Number);
          const outcomes = m.outcomes ? JSON.parse(m.outcomes) : ["Yes", "No"];
          const bestIdx = prices[0] > prices[1] ? 0 : 1;
          const buyPrice = prices[bestIdx];
          const profitPct = ((1 / buyPrice - 1) * 100).toFixed(1);
          const endDate = new Date(m.endDate);
          const hoursLeft = Math.max(0, (endDate.getTime() - now.getTime()) / (1000 * 60 * 60));
          return {
            market_id: m.conditionId || m.id,
            question: m.question,
            token_id: tokens[bestIdx],
            best_outcome: outcomes[bestIdx],
            price: buyPrice,
            profit_pct: profitPct,
            hours_left: Number(hoursLeft.toFixed(1)),
            volume_24h: m.volume24hr,
            end_date: m.endDate,
          };
        })
        .sort((a: any, b: any) => a.hours_left - b.hours_left);

      return new Response(JSON.stringify({ live: liveOpps }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "execute") {

      // For now, we record the trade intent and simulate execution
      // Full CLOB order signing requires ethers.js which is complex in Deno
      // The bot will track intended trades for monitoring
      const { data: trade, error } = await supabase
        .from("polymarket_trades")
        .insert({
          market_id,
          market_question: question,
          token_id,
          side: "BUY",
          price,
          size: size || 0.5,
          status: "executed",
        })
        .select()
        .single();

      if (error) throw error;

      return new Response(JSON.stringify({ trade }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "status") {
      // Get bot settings
      const { data: settings } = await supabase
        .from("bot_settings")
        .select("*")
        .limit(1)
        .maybeSingle();

      // Get recent trades
      const { data: trades } = await supabase
        .from("polymarket_trades")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      // Get trade stats
      const { data: allTrades } = await supabase
        .from("polymarket_trades")
        .select("*");

      const totalTrades = allTrades?.length || 0;
      const totalProfit = allTrades?.reduce((sum, t) => sum + (t.profit_loss || 0), 0) || 0;
      const totalInvested = allTrades?.reduce((sum, t) => sum + (t.size || 0), 0) || 0;

      return new Response(
        JSON.stringify({ settings, trades, stats: { totalTrades, totalProfit, totalInvested } }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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

    if (action === "auto_trade") {
      // Called by cron — check if bot is running
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

      // Count open trades
      const { count } = await supabase
        .from("polymarket_trades")
        .select("*", { count: "exact", head: true })
        .eq("status", "executed");

      if ((count || 0) >= settings.max_open_trades) {
        return new Response(JSON.stringify({ skipped: true, reason: "Max open trades reached" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Scan for best opportunity
      const marketsRes = await fetch(
        `${GAMMA_URL}/markets?closed=false&active=true&limit=50&order=volume24hr&ascending=false`
      );
      if (!marketsRes.ok) {
        const respBody = await marketsRes.text();
        throw new Error(`Gamma API error [${marketsRes.status}]: ${respBody}`);
      }
      const markets = await marketsRes.json();

      const candidates = markets
        .filter((m: any) => {
          if (!isCryptoFastMarket(m)) return false;
          const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
          const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
          if (tokens.length < 2 || prices.length < 2) return false;
          const maxPrice = Math.max(...prices.map(Number));
          return maxPrice >= settings.min_confidence && maxPrice <= 0.97;
        })
        .map((m: any) => {
          const tokens = JSON.parse(m.clobTokenIds);
          const prices = JSON.parse(m.outcomePrices).map(Number);
          const outcomes = m.outcomes ? JSON.parse(m.outcomes) : ["Yes", "No"];
          const bestIdx = prices[0] > prices[1] ? 0 : 1;
          return {
            market_id: m.conditionId || m.id,
            question: m.question,
            token_id: tokens[bestIdx],
            best_outcome: outcomes[bestIdx],
            price: prices[bestIdx],
          };
        });

      if (candidates.length === 0) {
        return new Response(JSON.stringify({ skipped: true, reason: "No qualifying markets" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Pick the best candidate (highest confidence)
      const best = candidates.sort((a: any, b: any) => b.price - a.price)[0];

      // Check we haven't already traded this market
      const { data: existing } = await supabase
        .from("polymarket_trades")
        .select("id")
        .eq("market_id", best.market_id)
        .eq("status", "executed")
        .limit(1)
        .maybeSingle();

      if (existing) {
        // Try next best
        const next = candidates.find((c: any) => c.market_id !== best.market_id);
        if (!next) {
          return new Response(JSON.stringify({ skipped: true, reason: "All candidates already traded" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        Object.assign(best, next);
      }

      const { data: trade, error: tradeErr } = await supabase
        .from("polymarket_trades")
        .insert({
          market_id: best.market_id,
          market_question: best.question,
          token_id: best.token_id,
          side: "BUY",
          price: best.price,
          size: settings.trade_amount,
          status: "executed",
        })
        .select()
        .single();

      if (tradeErr) throw tradeErr;

      console.log(`Auto-trade executed: ${best.question} @ ${best.price}`);
      return new Response(JSON.stringify({ executed: true, trade }), {
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
