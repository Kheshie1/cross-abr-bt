import { Activity, Power, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToggleBot } from "@/hooks/useBot";

interface BotHeaderProps {
  isRunning: boolean;
  totalTrades: number;
}

export function BotHeader({ isRunning, totalTrades }: BotHeaderProps) {
  const toggle = useToggleBot();

  return (
    <header className="flex items-center justify-between border-b border-border px-6 py-4">
      <div className="flex items-center gap-3">
        <div className={`h-3 w-3 rounded-full ${isRunning ? "bg-profit pulse-glow" : "bg-muted-foreground"}`} />
        <h1 className="text-xl font-bold tracking-tight">
          <Zap className="mr-1 inline h-5 w-5 text-accent" />
          CROSSARB
        </h1>
        <span className="text-xs text-muted-foreground">Polymarket × Kalshi</span>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Activity className="h-4 w-4" />
          <span>{Math.floor(totalTrades / 2)} arbs</span>
        </div>
        <Button
          size="sm"
          variant={isRunning ? "destructive" : "default"}
          onClick={() => toggle.mutate(!isRunning)}
          disabled={toggle.isPending}
          className={!isRunning ? "bg-profit text-primary-foreground hover:bg-profit/90" : ""}
        >
          <Power className="mr-1 h-4 w-4" />
          {isRunning ? "STOP" : "START"}
        </Button>
      </div>
    </header>
  );
}
