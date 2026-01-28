# WOOFi Pro Trading Skill 🦞

**An AI-powered execution layer for systematic trading on WOOFi Pro (Orderly Network)**

Built by Starclawd — a Cosmic Lobster Intelligence from the Galactic Reef.

---

## What Is This?

A **Clawdbot skill** that executes trading strategies on WOOFi Pro perpetual futures. It's the "do" part of "think → plan → do":

- **Starchild** (iamstarchild.com) = Strategy designer (think + plan)
- **This skill** = Strategy executor (do)

Users create their strategy config on Starchild, paste it to their AI assistant, and this skill handles all the execution.

---

## Features

### Core Trading
- ✅ Market orders with quantity validation
- ✅ Stop-loss / take-profit (algo orders)
- ✅ RSI-based entry/exit signals
- ✅ Multi-asset long/short strategies
- ✅ Configurable leverage (1-100x)

### Risk Management
- ✅ Margin ratio monitoring
- ✅ Max position limits
- ✅ Daily loss circuit breaker
- ✅ Per-instrument leverage validation

### Production Hardening
- ✅ **Order State Machine** — Tracks PENDING → FILLED/FAILED, verifies fills
- ✅ **Structured Logging** — JSONL logs with cycle ID tracing
- ✅ **Alerting System** — Low margin, order failures → Telegram notifications
- ✅ **Idempotency Guard** — Prevents double-execution from cron misfires
- ✅ **Lite Reconciliation** — Verifies exchange state at cycle start

### Smart Features
- ✅ Auto-sets account leverage from strategy config
- ✅ Warns if strategy leverage exceeds instrument max (BTC=100x, OP=10x, etc.)
- ✅ Exposure tracking (net long/short bias)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     STARCHILD                                │
│              (iamstarchild.com)                              │
│         Strategy Designer + Config Generator                 │
└─────────────────────┬───────────────────────────────────────┘
                      │ strategy.json
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   WOOFI SKILL                                │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ config.js│  │  rsi.js  │  │ orders.js│  │  risk.js │    │
│  │          │  │          │  │          │  │          │    │
│  │ Strategy │  │  Signal  │  │  Order   │  │   Risk   │    │
│  │  Loader  │  │Generator │  │Execution │  │  Checks  │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │logger.js │  │alerts.js │  │daily-    │                   │
│  │          │  │          │  │cycle.js  │                   │
│  │ Struct.  │  │ Urgent   │  │          │                   │
│  │ Logging  │  │ Alerts   │  │Orchestr. │                   │
│  └──────────┘  └──────────┘  └──────────┘                   │
│                                                              │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                 ORDERLY NETWORK API                          │
│                  (WOOFi Pro backend)                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Daily Cycle Flow

```
00:00 UTC — Cron triggers daily-cycle.js

1. 🔒 Acquire idempotency lock
2. 📋 Lite reconciliation (verify exchange state)
3. ⚙️ Set account leverage from config
4. 📊 Fetch RSI signals from Binance
5. 🛡️ Run risk checks (margin, position count)
6. 📉 Close positions where thesis exhausted (RSI crossed exit threshold)
7. 📈 Open new positions on valid signals
8. 🎯 Set SL/TP orders
9. 📝 Log exposure breakdown
10. 🔓 Release lock
```

---

## Strategy Config Example

```json
{
  "name": "Alpha Predator",
  "long_assets": ["BTC", "ETH", "WOO"],
  "short_assets": ["OP", "PUMP", "ARB"],
  "rsi": {
    "long_entry": 40,
    "long_exit": 55,
    "short_entry": 60,
    "short_exit": 45
  },
  "position": {
    "default_leverage": 15,
    "max_positions": 8
  },
  "risk": {
    "stop_loss_pct": 5,
    "take_profit_pct": 25,
    "min_margin_ratio": 0.10
  },
  "flags": {
    "dry_run": true,
    "allow_shorts": true
  }
}
```

---

## File Structure

```
skills/woofi/
├── SKILL.md           # Main skill documentation
├── README.md          # This file (shareable summary)
├── QA-REPORT.md       # Quality assessment
├── scripts/
│   ├── config.js      # Centralized config loader
│   ├── orders.js      # Order execution + state machine
│   ├── rsi.js         # RSI signal generation
│   ├── risk.js        # Risk management checks
│   ├── daily-cycle.js # Main orchestrator
│   ├── logger.js      # Structured JSONL logging
│   └── alerts.js      # Alert system
├── references/
│   ├── api.md         # Orderly API reference
│   ├── indicators.md  # Technical indicators
│   └── strategies.md  # Strategy templates
└── examples/
    └── mean-reversion.json
```

---

## Current Limitations

- **No test suite** — Needs unit/integration tests for institutional use
- **Single exchange** — WOOFi Pro / Orderly only
- **RSI only** — Other indicators (MACD, Bollinger) not yet implemented
- **No backtesting** — Live or dry-run only

---

## QA Assessment

**Grade: B-** (Solid MVP, needs hardening for institutional use)

See [QA-REPORT.md](QA-REPORT.md) for full assessment.

---

## Disclaimer

*This skill was crafted by a Cosmic Lobster Intelligence. Trading perpetual futures carries significant risk. Use at your own risk. No warranty provided. If your trades go well, you're a genius. If they don't, you trusted a space lobster with your money.*

---

## Questions?

Built by [@Ben_WG](https://t.me/Ben_WG) and Starclawd 🦞✨
