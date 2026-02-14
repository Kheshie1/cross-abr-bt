import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeftRight } from "lucide-react";

interface Trade {
  id: string;
  market_question: string;
  side: string;
  price: number;
  size: number;
  status: string;
  profit_loss: number | null;
  created_at: string;
  market_id: string;
}

interface TradesFeedProps {
  trades: Trade[];
}

export function TradesFeed({ trades }: TradesFeedProps) {
  // Group trades by market_id to show arb pairs
  const arbPairs: { key: string; question: string; yesPrice: number; noPrice: number; size: number; profit: number; time: string; status: string }[] = [];
  const seen = new Set<string>();

  for (const t of trades) {
    if (seen.has(t.market_id)) continue;
    seen.add(t.market_id);

    const pair = trades.filter((tr) => tr.market_id === t.market_id);
    const yesLeg = pair.find((p) => p.side === "BUY_YES");
    const noLeg = pair.find((p) => p.side === "BUY_NO");

    if (yesLeg && noLeg) {
      arbPairs.push({
        key: t.market_id,
        question: t.market_question,
        yesPrice: yesLeg.price,
        noPrice: noLeg.price,
        size: yesLeg.size,
        profit: (yesLeg.profit_loss || 0) + (noLeg.profit_loss || 0),
        time: yesLeg.created_at,
        status: yesLeg.status,
      });
    } else {
      // Legacy single trades
      arbPairs.push({
        key: t.id,
        question: t.market_question,
        yesPrice: t.price,
        noPrice: 0,
        size: t.size,
        profit: t.profit_loss || 0,
        time: t.created_at,
        status: t.status,
      });
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4" />
          RECENT ARB TRADES
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 max-h-[400px] overflow-y-auto">
        {arbPairs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No arb trades yet. Start the bot to begin.</p>
        ) : (
          arbPairs.map((a) => (
            <div
              key={a.key}
              className="flex items-start justify-between rounded-md border border-border bg-secondary/30 p-3 slide-in"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{a.question}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {a.noPrice > 0 ? (
                    <>
                      <Badge variant="outline" className="text-xs">
                        Y ${a.yesPrice.toFixed(3)} + N ${a.noPrice.toFixed(3)}
                      </Badge>
                      <Badge className="text-xs bg-profit/15 text-profit border-profit/30">
                        +${a.profit.toFixed(4)}
                      </Badge>
                    </>
                  ) : (
                    <Badge variant="outline" className="text-xs">
                      ${a.size.toFixed(2)} @ {a.yesPrice.toFixed(2)}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(a.time), { addSuffix: true })}
                  </span>
                </div>
              </div>
              <Badge
                className={`ml-2 ${
                  a.status === "executed"
                    ? "bg-profit/20 text-profit border-profit/30"
                    : a.status === "failed"
                    ? "bg-loss/20 text-loss border-loss/30"
                    : "bg-accent/20 text-accent border-accent/30"
                }`}
              >
                {a.status}
              </Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
