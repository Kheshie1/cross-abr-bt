import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useLiveScan, useExecuteTrade } from "@/hooks/useBot";
import { Loader2, Flame, Clock, ArrowRight } from "lucide-react";

export function LiveOpportunities() {
  const { data, isLoading } = useLiveScan();
  const execute = useExecuteTrade();
  const live = data?.live || [];

  return (
    <Card className="bg-card border-border border-l-2 border-l-accent">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-accent flex items-center gap-2">
          <Flame className="h-4 w-4" />
          LIVE ARBS — ENDING SOON
          {isLoading && <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Arb opportunities on markets resolving within 48h — lock in guaranteed profit before resolution
        </p>
      </CardHeader>
      <CardContent className="space-y-2 max-h-[450px] overflow-y-auto">
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            {isLoading ? "Scanning live markets..." : "No live arb opportunities right now"}
          </p>
        ) : (
          live.map((m: any) => (
            <div
              key={m.market_id}
              className="flex items-start justify-between rounded-md border border-border bg-secondary/30 p-3 slide-in"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{m.question}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-xs bg-profit/10 text-profit border-profit/30">
                    Yes ${m.yes_price.toFixed(3)} + No ${m.no_price.toFixed(3)}
                  </Badge>
                  <Badge className="bg-accent/15 text-accent border-accent/30 text-xs font-bold">
                    +{m.spread_pct}% guaranteed
                  </Badge>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {m.hours_left < 1
                      ? `${Math.round(m.hours_left * 60)}m left`
                      : `${m.hours_left}h left`}
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="ml-2 text-accent hover:text-accent hover:bg-accent/10"
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
