#!/usr/bin/env node
/**
 * RSI Calculator - Fetches RSI data from Orderly (WOOFi Pro)
 * Uses Orderly's TradingView-compatible endpoint - no Binance dependency!
 */

const https = require('https');
const { getStrategy, getConfig, RATE_LIMITS } = require('./config.js');

// Getters for lazy config loading
const getRsiPeriod = () => getConfig('signals.period', getConfig('rsi.period', 14));
const getTimeframe = () => getConfig('signals.timeframe', getConfig('rsi.timeframe', '1d'));
const getLongThreshold = () => getConfig('signals.long_entry', getConfig('rsi.long_entry', 55));
const getShortThreshold = () => getConfig('signals.short_entry', getConfig('rsi.short_entry', 45));
const getLongAssets = () => getConfig('long_assets', []);
const getShortAssets = () => getConfig('short_assets', []);

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
          // Convert TradingView format to array of [timestamp, o, h, l, close, volume]
          const klines = tv.c.map((close, i) => [
            tv.t?.[i] || 0,
            tv.o?.[i] || close,
            tv.h?.[i] || close,
            tv.l?.[i] || close,
            close,
            tv.v?.[i] || 0
          ]);
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
 * Calculate RSI from closing prices
 */
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) {
    throw new Error(`Need at least ${period + 1} candles, got ${closes.length}`);
  }

  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  let avgGain = 0;
  let avgLoss = 0;
  
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Get RSI for a single asset
 */
async function getAssetRSI(asset) {
  try {
    const klines = await fetchKlines(asset, getTimeframe(), getRsiPeriod() + 50);
    
    if (!Array.isArray(klines) || klines.length === 0) {
      return { asset, error: 'No data available', rsi: null };
    }
    
    const closes = klines.map(k => parseFloat(k[4]));
    const rsi = calculateRSI(closes, getRsiPeriod());
    const currentPrice = closes[closes.length - 1];
    
    return {
      asset,
      rsi: Math.round(rsi * 100) / 100,
      price: currentPrice,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return { asset, error: error.message, rsi: null };
  }
}

/**
 * Classify signal based on Alpha Predator rules
 */
function classifySignal(asset, rsi) {
  if (rsi === null) return 'error';
  
  const isLongAsset = getLongAssets().includes(asset);
  const isShortAsset = getShortAssets().includes(asset);
  
  if (isLongAsset && rsi < getLongThreshold()) {
    return rsi < getConfig("rsi.market_bias_oversold", 35) ? 'strong_long' : 'long';
  }
  
  if (isShortAsset && rsi > getShortThreshold()) {
    return rsi > getConfig("rsi.market_bias_overbought", 65) ? 'strong_short' : 'short';
  }
  
  return 'neutral';
}

/**
 * Get RSI for all strategy assets (with rate limiting)
 */
async function getAllRSI() {
  const allAssets = [...new Set([...getLongAssets(), ...getShortAssets()])];
  const results = [];
  
  // Fetch sequentially with small delay to avoid rate limiting
  for (const asset of allAssets) {
    const r = await getAssetRSI(asset);
    results.push({
      ...r,
      side: getLongAssets().includes(r.asset) ? 'long_candidate' : 'short_candidate',
      signal: classifySignal(r.asset, r.rsi)
    });
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}

/**
 * Get tradeable signals (assets that qualify for entry)
 */
async function getTradeableSignals() {
  const allRSI = await getAllRSI();
  
  const longs = allRSI.filter(r => r.signal === 'long' || r.signal === 'strong_long');
  const shorts = allRSI.filter(r => r.signal === 'short' || r.signal === 'strong_short');
  
  // Get BTC RSI for market bias
  const btcData = allRSI.find(r => r.asset === 'BTC');
  const marketBias = btcData?.rsi < getConfig("rsi.market_bias_oversold", 35) ? 'oversold' :
                     btcData?.rsi > getConfig("rsi.market_bias_overbought", 65) ? 'overbought' : 'neutral';
  
  return {
    timestamp: new Date().toISOString(),
    marketBias,
    btcRsi: btcData?.rsi,
    longs: longs.sort((a, b) => a.rsi - b.rsi),
    shorts: shorts.sort((a, b) => b.rsi - a.rsi),
    neutral: allRSI.filter(r => r.signal === 'neutral'),
    errors: allRSI.filter(r => r.signal === 'error'),
    allData: allRSI,
    summary: {
      total: allRSI.length,
      longSignals: longs.length,
      shortSignals: shorts.length,
      strongSignals: allRSI.filter(r => r.signal.startsWith('strong')).length
    },
    thresholds: {
      longEntry: `RSI < ${getLongThreshold()}`,
      shortEntry: `RSI > ${getShortThreshold()}`
    }
  };
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  try {
    const result = await getTradeableSignals();
    
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n🐺 Alpha Predator RSI Scan');
      console.log('═'.repeat(50));
      console.log(`📅 ${result.timestamp}`);
      console.log(`📊 BTC RSI: ${result.btcRsi?.toFixed(2)} → Market: ${result.marketBias.toUpperCase()}`);
      console.log(`🎯 Thresholds: Long < ${getLongThreshold()} | Short > ${getShortThreshold()}`);
      console.log('─'.repeat(50));
      
      console.log(`\n🟢 LONG Candidates (${getLongAssets().join(', ')}):`);
      for (const asset of getLongAssets()) {
        const data = result.allData.find(r => r.asset === asset);
        if (data) {
          const qualifies = data.rsi < getLongThreshold();
          const emoji = qualifies ? '✅' : '❌';
          console.log(`   ${emoji} ${asset.padEnd(5)} RSI: ${data.rsi?.toFixed(2).padStart(6)} ${qualifies ? '→ SIGNAL' : ''}`);
        }
      }
      
      console.log(`\n🔴 SHORT Candidates (${getShortAssets().join(', ')}):`);
      for (const asset of getShortAssets()) {
        const data = result.allData.find(r => r.asset === asset);
        if (data) {
          const qualifies = data.rsi > getShortThreshold();
          const emoji = qualifies ? '✅' : '❌';
          console.log(`   ${emoji} ${asset.padEnd(5)} RSI: ${data.rsi?.toFixed(2).padStart(6)} ${qualifies ? '→ SIGNAL' : ''}`);
        } else {
          console.log(`   ⚠️ ${asset.padEnd(5)} No data`);
        }
      }
      
      console.log('\n' + '═'.repeat(50));
      console.log(`📈 Signals: ${result.summary.longSignals} longs, ${result.summary.shortSignals} shorts`);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

module.exports = { getAssetRSI, getAllRSI, getTradeableSignals, calculateRSI };

if (require.main === module) {
  main();
}
