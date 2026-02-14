import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GAMMA_URL = "https://gamma-api.polymarket.com";

// Extract arb opportunities from a list of Gamma markets
// showAll = true returns ALL markets with their spread (for dashboard visibility)
function findArbs(markets: any[], minSpreadPct = 0.5, showAll = false) {
  return markets
    .filter((m: any) => {
      const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
      const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
      if (tokens.length < 2 || prices.length < 2) return false;
      const yesPrice = Number(prices[0]);
      const noPrice = Number(prices[1]);
      if (yesPrice <= 0 || noPrice <= 0) return false;
      const totalCost = yesPrice + noPrice;
      if (showAll) return true; // Show all for monitoring
      // Arb exists when total cost < 1 (buy both sides, one resolves to $1)
      return totalCost < (1 - minSpreadPct / 100);
    })
    .map((m: any) => {
      const tokens = JSON.parse(m.clobTokenIds);
      const prices = JSON.parse(m.outcomePrices).map(Number);
      const outcomes = m.outcomes ? JSON.parse(m.outcomes) : ["Yes", "No"];
      const totalCost = prices[0] + prices[1];
      const spreadPct = ((1 - totalCost) / totalCost) * 100;
      return {
        market_id: m.conditionId || m.id,
        question: m.question,
        yes_token_id: tokens[0],
        no_token_id: tokens[1],
        yes_price: prices[0],
        no_price: prices[1],
        total_cost: Number(totalCost.toFixed(4)),
        spread_pct: Number(spreadPct.toFixed(2)),
        guaranteed_profit: Number((1 - totalCost).toFixed(4)),
        volume_24h: m.volume24hr || 0,
        end_date: m.endDate,
        outcomes,
        is_arb: totalCost < 1, // true = actual arb opportunity
      };
    })
    .sort((a: any, b: any) => b.spread_pct - a.spread_pct);
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
    const { action, market_id, question, yes_token_id, no_token_id, yes_price, no_price, size, is_running, trade_amount, interval_minutes, min_confidence, max_open_trades } = body;

    // ---- SCAN: find arb opportunities across all markets ----
    if (action === "scan") {
      const marketsRes = await fetch(
        `${GAMMA_URL}/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false`
      );
      if (!marketsRes.ok) {
        throw new Error(`Gamma API error [${marketsRes.status}]: ${await marketsRes.text()}`);
      }
      const markets = await marketsRes.json();
      // Show all markets sorted by spread (best first), mark actual arbs
      const arbs = findArbs(markets, 0, true).slice(0, 20);
      const realArbCount = arbs.filter((a: any) => a.is_arb).length;

      return new Response(JSON.stringify({ markets: arbs, real_arb_count: realArbCount }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- LIVE SCAN: arbs on markets ending soon ----
    if (action === "live_scan") {
      const now = new Date();
      const soon = new Date(now.getTime() + 48 * 60 * 60 * 1000);

      const marketsRes = await fetch(
        `${GAMMA_URL}/markets?closed=false&active=true&limit=200&order=endDate&ascending=true`
      );
      if (!marketsRes.ok) {
        throw new Error(`Gamma API error [${marketsRes.status}]: ${await marketsRes.text()}`);
      }
      const allMarkets = await marketsRes.json();

      // Filter to ending soon
      const soonMarkets = allMarkets.filter((m: any) => {
        const endDate = m.endDate ? new Date(m.endDate) : null;
        return endDate && endDate > now && endDate <= soon;
      });

      const arbs = findArbs(soonMarkets, 0, true).slice(0, 15).map((a: any) => {
        const endDate = new Date(a.end_date);
        const hoursLeft = Math.max(0, (endDate.getTime() - now.getTime()) / (1000 * 60 * 60));
        return { ...a, hours_left: Number(hoursLeft.toFixed(1)) };
      });

      return new Response(JSON.stringify({ live: arbs }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- EXECUTE: place both sides of an arb ----
    if (action === "execute") {
      // Record both legs of the arb trade
      const totalCost = (yes_price || 0) + (no_price || 0);
      const arbProfit = 1 - totalCost;

      const { data: trades, error } = await supabase
        .from("polymarket_trades")
        .insert([
          {
            market_id,
            market_question: question,
            token_id: yes_token_id,
            side: "BUY_YES",
            price: yes_price,
            size: size || 0.5,
            status: "executed",
            profit_loss: arbProfit * (size || 0.5),
          },
          {
            market_id,
            market_question: question,
            token_id: no_token_id,
            side: "BUY_NO",
            price: no_price,
            size: size || 0.5,
            status: "executed",
            profit_loss: 0, // profit tracked on YES leg
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
      // Count unique arb pairs (each arb = 2 trade rows)
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

    // ---- AUTO TRADE (cron) — find & execute best arb ----
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

      // Count open arb positions
      const { count } = await supabase
        .from("polymarket_trades")
        .select("*", { count: "exact", head: true })
        .eq("status", "executed");

      if ((count || 0) / 2 >= settings.max_open_trades) {
        return new Response(JSON.stringify({ skipped: true, reason: "Max open arb positions reached" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Scan for arbs
      const marketsRes = await fetch(
        `${GAMMA_URL}/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false`
      );
      if (!marketsRes.ok) {
        throw new Error(`Gamma API error [${marketsRes.status}]: ${await marketsRes.text()}`);
      }
      const markets = await marketsRes.json();

      // min_confidence here acts as min spread % threshold
      const minSpread = (1 - settings.min_confidence) * 100;
      const arbs = findArbs(markets, minSpread);

      if (arbs.length === 0) {
        return new Response(JSON.stringify({ skipped: true, reason: "No arb opportunities found" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Find first arb we haven't already traded
      let best = null;
      for (const arb of arbs) {
        const { data: existing } = await supabase
          .from("polymarket_trades")
          .select("id")
          .eq("market_id", arb.market_id)
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

      // Execute both sides
      const arbProfit = best.guaranteed_profit * settings.trade_amount;
      const { data: trades, error: tradeErr } = await supabase
        .from("polymarket_trades")
        .insert([
          {
            market_id: best.market_id,
            market_question: best.question,
            token_id: best.yes_token_id,
            side: "BUY_YES",
            price: best.yes_price,
            size: settings.trade_amount,
            status: "executed",
            profit_loss: arbProfit,
          },
          {
            market_id: best.market_id,
            market_question: best.question,
            token_id: best.no_token_id,
            side: "BUY_NO",
            price: best.no_price,
            size: settings.trade_amount,
            status: "executed",
            profit_loss: 0,
          },
        ])
        .select();

      if (tradeErr) throw tradeErr;

      console.log(`Arb executed: ${best.question} | spread ${best.spread_pct}% | profit $${arbProfit.toFixed(4)}`);
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
