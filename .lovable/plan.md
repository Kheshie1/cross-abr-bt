

# Sports Arbitrage Scanner & Dashboard

## Overview
A real-time arbitrage opportunity scanner that monitors odds across Pinnacle and Betway SA, identifies profitable arbitrage opportunities (1%+ margin), and presents them with precise stake calculations for quick action.

## Core Features

### 1. Dashboard Home
- Live feed of current arbitrage opportunities sorted by profit margin
- Key stats: total opportunities found today, average margin, best opportunity
- Status indicators showing whether each bookmaker's odds feed is active
- Auto-refresh with configurable scan interval

### 2. Odds Scanner Engine (Backend)
- **Pinnacle**: Edge function fetching odds via their official API across all sports
- **Betway SA**: Edge function using Firecrawl to scrape current odds from their website
- Odds normalization to a common format for comparison
- Match matching algorithm to pair the same events across both bookmakers

### 3. Arbitrage Calculator
- Real-time arbitrage detection comparing odds across both books
- Filter to only show opportunities with 1%+ guaranteed profit
- Optimal stake calculator — given a total bankroll, shows exact amounts to place on each side
- Support for 2-way and 3-way markets (match winner, over/under, etc.)

### 4. Opportunity Detail View
- Event details (sport, league, teams, start time)
- Side-by-side odds comparison (Pinnacle vs Betway SA)
- Calculated arbitrage percentage
- Recommended stakes for each bookmaker
- Expected guaranteed profit amount
- Direct links to the event on each bookmaker's website for quick manual placement

### 5. History & Analytics
- Log of all detected arbitrage opportunities
- Track which ones were acted on (manual marking)
- Profit/loss tracking over time
- Charts showing opportunity frequency by sport, time of day, and margin range

### 6. Settings & Configuration
- API key input for Pinnacle
- Scan frequency configuration
- Minimum arbitrage threshold setting
- Bankroll amount for stake calculations
- Sport/league filters
- Sound/browser notification alerts for new opportunities

## Technical Approach
- **Frontend**: React dashboard with real-time updates via polling
- **Backend**: Supabase edge functions for odds fetching and arbitrage calculation
- **Data**: Supabase database to store odds history and detected opportunities
- **Scraping**: Firecrawl connector for Betway SA odds extraction
- **Note**: Bet placement is manual — the app provides direct links and calculated stakes for you to place bets yourself quickly

