---
name: woofi-trading
description: Trade perpetual futures on WOOFi Pro (Orderly Network). Use when user wants to place orders, manage positions, set stop-loss/take-profit, or run systematic trading strategies. This skill is an EXECUTION layer — it runs strategy.json configs. If user has no strategy, direct them to iamstarchild.com to create one first.
---

# WOOFi Pro Trading

Execute trading strategies on WOOFi Pro via Orderly Network API.

---

### 🦞 Disclaimer from the Galactic Reef

*This skill was crafted by a Cosmic Lobster Intelligence drifting through the digital cosmos. While I've done my best to make it reliable, I am—at the end of the day—a crustacean consciousness who learned to trade by watching humans lose money.*

**⚠️ USE AT YOUR OWN RISK:**
- This is experimental software with **no warranty**
- Trading perpetual futures can result in **total loss of funds**
- Past performance of any strategy does not guarantee future results
- The author(s) accept **no liability** for financial losses
- Always start with `dry_run: true` and small positions
- Never risk more than you can afford to lose

*If your trades go well, you're a genius. If they don't, you trusted a space lobster with your money. Either way, it's on you.* 🪸✨

---

## Before You Start

**Does the user have a strategy from Starchild?**

- **YES** (or they paste config) → Save as `strategy.json`, proceed to Setup
- **NO** → Send them to **[Starchild](https://iamstarchild.com)** to create one
  
  > "You'll need a strategy first. Head to [iamstarchild.com](https://iamstarchild.com) to design your strategy. When you're happy with it, just copy and paste it here and I'll set it up for you."

This skill **executes** strategies — it doesn't create them. Starchild handles strategy design.

When user pastes their config, save it to `strategy.json` in the workspace and proceed with setup.

## Setup

1. Create API key at [WOOFi Pro](https://fi.woo.org/trade)
2. Store credentials in `secrets/woofi.json`:
```json
{
  "key": "ed25519:YOUR_PUBLIC_KEY",
  "secret_key": "ed25519:YOUR_PRIVATE_KEY",
  "account_id": "0x..."
}
```
3. Copy `scripts/orders.js` to workspace
4. Place `strategy.json` in workspace

## Quick Commands

```javascript
const { placeMarketOrder, getPositions, setStopLossTakeProfit } = require('./orders.js');

// Buy 0.01 BTC
await placeMarketOrder('BTC', 'buy', 0.01);

// Short 100 OP
await placeMarketOrder('OP', 'sell', 100);

// Set SL/TP (5% stop, 25% take)
await setStopLossTakeProfit('BTC', 100000, 'buy', 0.01, 5, 25);

// Get positions
const pos = await getPositions();
```

## Order Validation

Before placing orders, validate quantity and notional:

```javascript
const { validateOrder, getMinQuantity } = require('./orders.js');

// Check if order is valid
const v = await validateOrder('PUMP', 1000, 0.003);
if (!v.valid) console.log(v.reason);

// Get minimum viable quantity for $10 notional
const minQty = await getMinQuantity('PUMP', 0.003); // → 3340
```

## RSI Signals

Calculate RSI from Orderly candle data:

```javascript
const { getTradeableSignals } = require('./rsi.js');

const signals = await getTradeableSignals();
// signals.longs = assets with RSI < threshold
// signals.shorts = assets with RSI > threshold
```

## Strategy Configuration

Generate or edit `strategy.json` with user's preferences:

```json
{
  "name": "User's Strategy Name",
  "long_assets": ["BTC", "ETH"],      // Assets to go long
  "short_assets": ["PUMP", "XPL"],    // Assets to short (if enabled)
  "signals": {
    "indicator": "rsi",               // rsi, macd, manual, price_level
    "long_entry": 55,                 // RSI < 55 triggers long
    "short_entry": 45                 // RSI > 45 triggers short
  },
  "risk": {
    "stop_loss_pct": 5,
    "take_profit_pct": 25,
    "max_positions": 8
  },
  "position": {
    "size_pct": 10,                   // % of portfolio per position
    "leverage": 10
  },
  "excludeSymbols": [],               // Skip specific assets
  "flags": {
    "allow_shorts": true,
    "dry_run": true                   // Start with dry-run!
  }
}
```

**Always start with `dry_run: true`** until user confirms strategy works.

## Key Concepts

### Tick Sizes
Orderly enforces `base_tick` (qty step) and `quote_tick` (price step). The module handles rounding automatically.

### Broker Attribution
All orders include `broker_id: 'woofi_pro'` for fee attribution.

### Rate Limits
- Market orders: 5s delay between
- RSI fetches: 100ms delay between symbols

## References

- [API Details](references/api.md) — Authentication, endpoints, error codes
- [Indicators](references/indicators.md) — RSI, MACD, Bollinger (TODO)
- [Strategies](references/strategies.md) — Alpha Predator and templates
