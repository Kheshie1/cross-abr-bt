import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/polymarket-trade`;

async function callBot(action: string, body?: Record<string, unknown>) {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || "Request failed");
  }
  return res.json();
}

export function useBotStatus() {
  return useQuery({
    queryKey: ["bot-status"],
    queryFn: () => callBot("status"),
    refetchInterval: 10000,
  });
}

export function useMarketScan() {
  return useQuery({
    queryKey: ["market-scan"],
    queryFn: () => callBot("scan"),
    refetchInterval: 60000,
  });
}

export function useLiveScan() {
  return useQuery({
    queryKey: ["live-scan"],
    queryFn: () => callBot("live_scan"),
    refetchInterval: 60000,
  });
}

export function useToggleBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (is_running: boolean) => callBot("toggle", { is_running }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-status"] }),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: Record<string, unknown>) =>
      callBot("update_settings", settings),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-status"] }),
  });
}

export function useExecuteTrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trade: Record<string, unknown>) => callBot("execute", trade),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-status"] }),
  });
}

export function useRealtimeTrades() {
  const qc = useQueryClient();
  useEffect(() => {
    const channel = supabase
      .channel("trades-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "polymarket_trades" },
        (payload) => {
          qc.invalidateQueries({ queryKey: ["bot-status"] });
          const trade = payload.new as any;
          // Only toast for the YES leg (avoid double notification per arb)
          if (trade.side?.startsWith("BUY_YES")) {
            const platform = trade.side.includes("@") ? trade.side.split("@")[1] : "";
            const profitStr = trade.profit_loss ? `+$${Number(trade.profit_loss).toFixed(4)}` : "";
            toast.success("⚡ Cross-Platform Arb!", {
              description: `${trade.market_question?.slice(0, 60)} ${platform ? `(${platform})` : ""} ${profitStr}`,
              duration: 8000,
            });
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "polymarket_trades" },
        () => {
          qc.invalidateQueries({ queryKey: ["bot-status"] });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);
}
