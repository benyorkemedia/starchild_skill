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

**CLI:**
```bash
node scripts/rsi.js          # All strategy assets
node scripts/rsi.js BTC      # Single asset
node scripts/rsi.js --json   # JSON output
```

**Interpretation:**
- RSI > 70: Overbought (potential short)
- RSI < 30: Oversold (potential long)
- RSI > 50: Bullish momentum
- RSI < 50: Bearish momentum

---

### ATR (Average True Range)

Volatility indicator for dynamic stop-loss/take-profit sizing.

**Formula:**
```
TR = max(High - Low, |High - PrevClose|, |Low - PrevClose|)
ATR = Wilder's smoothed average of TR over N periods
```

**Usage in scripts/indicators/atr.js:**
```javascript
const { getATR, getMultipleATR, classifyVolatility } = require('./indicators/atr.js');

// Single asset
const btc = await getATR('BTC', 14, '1d');
// {
//   asset: 'BTC',
//   atr: 2268.75,
//   atrPercent: 2.55,
//   price: 89052.20,
//   suggestedSL: 4537.50,  // 2x ATR
//   suggestedTP: 9075.00   // 4x ATR
// }

// Multiple assets
const all = await getMultipleATR(['BTC', 'ETH', 'WOO']);

// Classify volatility
classifyVolatility(2.55);  // 'moderate'
```

**CLI:**
```bash
node scripts/indicators/atr.js          # Default assets (BTC, ETH, WOO, ARB, SUI)
node scripts/indicators/atr.js BTC      # Single asset
node scripts/indicators/atr.js --json   # JSON output
```

**Volatility Classification:**
- < 2%: Low (🟢)
- 2-5%: Moderate (🟡)
- 5-10%: High (🟠)
- > 10%: Extreme (🔴)

**Risk Management:**
- Stop-loss = Entry ± 2×ATR
- Take-profit = Entry ± 4×ATR (2:1 reward/risk)

---

### MACD (Moving Average Convergence Divergence)

Trend-following momentum indicator.

**Formula:**
```
MACD Line = EMA(12) - EMA(26)
Signal Line = EMA(9) of MACD Line
Histogram = MACD Line - Signal Line
```

**Usage in scripts/indicators/macd.js:**
```javascript
const { getMACD, getMultipleMACD, confirmsTrend } = require('./indicators/macd.js');

// Single asset
const btc = await getMACD('BTC');
// {
//   asset: 'BTC',
//   macd: -677.647,
//   signal: -184.577,
//   histogram: -493.070,
//   crossover: 'bearish',
//   momentum: 'weakening_bearish'
// }

// With custom parameters
const eth = await getMACD('ETH', { fastPeriod: 8, slowPeriod: 21, signalPeriod: 5 });

// Check if MACD confirms RSI signal
confirmsTrend(btcResult, 'long');  // true/false
```

**CLI:**
```bash
node scripts/indicators/macd.js          # Default assets
node scripts/indicators/macd.js BTC      # Single asset
node scripts/indicators/macd.js --json   # JSON output
```

**Crossover Signals:**
- `bullish_crossover`: MACD crosses above Signal (buy signal)
- `bearish_crossover`: MACD crosses below Signal (sell signal)
- `bullish`: MACD above Signal
- `bearish`: MACD below Signal

**Momentum States:**
- `strong_bullish`: Positive histogram growing
- `weakening_bullish`: Positive histogram shrinking
- `strong_bearish`: Negative histogram growing
- `weakening_bearish`: Negative histogram shrinking

---

### Funding Rate (Perp-specific)

Real-time funding rate for crowded trade detection.

**Source:** Orderly API (`/v1/public/funding_rate`)

**Usage in scripts/indicators/funding.js:**
```javascript
const { getFundingRate, getMultipleFundingRates, confirmsTrade } = require('./indicators/funding.js');

// Single asset
const btc = await getFundingRate('BTC');
// {
//   asset: 'BTC',
//   rate: 0.0001,
//   ratePercent: '0.0100%',
//   annualizedPercent: '10.93%',
//   sentiment: 'neutral',
//   signal: 'neutral',
//   signalReason: 'Funding rate within normal range'
// }

// Check if funding confirms trade direction
confirmsTrade(btcResult, 'long');  // true if not crowded long
```

**CLI:**
```bash
node scripts/indicators/funding.js              # Default assets
node scripts/indicators/funding.js BTC          # Single asset
node scripts/indicators/funding.js BTC --history  # Show funding history
node scripts/indicators/funding.js --json       # JSON output
```

**Sentiment Classification:**
- `extreme_long`: Rate > 0.03% (shorts paying heavily → bearish signal)
- `crowded_long`: Rate > 0.01% (longs paying → bearish bias)
- `neutral`: Rate within normal range
- `crowded_short`: Rate < -0.01% (shorts paying → bullish bias)
- `extreme_short`: Rate < -0.03% (longs paying heavily → bullish signal)

**Trading Signals:**
- High positive funding → Don't go long (crowded trade)
- High negative funding → Don't go short (crowded trade)
- Use funding to fade extreme positioning

---

## Indicator Combinations

### RSI + MACD Confirmation
```javascript
const rsi = await getAssetRSI('BTC');
const macd = await getMACD('BTC');

// Long signal: RSI < 40 AND MACD bullish
const longSignal = rsi.rsi < 40 && confirmsTrend(macd, 'long');

// Short signal: RSI > 60 AND MACD bearish  
const shortSignal = rsi.rsi > 60 && confirmsTrend(macd, 'short');
```

### ATR-Based Position Sizing
```javascript
const atr = await getATR('BTC');
const vol = classifyVolatility(atr.atrPercent);

// Reduce size in high volatility
const sizeMultiplier = vol === 'extreme' ? 0.5 : 
                       vol === 'high' ? 0.75 : 1.0;
```

### Funding Rate Filter
```javascript
const funding = await getFundingRate('BTC');

// Skip trade if funding doesn't confirm
if (!confirmsTrade(funding, side)) {
  console.log('Skipping: crowded trade');
}
```

---

## TODO: Phase 2 Indicators

### Bollinger Bands
- Mean reversion at ±2 std dev
- Squeeze detection for breakouts

### EMA Filter
- 200 EMA trend filter
- Only long above, short below

### Volume Confirmation
- High volume validates signals
- Low volume = skip or reduce size
