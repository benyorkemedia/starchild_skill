# Technical Indicators

## Implemented

### RSI (Relative Strength Index)

Momentum oscillator measuring speed/magnitude of price changes.

**Formula:**
```
RSI = 100 - (100 / (1 + RS))
RS = Average Gain / Average Loss (over N periods)
```

**Usage in scripts/rsi.js:**
```javascript
const { getAssetRSI, getTradeableSignals } = require('./rsi.js');

// Single asset
const btc = await getAssetRSI('BTC');
// { asset: 'BTC', rsi: 46.5, price: 100000 }

// All strategy assets
const signals = await getTradeableSignals();
// { longs: [...], shorts: [...], marketBias: 'neutral' }
```

**Interpretation:**
- RSI > 70: Overbought (potential short)
- RSI < 30: Oversold (potential long)
- RSI > 50: Bullish momentum
- RSI < 50: Bearish momentum

---

## TODO: Future Indicators

### MACD (Moving Average Convergence Divergence)

**Formula:**
```
MACD Line = EMA(12) - EMA(26)
Signal Line = EMA(9) of MACD Line
Histogram = MACD Line - Signal Line
```

**Signals:**
- MACD crosses above Signal → Bullish
- MACD crosses below Signal → Bearish
- Histogram growing → Momentum increasing

### Bollinger Bands

**Formula:**
```
Middle Band = SMA(20)
Upper Band = Middle + (2 × StdDev)
Lower Band = Middle - (2 × StdDev)
```

**Signals:**
- Price at Lower Band → Potential long (mean reversion)
- Price at Upper Band → Potential short (mean reversion)
- Band squeeze → Low volatility, breakout incoming

### EMA (Exponential Moving Average)

**Formula:**
```
EMA = Price × k + EMA(prev) × (1 - k)
k = 2 / (N + 1)
```

**Signals:**
- Price > EMA → Bullish trend
- Price < EMA → Bearish trend
- EMA crossovers (9/21, 50/200) → Trend changes

### ATR (Average True Range)

**Formula:**
```
TR = max(High - Low, |High - PrevClose|, |Low - PrevClose|)
ATR = SMA(TR, 14)
```

**Usage:**
- Position sizing: Smaller size when ATR high
- Stop-loss placement: SL = Entry ± (2 × ATR)

### Funding Rate (Perp-specific)

**Source:** Exchange API (not calculated)

**Signals:**
- High positive funding → Longs paying shorts (crowded long)
- High negative funding → Shorts paying longs (crowded short)
- Fade extreme funding for mean reversion
