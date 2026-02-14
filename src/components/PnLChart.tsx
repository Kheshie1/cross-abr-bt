import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useMemo } from "react";

interface Trade {
  id: string;
  created_at: string;
  size: number;
  price: number;
  profit_loss: number | null;
  status: string;
  market_question: string;
}

interface PnLChartProps {
  trades: Trade[];
}

export function PnLChart({ trades }: PnLChartProps) {
  const chartData = useMemo(() => {
    if (!trades || trades.length === 0) return [];

    const sorted = [...trades].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    let cumPnL = 0;
    let cumInvested = 0;

    return sorted.map((t, i) => {
      const pnl = t.profit_loss ?? 0;
      cumPnL += pnl;
      cumInvested += t.size || 0;

      const date = new Date(t.created_at);
      return {
        name: `#${i + 1}`,
        time: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        pnl: Number(cumPnL.toFixed(2)),
        invested: Number(cumInvested.toFixed(2)),
        tradeReturn: Number(pnl.toFixed(2)),
      };
    });
  }, [trades]);

  const latestPnL = chartData.length > 0 ? chartData[chartData.length - 1].pnl : 0;
  const isPositive = latestPnL >= 0;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center justify-between">
          <span className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            P&L OVER TIME
          </span>
          <span
            className={`text-lg font-bold ${isPositive ? "text-profit" : "text-loss"}`}
          >
            {isPositive ? "+" : ""}${latestPnL.toFixed(2)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-muted-foreground text-sm">
            No trades yet — chart will populate as trades execute
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor={isPositive ? "hsl(142, 72%, 50%)" : "hsl(0, 72%, 55%)"}
                    stopOpacity={0.3}
                  />
                  <stop
                    offset="95%"
                    stopColor={isPositive ? "hsl(142, 72%, 50%)" : "hsl(0, 72%, 55%)"}
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 14%, 14%)" />
              <XAxis
                dataKey="time"
                tick={{ fill: "hsl(215, 14%, 50%)", fontSize: 11 }}
                axisLine={{ stroke: "hsl(220, 14%, 14%)" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "hsl(215, 14%, 50%)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${v}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(220, 18%, 7%)",
                  border: "1px solid hsl(220, 14%, 14%)",
                  borderRadius: "8px",
                  color: "hsl(210, 20%, 92%)",
                  fontSize: 12,
                }}
                formatter={(value: number, name: string) => {
                  const label = name === "pnl" ? "Cumulative P&L" : name;
                  return [`$${value.toFixed(2)}`, label];
                }}
              />
              <Area
                type="monotone"
                dataKey="pnl"
                stroke={isPositive ? "hsl(142, 72%, 50%)" : "hsl(0, 72%, 55%)"}
                strokeWidth={2}
                fill="url(#pnlGradient)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
