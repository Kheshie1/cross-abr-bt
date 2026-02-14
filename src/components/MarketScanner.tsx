import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useMarketScan, useExecuteTrade } from "@/hooks/useBot";
import { Loader2, ArrowRight } from "lucide-react";

export function MarketScanner() {
  const { data, isLoading } = useMarketScan();
  const execute = useExecuteTrade();
  const markets = data?.markets || [];

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          MARKET SCANNER
          {isLoading && <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 max-h-[400px] overflow-y-auto">
        {markets.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            {isLoading ? "Scanning markets..." : "No opportunities found"}
          </p>
        ) : (
          markets.map((m: any) => (
            <div
              key={m.token_id}
              className="flex items-start justify-between rounded-md border border-border bg-secondary/30 p-3"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{m.question}</p>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant="outline" className="text-xs bg-profit/10 text-profit border-profit/30">
                    {m.best_outcome} @ ${m.price.toFixed(2)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Vol: ${Number(m.volume_24h || 0).toLocaleString()}
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="ml-2 text-profit hover:text-profit hover:bg-profit/10"
                onClick={() =>
                  execute.mutate({
                    market_id: m.market_id,
                    question: m.question,
                    token_id: m.token_id,
                    price: m.price,
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
