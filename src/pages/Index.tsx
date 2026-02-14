import { BotHeader } from "@/components/BotHeader";
import { StatsCards } from "@/components/StatsCards";
import { TradesFeed } from "@/components/TradesFeed";
import { MarketScanner } from "@/components/MarketScanner";
import { BotSettings } from "@/components/BotSettings";
import { useBotStatus, useRealtimeTrades } from "@/hooks/useBot";
import { Loader2 } from "lucide-react";

const Index = () => {
  const { data, isLoading } = useBotStatus();
  useRealtimeTrades();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-profit" />
      </div>
    );
  }

  const settings = data?.settings;
  const trades = data?.trades || [];
  const stats = data?.stats || { totalTrades: 0, totalProfit: 0, totalInvested: 0 };

  return (
    <div className="min-h-screen bg-background">
      <BotHeader
        isRunning={settings?.is_running || false}
        totalTrades={stats.totalTrades}
      />
      <main className="mx-auto max-w-6xl space-y-4 p-4">
        <StatsCards
          totalTrades={stats.totalTrades}
          totalProfit={stats.totalProfit}
          totalInvested={stats.totalInvested}
          intervalMinutes={settings?.interval_minutes || 4.47}
        />
        <div className="grid gap-4 lg:grid-cols-2">
          <MarketScanner />
          <TradesFeed trades={trades} />
        </div>
        <BotSettings settings={settings} />
      </main>
    </div>
  );
};

export default Index;
