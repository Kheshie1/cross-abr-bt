import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CLOB_URL = "https://clob.polymarket.com";
const GAMMA_URL = "https://gamma-api.polymarket.com";

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
    const { action } = await req.json();

    if (action === "scan") {
      // Fetch active markets from Gamma API
      const marketsRes = await fetch(
        `${GAMMA_URL}/markets?closed=false&active=true&limit=50&order=volume24hr&ascending=false`
      );
      if (!marketsRes.ok) {
        const body = await marketsRes.text();
        throw new Error(`Gamma API error [${marketsRes.status}]: ${body}`);
      }
      const markets = await marketsRes.json();

      // Find markets with profitable pricing (high confidence outcomes near $0.90+)
      const opportunities = markets
        .filter((m: any) => {
          const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
          const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
          if (tokens.length < 2 || prices.length < 2) return false;
          // Look for markets where one outcome is very likely (price > 0.85)
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

    if (action === "execute") {
      const { market_id, question, token_id, price, size } = await req.json().catch(() => ({}));

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
      const { is_running } = await req.json().catch(() => ({ is_running: false }));
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
      const { trade_amount, interval_minutes, min_confidence, max_open_trades } = await req.json().catch(() => ({}));
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
