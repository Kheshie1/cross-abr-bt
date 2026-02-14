import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useMarketScan, useExecuteTrade } from "@/hooks/useBot";
import { Loader2, ArrowRight, ArrowLeftRight } from "lucide-react";

export function MarketScanner() {
  const { data, isLoading } = useMarketScan();
  const execute = useExecuteTrade();
  const markets = data?.markets || [];

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4" />
          ARB SCANNER
          {isLoading && <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Markets where Yes + No &lt; $1.00 — guaranteed profit on resolution
        </p>
      </CardHeader>
      <CardContent className="space-y-2 max-h-[400px] overflow-y-auto">
        {markets.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            {isLoading ? "Scanning for arbitrage..." : "No arb opportunities found"}
          </p>
        ) : (
          markets.map((m: any) => (
            <div
              key={m.market_id}
              className="flex items-start justify-between rounded-md border border-border bg-secondary/30 p-3"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{m.question}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-xs bg-profit/10 text-profit border-profit/30">
                    Yes ${(m.yes_price ?? 0).toFixed(3)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">+</span>
                  <Badge variant="outline" className="text-xs bg-accent/10 text-accent border-accent/30">
                    No ${(m.no_price ?? 0).toFixed(3)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">=</span>
                  <Badge className="text-xs bg-profit/20 text-profit border-profit/40 font-bold">
                    ${(m.total_cost ?? 0).toFixed(3)} → +{m.spread_pct ?? 0}%
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Vol: ${Number(m.volume_24h || 0).toLocaleString()}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="ml-2 text-profit hover:text-profit hover:bg-profit/10"
                onClick={() =>
                  execute.mutate({
                    market_id: m.market_id,
                    question: m.question,
                    yes_token_id: m.yes_token_id,
                    no_token_id: m.no_token_id,
                    yes_price: m.yes_price,
                    no_price: m.no_price,
                  })
                }
                disabled={execute.isPending}
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
