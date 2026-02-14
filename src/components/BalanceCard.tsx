import { Wallet, RefreshCw, TrendingUp, TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBalance } from "@/hooks/useBot";
import { useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";

export function BalanceCard() {
  const { data, isLoading } = useBalance();
  const qc = useQueryClient();

  const polyBal = data?.balances?.polymarket;
  const positions = data?.positions || [];
  const portfolio = data?.portfolio;

  const totalValue = (polyBal?.balance || 0) + (polyBal?.portfolioValue || 0);

  return (
    <Card className="bg-card border-border">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Wallet className="h-4 w-4" />
          Polymarket Account
        </CardTitle>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => qc.invalidateQueries({ queryKey: ["balance"] })}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-center">
            <p className="text-[10px] text-muted-foreground">Cash</p>
            <p className="text-sm font-bold text-foreground">
              {isLoading ? "…" : `$${(polyBal?.balance || 0).toFixed(2)}`}
            </p>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-center">
            <p className="text-[10px] text-muted-foreground">Positions</p>
            <p className="text-sm font-bold text-foreground">
              {isLoading ? "…" : `$${(polyBal?.portfolioValue || 0).toFixed(2)}`}
            </p>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-center">
            <p className="text-[10px] text-muted-foreground">Total</p>
            <p className="text-sm font-bold text-profit">
              {isLoading ? "…" : `$${totalValue.toFixed(2)}`}
            </p>
          </div>
        </div>

        {/* Open Positions */}
        {positions.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Open Positions ({polyBal?.positionCount || positions.length})
            </p>
            <ScrollArea className="h-[180px]">
              <div className="space-y-1.5">
                {positions.map((p: any, i: number) => (
                  <div
                    key={i}
                    className="flex items-start justify-between rounded bg-muted/30 px-2.5 py-1.5"
                  >
                    <div className="flex-1 min-w-0 mr-2">
                      <p className="text-xs font-medium text-foreground truncate">
                        {p.market}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {p.outcome} · {p.size.toFixed(1)} shares @ ${p.avgPrice.toFixed(2)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-mono font-semibold text-foreground">
                        ${p.value.toFixed(2)}
                      </p>
                      <p className={`flex items-center justify-end gap-0.5 text-[10px] font-mono ${p.pnl >= 0 ? "text-profit" : "text-loss"}`}>
                        {p.pnl >= 0 ? (
                          <TrendingUp className="h-2.5 w-2.5" />
                        ) : (
                          <TrendingDown className="h-2.5 w-2.5" />
                        )}
                        {p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        {positions.length === 0 && !isLoading && (
          <p className="text-xs text-muted-foreground text-center py-2">
            No open positions found
          </p>
        )}

        {/* Bot stats */}
        {portfolio && (
          <div className="border-t border-border pt-2">
            <p className="text-[10px] font-medium text-muted-foreground mb-1">Bot Activity</p>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Deployed</span>
              <span className="font-mono">${portfolio.totalInvested.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Profit</span>
              <span className={`font-mono font-semibold ${portfolio.totalProfit >= 0 ? "text-profit" : "text-loss"}`}>
                {portfolio.totalProfit >= 0 ? "+" : ""}${portfolio.totalProfit.toFixed(2)}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
