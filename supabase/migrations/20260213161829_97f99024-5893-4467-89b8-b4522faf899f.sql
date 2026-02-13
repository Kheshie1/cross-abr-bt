
-- Settings table (no auth needed - single user app)
CREATE TABLE public.scanner_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pinnacle_api_key TEXT,
  scan_frequency_seconds INTEGER NOT NULL DEFAULT 120,
  min_arb_threshold NUMERIC(5,2) NOT NULL DEFAULT 1.0,
  bankroll NUMERIC(12,2) NOT NULL DEFAULT 1000.00,
  sport_filters TEXT[] DEFAULT '{}',
  notifications_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.scanner_settings ENABLE ROW LEVEL SECURITY;

-- Public access for single-user app
CREATE POLICY "Allow all access to settings" ON public.scanner_settings FOR ALL USING (true) WITH CHECK (true);

-- Odds snapshots from each bookmaker
CREATE TABLE public.odds_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bookmaker TEXT NOT NULL, -- 'pinnacle' or 'betway'
  sport TEXT NOT NULL,
  league TEXT,
  event_name TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  starts_at TIMESTAMPTZ,
  market_type TEXT NOT NULL DEFAULT 'moneyline', -- moneyline, totals, spread
  outcome_1_name TEXT NOT NULL,
  outcome_1_odds NUMERIC(8,4) NOT NULL,
  outcome_2_name TEXT NOT NULL,
  outcome_2_odds NUMERIC(8,4) NOT NULL,
  outcome_3_name TEXT,
  outcome_3_odds NUMERIC(8,4),
  external_event_id TEXT,
  external_url TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.odds_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to odds" ON public.odds_snapshots FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_odds_event ON public.odds_snapshots (home_team, away_team, sport, market_type);
CREATE INDEX idx_odds_fetched ON public.odds_snapshots (fetched_at DESC);

-- Detected arbitrage opportunities
CREATE TABLE public.arbitrage_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport TEXT NOT NULL,
  league TEXT,
  event_name TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  starts_at TIMESTAMPTZ,
  market_type TEXT NOT NULL,
  arb_percentage NUMERIC(6,3) NOT NULL,
  
  book1_name TEXT NOT NULL DEFAULT 'Pinnacle',
  book1_outcome TEXT NOT NULL,
  book1_odds NUMERIC(8,4) NOT NULL,
  book1_stake NUMERIC(12,2),
  book1_url TEXT,
  
  book2_name TEXT NOT NULL DEFAULT 'Betway',
  book2_outcome TEXT NOT NULL,
  book2_odds NUMERIC(8,4) NOT NULL,
  book2_stake NUMERIC(12,2),
  book2_url TEXT,
  
  book3_outcome TEXT,
  book3_odds NUMERIC(8,4),
  book3_stake NUMERIC(12,2),
  book3_name TEXT,
  book3_url TEXT,
  
  total_stake NUMERIC(12,2),
  expected_profit NUMERIC(12,2),
  
  status TEXT NOT NULL DEFAULT 'active', -- active, expired, acted_on, skipped
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expired_at TIMESTAMPTZ
);

ALTER TABLE public.arbitrage_opportunities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to arbs" ON public.arbitrage_opportunities FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_arb_status ON public.arbitrage_opportunities (status, detected_at DESC);
CREATE INDEX idx_arb_profit ON public.arbitrage_opportunities (arb_percentage DESC);

-- Insert default settings row
INSERT INTO public.scanner_settings (scan_frequency_seconds, min_arb_threshold, bankroll) 
VALUES (120, 1.0, 1000.00);

-- Enable realtime for opportunities
ALTER PUBLICATION supabase_realtime ADD TABLE public.arbitrage_opportunities;
