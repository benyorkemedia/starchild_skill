# Indicators Roadmap 📊

## Phase 1: Core Additions (Priority)

### 1.1 ATR (Average True Range) — Dynamic Risk Sizing
**Purpose:** Volatility-adjusted stop-loss/take-profit instead of fixed percentages

**Implementation:**
- Add `atr.js` module
- Calculate ATR(14) from Orderly candles
- Modify `setStopLossTakeProfit()` to accept ATR multiplier
- Config: `risk.atr_sl_multiplier: 2` (SL = entry ± 2×ATR)

**Effort:** 2 hours

---

### 1.2 MACD — Trend Confirmation
**Purpose:** Filter RSI signals with trend direction

**Implementation:**
- Add `macd.js` module (12/26/9 default)
- Signal logic: RSI + MACD alignment = stronger conviction
- Config option: `signals.require_macd_confirmation: true`

**Effort:** 3 hours

---

### 1.3 Funding Rate — Perp-Native Alpha
**Purpose:** Fade crowded trades, identify overextended positioning

**Implementation:**
- Fetch funding from Orderly API (`/v1/public/funding_rate`)
- Add to signal scoring: high positive funding = bearish bias
- Config: `signals.funding_threshold: 0.01` (1% = caution)

**Effort:** 2 hours

---

## Phase 2: Enhanced Signals

### 2.1 Bollinger Bands
- Mean reversion at ±2 std dev
- Squeeze detection for breakout plays

### 2.2 EMA Filter
- Only long above 200 EMA
- Only short below 200 EMA
- Trend alignment scoring

### 2.3 Volume Confirmation
- High volume = valid signal
- Low volume = skip/reduce size

---

## Phase 3: Advanced

### 3.1 Open Interest Analysis
### 3.2 Correlation Risk
### 3.3 Multi-timeframe Confluence

---

## Implementation Notes

**File structure:**
```
scripts/
├── indicators/
│   ├── atr.js
│   ├── macd.js
│   ├── funding.js
│   ├── bollinger.js
│   └── ema.js
├── signals.js  (combines all indicators)
└── rsi.js (existing)
```

**Config extension:**
```json
{
  "signals": {
    "indicator": "rsi",
    "secondary": ["macd", "funding"],
    "require_confirmation": true
  },
  "risk": {
    "use_atr": true,
    "atr_sl_multiplier": 2,
    "atr_tp_multiplier": 4
  }
}
```

---

## Acceptance Criteria

Each indicator must:
1. Have standalone module with clear API
2. Work with Orderly data (no external dependencies)
3. Include CLI test command
4. Update SKILL.md with usage
5. Push to GitHub when complete
