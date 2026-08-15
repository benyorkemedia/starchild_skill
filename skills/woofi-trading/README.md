# 🐺 Starchild Skill - WOOFi Trading

An AI-native trading skill that connects [Starchild](https://x.com/StarchildOnX) strategy generation to [WOOFi Pro](https://fi.woo.org) execution via [Clawdbot](https://clawdbot.com).

## What It Does

- **RSI Mean Reversion**: Long strong assets when oversold, short weak assets when overbought
- **Automated Execution**: Daily signal checks and position management
- **Risk Management**: Auto stop-losses, take-profits, and circuit breakers
- **Telegram Alerts**: Get notified when trades happen

## Quick Start

1. Install [Clawdbot](https://clawdbot.com)
2. Clone this skill to your workspace
3. Add your WOOFi Pro API credentials to `secrets/woofi.json`
4. Configure `assets/mean-reversion.json` with your preferred assets
5. Run `node scripts/daily-cycle.js`

## Strategy

The default "Alpha Predator" strategy:
- **Longs**: BTC, ETH, WOO, ZEC, XMR (when RSI < 40)
- **Shorts**: ARB, APT, SUI, OP, etc. (when RSI > 60)
- **Stop Loss**: 5%
- **Take Profit**: 25%

## Requirements

- Node.js 18+
- WOOFi Pro account with API access
- Clawdbot instance (for autonomous operation)

## Disclaimer

This is experimental software. Trading crypto carries risk. Only trade with funds you can afford to lose. Not financial advice.

## Links

- [WOOFi Pro](https://fi.woo.org)
- [Starchild](https://x.com/StarchildOnX)
- [Clawdbot](https://clawdbot.com)
