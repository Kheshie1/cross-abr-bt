
-- Polymarket trades table
CREATE TABLE public.polymarket_trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  market_id TEXT NOT NULL,
  market_question TEXT NOT NULL,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  price NUMERIC NOT NULL,
  size NUMERIC NOT NULL DEFAULT 0.5,
  order_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  profit_loss NUMERIC,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.polymarket_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to trades"
  ON public.polymarket_trades
  FOR ALL
  USING (true)
  WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.polymarket_trades;

-- Bot settings table
CREATE TABLE public.bot_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trade_amount NUMERIC NOT NULL DEFAULT 0.5,
  interval_minutes NUMERIC NOT NULL DEFAULT 4.47,
  is_running BOOLEAN NOT NULL DEFAULT false,
  min_confidence NUMERIC NOT NULL DEFAULT 0.65,
  max_open_trades INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to bot settings"
  ON public.bot_settings
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Insert default settings
INSERT INTO public.bot_settings (trade_amount, interval_minutes, is_running) 
VALUES (0.5, 4.47, false);
