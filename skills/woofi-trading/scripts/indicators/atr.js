#!/usr/bin/env node
/**
 * ATR (Average True Range) Calculator
 * Measures volatility for dynamic stop-loss/take-profit sizing
 * Uses Orderly's TradingView-compatible endpoint
 */

const https = require('https');
const { getConfig } = require('../config.js');

// Default ATR settings
const DEFAULT_PERIOD = 14;
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
          // Convert TradingView format to array of { t, o, h, l, c, v }
          const klines = tv.c.map((close, i) => ({
            t: tv.t?.[i] || 0,
            o: parseFloat(tv.o?.[i] || close),
            h: parseFloat(tv.h?.[i] || close),
            l: parseFloat(tv.l?.[i] || close),
            c: parseFloat(close),
            v: parseFloat(tv.v?.[i] || 0)
          }));
          resolve(klines);
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
 * Calculate True Range for a single candle
 * TR = max(High - Low, |High - PrevClose|, |Low - PrevClose|)
 */
function trueRange(high, low, prevClose) {
  return Math.max(
    high - low,
    Math.abs(high - prevClose),
    Math.abs(low - prevClose)
  );
}

/**
 * Calculate ATR from OHLC data
 * Uses Wilder's smoothing method (same as RSI)
 */
function calculateATR(klines, period = 14) {
  if (klines.length < period + 1) {
    throw new Error(`Need at least ${period + 1} candles, got ${klines.length}`);
  }

  // Calculate True Range for each candle (starting from index 1)
  const trValues = [];
  for (let i = 1; i < klines.length; i++) {
    const tr = trueRange(klines[i].h, klines[i].l, klines[i - 1].c);
    trValues.push(tr);
  }

  // Initial ATR: Simple average of first N true ranges
  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trValues[i];
  }
  atr /= period;

  // Apply Wilder's smoothing for remaining values
  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }

  return atr;
}

/**
 * Get ATR for a single asset
 * @param {string} asset - Asset symbol (e.g., 'BTC')
 * @param {number} period - ATR period (default: 14)
 * @param {string} timeframe - Timeframe (default: '1d')
 * @returns {Promise<Object>} ATR data
 */
async function getATR(asset, period = DEFAULT_PERIOD, timeframe = DEFAULT_TIMEFRAME) {
  try {
    const klines = await fetchKlines(asset, timeframe, period + 50);
    
    if (!Array.isArray(klines) || klines.length === 0) {
      return { asset, error: 'No data available', atr: null };
    }
    
    const atr = calculateATR(klines, period);
    const currentPrice = klines[klines.length - 1].c;
    const atrPercent = (atr / currentPrice) * 100;
    
    return {
      asset,
      atr: Math.round(atr * 100) / 100,
      atrPercent: Math.round(atrPercent * 100) / 100,
      price: currentPrice,
      period,
      timeframe,
      // Useful for risk management
      suggestedSL: Math.round(atr * 2 * 100) / 100,  // 2x ATR stop-loss
      suggestedTP: Math.round(atr * 4 * 100) / 100,  // 4x ATR take-profit (2:1 R:R)
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return { asset, error: error.message, atr: null };
  }
}

/**
 * Get ATR for multiple assets
 */
async function getMultipleATR(assets, period = DEFAULT_PERIOD, timeframe = DEFAULT_TIMEFRAME) {
  const results = [];
  
  for (const asset of assets) {
    const result = await getATR(asset, period, timeframe);
    results.push(result);
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}

/**
 * Classify volatility based on ATR percentage
 */
function classifyVolatility(atrPercent) {
  if (atrPercent < 2) return 'low';
  if (atrPercent < 5) return 'moderate';
  if (atrPercent < 10) return 'high';
  return 'extreme';
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
    const results = await getMultipleATR(assets);
    
    if (jsonOutput) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log('\n📊 ATR (Average True Range) Analysis');
      console.log('═'.repeat(60));
      console.log(`📅 ${new Date().toISOString()}`);
      console.log(`⚙️  Period: ${DEFAULT_PERIOD} | Timeframe: ${DEFAULT_TIMEFRAME}`);
      console.log('─'.repeat(60));
      console.log('Asset   Price         ATR          ATR%     Volatility');
      console.log('─'.repeat(60));
      
      for (const r of results) {
        if (r.error) {
          console.log(`${r.asset.padEnd(7)} ❌ Error: ${r.error}`);
        } else {
          const vol = classifyVolatility(r.atrPercent);
          const volEmoji = vol === 'low' ? '🟢' : vol === 'moderate' ? '🟡' : vol === 'high' ? '🟠' : '🔴';
          console.log(
            `${r.asset.padEnd(7)} $${r.price.toFixed(2).padStart(10)} ` +
            `$${r.atr.toFixed(2).padStart(8)}    ${r.atrPercent.toFixed(2).padStart(5)}%   ${volEmoji} ${vol}`
          );
        }
      }
      
      console.log('─'.repeat(60));
      console.log('💡 Use: SL = 2×ATR, TP = 4×ATR for 2:1 reward/risk');
      console.log('═'.repeat(60));
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

module.exports = { getATR, getMultipleATR, calculateATR, classifyVolatility };

if (require.main === module) {
  main();
}
