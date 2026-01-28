---
name: woofi-trading
description: Trade perpetual futures on WOOFi Pro (Orderly Network). Use when user wants to place orders, manage positions, set stop-loss/take-profit, or run systematic trading strategies. Triggers on: "trade", "buy/sell [asset]", "open position", "check positions", "set stop loss", "run strategy", "RSI signals". This skill EXECUTES strategy.json configs — if user has no strategy, direct them to iamstarchild.com first.
---

# WOOFi Pro Trading

Execute trading strategies on WOOFi Pro via Orderly Network API.

⚠️ **Risk:** Trading perps can result in total loss. Always start with `dry_run: true`.

## Workflow

**Has strategy?**
- **Yes** → Save to `strategy.json`, proceed
- **No** → Direct to [iamstarchild.com](https://iamstarchild.com) to create one

## Setup

1. API key from [WOOFi Pro](https://fi.woo.org/trade)
2. Store in `secrets/woofi.json`:
```json
{"key": "ed25519:...", "secret_key": "ed25519:...", "account_id": "0x..."}
```
3. Copy `scripts/` to workspace
4. Place `strategy.json` in workspace

## Core Operations

```javascript
const { placeMarketOrder, getPositions, setStopLossTakeProfit, validateOrder } = require('./orders.js');

await placeMarketOrder('BTC', 'buy', 0.01);           // Market buy
await placeMarketOrder('OP', 'sell', 100);            // Short
await setStopLossTakeProfit('BTC', 100000, 'buy', 0.01, 5, 25);  // 5% SL, 25% TP
const pos = await getPositions();                      // Current positions
const v = await validateOrder('PUMP', 1000, 0.003);   // Check before placing
```

## RSI Signals

```javascript
const { getTradeableSignals } = require('./rsi.js');
const signals = await getTradeableSignals();
// signals.longs = RSI < threshold, signals.shorts = RSI > threshold
```

## Strategy Config (strategy.json)

```json
{
  "name": "Strategy Name",
  "long_assets": ["BTC", "ETH"],
  "short_assets": ["PUMP", "XPL"],
  "signals": {"indicator": "rsi", "long_entry": 55, "short_entry": 45},
  "risk": {"stop_loss_pct": 5, "take_profit_pct": 25, "max_positions": 8},
  "position": {"size_pct": 10, "leverage": 10},
  "flags": {"allow_shorts": true, "dry_run": true}
}
```

## Key Concepts

- **Tick sizes**: Module handles rounding automatically
- **Broker ID**: All orders tagged `woofi_pro` for fee attribution
- **Rate limits**: 5s between market orders, 100ms between RSI fetches

## Scripts

| Script | Purpose |
|--------|---------|
| `orders.js` | Core order placement, positions, SL/TP |
| `rsi.js` | RSI calculation and signals |
| `daily-cycle.js` | Automated strategy execution |
| `risk.js` | Margin and position risk checks |
| `alerts.js` | Alert generation and delivery |
| `config.js` | Centralized configuration |
| `logger.js` | Structured JSONL logging |

## References

- [references/api.md](references/api.md) — Authentication, endpoints, error codes
- [references/indicators.md](references/indicators.md) — RSI, ATR, MACD, Funding Rate
- [references/strategies.md](references/strategies.md) — Strategy templates and examples
