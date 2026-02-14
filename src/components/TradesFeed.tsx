import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";

interface Trade {
  id: string;
  market_question: string;
  side: string;
  price: number;
  size: number;
  status: string;
  profit_loss: number | null;
  created_at: string;
}

interface TradesFeedProps {
  trades: Trade[];
}

export function TradesFeed({ trades }: TradesFeedProps) {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">RECENT TRADES</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 max-h-[400px] overflow-y-auto">
        {trades.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No trades yet. Start the bot to begin.</p>
        ) : (
          trades.map((t) => (
            <div
              key={t.id}
              className="flex items-start justify-between rounded-md border border-border bg-secondary/30 p-3 slide-in"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{t.market_question}</p>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {t.side}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    ${t.size.toFixed(2)} @ {t.price.toFixed(2)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(t.created_at), { addSuffix: true })}
                  </span>
                </div>
              </div>
              <Badge
                className={`ml-2 ${
                  t.status === "executed"
                    ? "bg-profit/20 text-profit border-profit/30"
                    : t.status === "failed"
                    ? "bg-loss/20 text-loss border-loss/30"
                    : "bg-accent/20 text-accent border-accent/30"
                }`}
              >
                {t.status}
              </Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
