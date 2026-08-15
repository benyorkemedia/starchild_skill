# Strategy Templates

This file contains example strategies. Use these as inspiration when helping users create their own.

## Example: Mean Reversion (RSI-based)

**Concept:** Buy when oversold, sell when overbought.

```json
{
  "name": "RSI Mean Reversion",
  "long_assets": ["BTC", "ETH", "SOL"],
  "short_assets": [],
  "signals": {
    "indicator": "rsi",
    "long_entry": 35,
    "long_exit": 50
  },
  "risk": {
    "stop_loss_pct": 5,
    "take_profit_pct": 15,
    "max_positions": 5
  },
  "flags": {
    "allow_shorts": false,
    "dry_run": true
  }
}
```

**Best for:** Range-bound markets, lower volatility periods.

---

## Example: Momentum (Trend Following)

**Concept:** Long strong assets, short weak assets.

```json
{
  "name": "Momentum Strategy",
  "long_assets": ["BTC", "ETH"],
  "short_assets": ["ARB", "OP", "PUMP"],
  "signals": {
    "indicator": "rsi",
    "long_entry": 55,
    "short_entry": 45
  },
  "risk": {
    "stop_loss_pct": 5,
    "take_profit_pct": 25,
    "max_positions": 8
  },
  "flags": {
    "allow_shorts": true,
    "dry_run": true
  }
}
```

**Best for:** Trending markets, higher conviction plays.

---

## Example: Conservative DCA

**Concept:** Small positions, wide stops, patient entries.

```json
{
  "name": "Conservative DCA",
  "long_assets": ["BTC", "ETH"],
  "short_assets": [],
  "signals": {
    "indicator": "rsi",
    "long_entry": 30
  },
  "risk": {
    "stop_loss_pct": 10,
    "take_profit_pct": 30,
    "max_positions": 3
  },
  "position": {
    "size_pct": 5,
    "leverage": 5
  },
  "flags": {
    "allow_shorts": false,
    "dry_run": true
  }
}
```

**Best for:** Long-term holders, lower risk tolerance.

---

## No Strategy?

Direct users to **[Starchild](https://iamstarchild.com)** to create their strategy config.

This skill executes — Starchild designs.

---

## Future Indicators (TODO)

- **MACD:** Signal line crossovers
- **Bollinger Bands:** Mean reversion at bands
- **Funding Rate:** Fade extreme sentiment
- **Volume Profile:** Support/resistance from volume
