#!/usr/bin/env node
/**
 * MACD (Moving Average Convergence Divergence) Calculator
 * Trend-following momentum indicator
 * Uses Orderly's TradingView-compatible endpoint
 */

const https = require('https');
const { getConfig } = require('../config.js');

// MACD default parameters (12, 26, 9)
const DEFAULT_FAST = 12;
const DEFAULT_SLOW = 26;
const DEFAULT_SIGNAL = 9;
const DEFAULT_TIMEFRAME = '1d';

/**
 * Convert timeframe to TradingView resolution
 */
function toResolution(tf) {
  const map = { '1d': 'D', '4h': '240', '1h': '60', '15m': '15' };
  return map[tf] || 'D';
}

/**
 * Fetch klines from Orderly (TradingView endpoint)
 */
function fetchKlines(symbol, interval = '1d', limit = 100) {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const daysBack = interval === '1d' ? limit : Math.ceil(limit / 24);
    const from = now - (daysBack * 86400);
    const resolution = toResolution(interval);
    
    const url = `/tv/history?symbol=PERP_${symbol}_USDC&resolution=${resolution}&from=${from}&to=${now}`;
    
    const req = https.request({
      hostname: 'api-evm.orderly.org',
      port: 443,
      path: url,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const tv = JSON.parse(data);
          if (tv.s !== 'ok' || !tv.c) {
            reject(new Error(`Orderly returned: ${JSON.stringify(tv)}`));
            return;
          }
          // Extract close prices
          const closes = tv.c.map(c => parseFloat(c));
          resolve(closes);
        } catch (e) {
          reject(new Error(`Failed to parse Orderly response for ${symbol}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Calculate EMA (Exponential Moving Average)
 * EMA = Price × k + EMA(prev) × (1 - k)
 * k = 2 / (N + 1)
 */
function calculateEMA(prices, period) {
  if (prices.length < period) {
    throw new Error(`Need at least ${period} prices, got ${prices.length}`);
  }

  const k = 2 / (period + 1);
  const emaValues = [];
  
  // First EMA is SMA of first N prices
  let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
  emaValues.push(ema);
  
  // Calculate EMA for remaining prices
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    emaValues.push(ema);
  }
  
  return emaValues;
}

/**
 * Calculate MACD from closing prices
 * MACD Line = EMA(12) - EMA(26)
 * Signal Line = EMA(9) of MACD Line
 * Histogram = MACD Line - Signal Line
 */
function calculateMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (closes.length < slowPeriod + signalPeriod) {
    throw new Error(`Need at least ${slowPeriod + signalPeriod} candles, got ${closes.length}`);
  }

  // Calculate fast and slow EMAs
  const fastEMA = calculateEMA(closes, fastPeriod);
  const slowEMA = calculateEMA(closes, slowPeriod);
  
  // MACD line = Fast EMA - Slow EMA
  // Align arrays (slow EMA starts later)
  const offset = slowPeriod - fastPeriod;
  const macdLine = [];
  
  for (let i = 0; i < slowEMA.length; i++) {
    macdLine.push(fastEMA[i + offset] - slowEMA[i]);
  }
  
  // Signal line = EMA(9) of MACD line
  const signalLine = calculateEMA(macdLine, signalPeriod);
  
  // Histogram = MACD - Signal
  // Align with signal line
  const histogramOffset = signalPeriod - 1;
  const histogram = [];
  
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + histogramOffset] - signalLine[i]);
  }
  
  // Return most recent values
  return {
    macd: macdLine[macdLine.length - 1],
    signal: signalLine[signalLine.length - 1],
    histogram: histogram[histogram.length - 1],
    // Also include previous values for crossover detection
    prevMacd: macdLine[macdLine.length - 2],
    prevSignal: signalLine[signalLine.length - 2],
    prevHistogram: histogram[histogram.length - 2]
  };
}

/**
 * Detect MACD crossover signals
 */
function detectCrossover(macd, prevMacd, signal, prevSignal) {
  // Bullish crossover: MACD crosses above Signal
  if (prevMacd <= prevSignal && macd > signal) {
    return 'bullish_crossover';
  }
  // Bearish crossover: MACD crosses below Signal
  if (prevMacd >= prevSignal && macd < signal) {
    return 'bearish_crossover';
  }
  // Above signal line = bullish
  if (macd > signal) {
    return 'bullish';
  }
  // Below signal line = bearish
  return 'bearish';
}

/**
 * Detect momentum from histogram
 */
function detectMomentum(histogram, prevHistogram) {
  if (histogram > 0 && histogram > prevHistogram) return 'strong_bullish';
  if (histogram > 0 && histogram < prevHistogram) return 'weakening_bullish';
  if (histogram < 0 && histogram < prevHistogram) return 'strong_bearish';
  if (histogram < 0 && histogram > prevHistogram) return 'weakening_bearish';
  return 'neutral';
}

/**
 * Get MACD for a single asset
 * @param {string} asset - Asset symbol (e.g., 'BTC')
 * @param {Object} params - Optional MACD parameters
 * @returns {Promise<Object>} MACD data
 */
async function getMACD(asset, params = {}) {
  const {
    fastPeriod = DEFAULT_FAST,
    slowPeriod = DEFAULT_SLOW,
    signalPeriod = DEFAULT_SIGNAL,
    timeframe = DEFAULT_TIMEFRAME
  } = params;

  try {
    const closes = await fetchKlines(asset, timeframe, slowPeriod + signalPeriod + 50);
    
    if (!Array.isArray(closes) || closes.length === 0) {
      return { asset, error: 'No data available', macd: null };
    }
    
    const macdData = calculateMACD(closes, fastPeriod, slowPeriod, signalPeriod);
    const crossover = detectCrossover(
      macdData.macd, macdData.prevMacd,
      macdData.signal, macdData.prevSignal
    );
    const momentum = detectMomentum(macdData.histogram, macdData.prevHistogram);
    
    return {
      asset,
      macd: Math.round(macdData.macd * 1000) / 1000,
      signal: Math.round(macdData.signal * 1000) / 1000,
      histogram: Math.round(macdData.histogram * 1000) / 1000,
      crossover,
      momentum,
      price: closes[closes.length - 1],
      params: { fastPeriod, slowPeriod, signalPeriod },
      timeframe,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return { asset, error: error.message, macd: null };
  }
}

/**
 * Get MACD for multiple assets
 */
async function getMultipleMACD(assets, params = {}) {
  const results = [];
  
  for (const asset of assets) {
    const result = await getMACD(asset, params);
    results.push(result);
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}

/**
 * Check if MACD confirms RSI signal
 * For long: MACD should be bullish or bullish_crossover
 * For short: MACD should be bearish or bearish_crossover
 */
function confirmsTrend(macdResult, side) {
  const { crossover, momentum } = macdResult;
  
  if (side === 'long') {
    return crossover === 'bullish_crossover' || 
           crossover === 'bullish' ||
           momentum === 'strong_bullish' ||
           momentum === 'weakening_bearish';
  }
  
  if (side === 'short') {
    return crossover === 'bearish_crossover' || 
           crossover === 'bearish' ||
           momentum === 'strong_bearish' ||
           momentum === 'weakening_bullish';
  }
  
  return false;
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const assetArg = args.find(a => !a.startsWith('--'));
  
  const assets = assetArg 
    ? [assetArg.toUpperCase()] 
    : ['BTC', 'ETH', 'WOO', 'ARB', 'SUI'];

  try {
    const results = await getMultipleMACD(assets);
    
    if (jsonOutput) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log('\n📈 MACD Analysis (12, 26, 9)');
      console.log('═'.repeat(70));
      console.log(`📅 ${new Date().toISOString()}`);
      console.log('─'.repeat(70));
      console.log('Asset   MACD       Signal     Histogram  Crossover        Momentum');
      console.log('─'.repeat(70));
      
      for (const r of results) {
        if (r.error) {
          console.log(`${r.asset.padEnd(7)} ❌ Error: ${r.error}`);
        } else {
          const crossEmoji = r.crossover.includes('bullish') ? '🟢' : '🔴';
          const momEmoji = r.momentum.includes('bullish') ? '📈' : 
                          r.momentum.includes('bearish') ? '📉' : '➡️';
          
          console.log(
            `${r.asset.padEnd(7)} ` +
            `${r.macd.toFixed(3).padStart(9)} ` +
            `${r.signal.toFixed(3).padStart(9)} ` +
            `${r.histogram.toFixed(3).padStart(9)}  ` +
            `${crossEmoji} ${r.crossover.padEnd(16)} ` +
            `${momEmoji} ${r.momentum}`
          );
        }
      }
      
      console.log('─'.repeat(70));
      console.log('💡 Bullish crossover = MACD crosses above Signal');
      console.log('💡 Bearish crossover = MACD crosses below Signal');
      console.log('═'.repeat(70));
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

module.exports = { getMACD, getMultipleMACD, calculateMACD, confirmsTrend };

if (require.main === module) {
  main();
}
