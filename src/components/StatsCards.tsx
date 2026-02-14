import { TrendingUp, DollarSign, BarChart3, Percent } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface StatsCardsProps {
  totalTrades: number;
  totalProfit: number;
  totalInvested: number;
  intervalMinutes: number;
}

export function StatsCards({ totalTrades, totalProfit, totalInvested, intervalMinutes }: StatsCardsProps) {
  const arbCount = Math.floor(totalTrades / 2);
  const roi = totalInvested > 0 ? ((totalProfit / totalInvested) * 100).toFixed(2) : "0.00";

  const stats = [
    {
      label: "Arb Trades",
      value: arbCount,
      icon: BarChart3,
      color: "text-accent",
    },
    {
      label: "Total Deployed",
      value: `$${totalInvested.toFixed(2)}`,
      icon: DollarSign,
      color: "text-foreground",
    },
    {
      label: "Guaranteed P&L",
      value: `${totalProfit >= 0 ? "+" : ""}$${totalProfit.toFixed(2)}`,
      icon: TrendingUp,
      color: totalProfit >= 0 ? "text-profit" : "text-loss",
    },
    {
      label: "ROI",
      value: `${roi}%`,
      icon: Percent,
      color: Number(roi) >= 0 ? "text-profit" : "text-loss",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((s) => (
        <Card key={s.label} className="bg-card border-border">
          <CardContent className="flex items-center gap-3 p-4">
            <s.icon className={`h-5 w-5 ${s.color}`} />
            <div>
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
