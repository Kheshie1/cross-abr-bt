import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeftRight, Timer } from "lucide-react";
import { useState, useEffect } from "react";

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
  resolved_at?: string | null;
}

interface TradesFeedProps {
  trades: Trade[];
}

function Countdown({ target }: { target: string }) {
  const [timeLeft, setTimeLeft] = useState("");
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    function update() {
      const diff = new Date(target).getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft("RESOLVED");
        setIsExpired(true);
        return;
      }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setTimeLeft(
        h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`
      );
      setIsExpired(false);
    }
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [target]);

  return (
    <Badge
      variant="outline"
      className={`text-xs font-mono gap-1 ${
        isExpired
          ? "bg-profit/15 text-profit border-profit/30"
          : "bg-primary/10 text-primary border-primary/30 animate-pulse"
      }`}
    >
      <Timer className="h-3 w-3" />
      {timeLeft}
    </Badge>
  );
}

export function TradesFeed({ trades }: TradesFeedProps) {
  const arbPairs: {
    key: string;
    question: string;
    yesLeg: string;
    noLeg: string;
    yesPrice: number;
    noPrice: number;
    size: number;
    profit: number;
    time: string;
    status: string;
    resolved_at?: string | null;
  }[] = [];
  const seen = new Set<string>();

  for (const t of trades) {
    if (seen.has(t.market_id)) continue;
    seen.add(t.market_id);

    const pair = trades.filter((tr) => tr.market_id === t.market_id);
    const yesLeg = pair.find((p) => p.side.startsWith("BUY_YES"));
    const noLeg = pair.find((p) => p.side.startsWith("BUY_NO"));

    if (yesLeg && noLeg) {
      const yesPlatform = yesLeg.side.includes("@") ? yesLeg.side.split("@")[1] : "?";
      const noPlatform = noLeg.side.includes("@") ? noLeg.side.split("@")[1] : "?";
      arbPairs.push({
        key: t.market_id,
        question: t.market_question,
        yesLeg: yesPlatform,
        noLeg: noPlatform,
        yesPrice: yesLeg.price,
        noPrice: noLeg.price,
        size: yesLeg.size,
        profit: (yesLeg.profit_loss || 0) + (noLeg.profit_loss || 0),
        time: yesLeg.created_at,
        status: yesLeg.status,
        resolved_at: yesLeg.resolved_at || noLeg.resolved_at,
      });
    } else {
      arbPairs.push({
        key: t.id,
        question: t.market_question,
        yesLeg: "?",
        noLeg: "?",
        yesPrice: t.price,
        noPrice: 0,
        size: t.size,
        profit: t.profit_loss || 0,
        time: t.created_at,
        status: t.status,
        resolved_at: t.resolved_at,
      });
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4" />
          RECENT CROSS-PLATFORM TRADES
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 max-h-[400px] overflow-y-auto">
        {arbPairs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No cross-platform trades yet.</p>
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
                        Y@{a.yesLeg} ${a.yesPrice.toFixed(3)} + N@{a.noLeg} ${a.noPrice.toFixed(3)}
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
                  {a.resolved_at && <Countdown target={a.resolved_at} />}
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(a.time), { addSuffix: true })}
                  </span>
                </div>
              </div>
              <Badge
                className={`ml-2 ${
                  a.status === "executed" || a.status === "live"
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
