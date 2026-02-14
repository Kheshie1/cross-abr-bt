import { Wallet, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBalance } from "@/hooks/useBot";
import { useQueryClient } from "@tanstack/react-query";

export function BalanceCard() {
  const { data, isLoading, isError } = useBalance();
  const qc = useQueryClient();

  const polyBal = data?.balances?.polymarket;
  const portfolio = data?.portfolio;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Wallet className="h-4 w-4" />
          Account Balances
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
        {/* Polymarket */}
        <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
          <div>
            <p className="text-xs text-muted-foreground">Polymarket (USDC)</p>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : polyBal?.error ? (
              <p className="text-sm text-loss">{polyBal.error}</p>
            ) : polyBal ? (
              <p className="text-lg font-bold text-foreground">
                ${Number(polyBal.balance).toFixed(2)}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
          </div>
          {polyBal && !polyBal.error && (
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Allowance</p>
              <p className="text-sm font-mono text-foreground">
                ${Number(polyBal.allowance).toFixed(2)}
              </p>
            </div>
          )}
        </div>

        {/* Kalshi */}
        <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
          <div>
            <p className="text-xs text-muted-foreground">Kalshi</p>
            <p className="text-sm text-muted-foreground">Not connected</p>
          </div>
        </div>

        {/* Portfolio summary from DB */}
        {portfolio && (
          <div className="border-t border-border pt-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Bot Deployed</span>
              <span className="font-mono">${portfolio.totalInvested.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Bot Profit</span>
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
