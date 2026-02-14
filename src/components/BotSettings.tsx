import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useUpdateSettings } from "@/hooks/useBot";
import { useState } from "react";
import { Settings } from "lucide-react";

interface BotSettingsProps {
  settings: {
    trade_amount: number;
    interval_minutes: number;
    min_confidence: number;
    max_open_trades: number;
  } | null;
}

export function BotSettings({ settings }: BotSettingsProps) {
  const update = useUpdateSettings();
  const [form, setForm] = useState({
    trade_amount: settings?.trade_amount ?? 0.5,
    interval_minutes: settings?.interval_minutes ?? 4.47,
    min_confidence: settings?.min_confidence ?? 0.65,
    max_open_trades: settings?.max_open_trades ?? 10,
  });

  const handleSave = () => {
    update.mutate(form);
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Settings className="h-4 w-4" />
          ARB BOT SETTINGS
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Trade Amount ($)</Label>
            <Input
              type="number"
              step="0.1"
              value={form.trade_amount}
              onChange={(e) => setForm({ ...form, trade_amount: Number(e.target.value) })}
              className="bg-secondary border-border"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Interval (min)</Label>
            <Input
              type="number"
              step="0.01"
              value={form.interval_minutes}
              onChange={(e) => setForm({ ...form, interval_minutes: Number(e.target.value) })}
              className="bg-secondary border-border"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Min Confidence</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={form.min_confidence}
              onChange={(e) => setForm({ ...form, min_confidence: Number(e.target.value) })}
              className="bg-secondary border-border"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Max Open Trades</Label>
            <Input
              type="number"
              value={form.max_open_trades}
              onChange={(e) => setForm({ ...form, max_open_trades: Number(e.target.value) })}
              className="bg-secondary border-border"
            />
          </div>
        </div>
        <Button
          onClick={handleSave}
          disabled={update.isPending}
          className="w-full bg-secondary text-foreground hover:bg-secondary/80"
          size="sm"
        >
          Save Settings
        </Button>
      </CardContent>
    </Card>
  );
}
