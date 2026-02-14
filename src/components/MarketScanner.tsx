import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useMarketScan, useExecuteTrade } from "@/hooks/useBot";
import { Loader2, ArrowRight, ArrowLeftRight } from "lucide-react";

export function MarketScanner() {
  const { data, isLoading } = useMarketScan();
  const execute = useExecuteTrade();
  const markets = data?.markets || [];
  const polyCount = data?.poly_count || 0;
  const kalshiCount = data?.kalshi_count || 0;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4" />
          CROSS-PLATFORM SCANNER
          {isLoading && <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Comparing {polyCount} Polymarket × {kalshiCount} Kalshi markets — ✅ = real arb (cost &lt; $1.00)
        </p>
      </CardHeader>
      <CardContent className="space-y-2 max-h-[400px] overflow-y-auto">
        {markets.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            {isLoading ? "Scanning both platforms..." : "No matched markets found"}
          </p>
        ) : (
          markets.map((m: any, i: number) => (
            <div
              key={`${m.poly_market?.id}-${i}`}
              className={`flex items-start justify-between rounded-md border p-3 ${
                m.is_arb ? "border-profit/50 bg-profit/5" : "border-border bg-secondary/30"
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {m.is_arb && "✅ "}{m.poly_market?.question || "Unknown"}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Match: {((m.match_score ?? 0) * 100).toFixed(0)}% — Kalshi: {m.kalshi_market?.question?.slice(0, 60) || "?"}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-xs bg-profit/10 text-profit border-profit/30">
                    YES@{(m.buy_yes_platform || "?").toUpperCase()} ${(m.buy_yes_price ?? 0).toFixed(3)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">+</span>
                  <Badge variant="outline" className="text-xs bg-accent/10 text-accent border-accent/30">
                    NO@{(m.buy_no_platform || "?").toUpperCase()} ${(m.buy_no_price ?? 0).toFixed(3)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">=</span>
                  <Badge className={`text-xs font-bold ${
                    m.is_arb ? "bg-profit/20 text-profit border-profit/40" : "bg-muted text-muted-foreground border-border"
                  }`}>
                    ${(m.total_cost ?? 0).toFixed(3)} → {(m.spread_pct ?? 0) > 0 ? "+" : ""}{m.spread_pct ?? 0}%
                  </Badge>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="ml-2 text-profit hover:text-profit hover:bg-profit/10"
                onClick={() =>
                  execute.mutate({
                    market_id: m.poly_market?.id,
                    question: m.poly_market?.question,
                    buy_yes_platform: m.buy_yes_platform,
                    buy_no_platform: m.buy_no_platform,
                    buy_yes_price: m.buy_yes_price,
                    buy_no_price: m.buy_no_price,
                  })
                }
                disabled={execute.isPending || !m.is_arb}
              >
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
