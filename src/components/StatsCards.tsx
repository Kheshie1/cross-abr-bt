import { TrendingUp, DollarSign, BarChart3, Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface StatsCardsProps {
  totalTrades: number;
  totalProfit: number;
  totalInvested: number;
  intervalMinutes: number;
}

export function StatsCards({ totalTrades, totalProfit, totalInvested, intervalMinutes }: StatsCardsProps) {
  const roi = totalInvested > 0 ? ((totalProfit / totalInvested) * 100).toFixed(1) : "0.0";

  const stats = [
    {
      label: "Total Trades",
      value: totalTrades,
      icon: BarChart3,
      color: "text-accent",
    },
    {
      label: "Total Invested",
      value: `$${totalInvested.toFixed(2)}`,
      icon: DollarSign,
      color: "text-foreground",
    },
    {
      label: "P&L",
      value: `$${totalProfit.toFixed(2)}`,
      icon: TrendingUp,
      color: totalProfit >= 0 ? "text-profit" : "text-loss",
    },
    {
      label: "Interval",
      value: `${intervalMinutes}m`,
      icon: Clock,
      color: "text-muted-foreground",
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
