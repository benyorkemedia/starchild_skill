#!/usr/bin/env node
/**
 * Funding Rate Fetcher
 * Perp-native indicator for crowded trade detection
 * Fetches live funding rates from Orderly API
 */

const https = require('https');
const { getConfig } = require('../config.js');

// Funding rate thresholds
const HIGH_FUNDING_THRESHOLD = 0.0001;  // 0.01% per 8h = ~11% APR
const EXTREME_FUNDING_THRESHOLD = 0.0003;  // 0.03% per 8h = ~33% APR

/**
 * Fetch funding rate from Orderly API
 * Endpoint: /v1/public/funding_rate/:symbol
 */
function fetchFundingRate(symbol) {
  return new Promise((resolve, reject) => {
    const url = `/v1/public/funding_rate/PERP_${symbol}_USDC`;
    
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
          const response = JSON.parse(data);
          if (!response.success) {
            reject(new Error(`Orderly API error: ${JSON.stringify(response)}`));
            return;
          }
          resolve(response.data);
        } catch (e) {
          reject(new Error(`Failed to parse funding response for ${symbol}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch predicted funding rate (next period)
 * Endpoint: /v1/public/funding_rate_history
 */
function fetchFundingHistory(symbol, limit = 24) {
  return new Promise((resolve, reject) => {
    const url = `/v1/public/funding_rate_history?symbol=PERP_${symbol}_USDC&limit=${limit}`;
    
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
          const response = JSON.parse(data);
          if (!response.success) {
            reject(new Error(`Orderly API error: ${JSON.stringify(response)}`));
            return;
          }
          resolve(response.data?.rows || []);
        } catch (e) {
          reject(new Error(`Failed to parse funding history for ${symbol}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Classify funding rate sentiment
 */
function classifyFunding(rate) {
  if (rate > EXTREME_FUNDING_THRESHOLD) return 'extreme_long';
  if (rate > HIGH_FUNDING_THRESHOLD) return 'crowded_long';
  if (rate < -EXTREME_FUNDING_THRESHOLD) return 'extreme_short';
  if (rate < -HIGH_FUNDING_THRESHOLD) return 'crowded_short';
  return 'neutral';
}

/**
 * Get funding rate signal
 * High positive = bearish (fade longs)
 * High negative = bullish (fade shorts)
 */
function getFundingSignal(rate) {
  const sentiment = classifyFunding(rate);
  
  if (sentiment === 'extreme_long' || sentiment === 'crowded_long') {
    return { bias: 'bearish', reason: 'Longs paying shorts - crowded long trade' };
  }
  if (sentiment === 'extreme_short' || sentiment === 'crowded_short') {
    return { bias: 'bullish', reason: 'Shorts paying longs - crowded short trade' };
  }
  return { bias: 'neutral', reason: 'Funding rate within normal range' };
}

/**
 * Calculate annualized funding rate
 * Assuming 8h funding periods (3x per day)
 */
function annualizeFunding(rate) {
  return rate * 3 * 365 * 100;  // Convert to annual percentage
}

/**
 * Get funding rate for a single asset
 * @param {string} asset - Asset symbol (e.g., 'BTC')
 * @returns {Promise<Object>} Funding rate data
 */
async function getFundingRate(asset) {
  try {
    const fundingData = await fetchFundingRate(asset);
    
    const rate = parseFloat(fundingData.last_funding_rate || 0);
    const nextRate = parseFloat(fundingData.est_funding_rate || rate);
    
    const sentiment = classifyFunding(rate);
    const signal = getFundingSignal(rate);
    const annualized = annualizeFunding(rate);
    
    return {
      asset,
      rate: rate,
      ratePercent: (rate * 100).toFixed(4) + '%',
      nextRate: nextRate,
      nextRatePercent: (nextRate * 100).toFixed(4) + '%',
      annualizedPercent: annualized.toFixed(2) + '%',
      sentiment,
      signal: signal.bias,
      signalReason: signal.reason,
      nextFundingTime: fundingData.next_funding_time,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return { asset, error: error.message, rate: null };
  }
}

/**
 * Get funding rate history for an asset
 */
async function getFundingHistory(asset, periods = 24) {
  try {
    const history = await fetchFundingHistory(asset, periods);
    
    if (!history || history.length === 0) {
      return { asset, error: 'No history available', history: [] };
    }
    
    // Calculate average and trend
    const rates = history.map(h => parseFloat(h.funding_rate || 0));
    const avgRate = rates.reduce((sum, r) => sum + r, 0) / rates.length;
    const recentAvg = rates.slice(0, 8).reduce((sum, r) => sum + r, 0) / Math.min(8, rates.length);
    
    return {
      asset,
      avgRate: avgRate,
      avgRatePercent: (avgRate * 100).toFixed(4) + '%',
      recentAvg: recentAvg,
      trend: recentAvg > avgRate ? 'increasing' : recentAvg < avgRate ? 'decreasing' : 'stable',
      history: history.slice(0, 8).map(h => ({
        rate: parseFloat(h.funding_rate || 0),
        timestamp: h.funding_time
      })),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return { asset, error: error.message, history: [] };
  }
}

/**
 * Get funding rates for multiple assets
 */
async function getMultipleFundingRates(assets) {
  const results = [];
  
  for (const asset of assets) {
    const result = await getFundingRate(asset);
    results.push(result);
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}

/**
 * Check if funding confirms trade direction
 * For long: funding should be neutral or negative (not crowded long)
 * For short: funding should be neutral or positive (not crowded short)
 */
function confirmsTrade(fundingResult, side) {
  const { sentiment } = fundingResult;
  
  if (side === 'long') {
    // Don't go long when everyone is long (high positive funding)
    return sentiment !== 'extreme_long' && sentiment !== 'crowded_long';
  }
  
  if (side === 'short') {
    // Don't go short when everyone is short (high negative funding)
    return sentiment !== 'extreme_short' && sentiment !== 'crowded_short';
  }
  
  return true;
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const historyMode = args.includes('--history');
  const assetArg = args.find(a => !a.startsWith('--'));
  
  const assets = assetArg 
    ? [assetArg.toUpperCase()] 
    : ['BTC', 'ETH', 'WOO', 'ARB', 'SUI'];

  try {
    if (historyMode && assetArg) {
      const history = await getFundingHistory(assetArg.toUpperCase());
      if (jsonOutput) {
        console.log(JSON.stringify(history, null, 2));
      } else {
        console.log(`\n📜 Funding History: ${history.asset}`);
        console.log('═'.repeat(50));
        console.log(`Average Rate: ${history.avgRatePercent}`);
        console.log(`Recent (8h avg): ${(history.recentAvg * 100).toFixed(4)}%`);
        console.log(`Trend: ${history.trend}`);
        console.log('─'.repeat(50));
        for (const h of history.history) {
          console.log(`  ${(h.rate * 100).toFixed(4)}%  @  ${new Date(h.timestamp).toISOString()}`);
        }
      }
      return;
    }

    const results = await getMultipleFundingRates(assets);
    
    if (jsonOutput) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log('\n💰 Funding Rate Analysis');
      console.log('═'.repeat(75));
      console.log(`📅 ${new Date().toISOString()}`);
      console.log('─'.repeat(75));
      console.log('Asset   Rate       Next       Annual    Sentiment       Signal');
      console.log('─'.repeat(75));
      
      for (const r of results) {
        if (r.error) {
          console.log(`${r.asset.padEnd(7)} ❌ Error: ${r.error}`);
        } else {
          const sentEmoji = r.sentiment.includes('long') ? '🔴' : 
                           r.sentiment.includes('short') ? '🟢' : '⚪';
          const sigEmoji = r.signal === 'bullish' ? '📈' : 
                          r.signal === 'bearish' ? '📉' : '➡️';
          
          console.log(
            `${r.asset.padEnd(7)} ` +
            `${r.ratePercent.padStart(9)} ` +
            `${r.nextRatePercent.padStart(9)} ` +
            `${r.annualizedPercent.padStart(8)} ` +
            `${sentEmoji} ${r.sentiment.padEnd(14)} ` +
            `${sigEmoji} ${r.signal}`
          );
        }
      }
      
      console.log('─'.repeat(75));
      console.log('💡 Positive funding = Longs pay shorts (crowded long → bearish signal)');
      console.log('💡 Negative funding = Shorts pay longs (crowded short → bullish signal)');
      console.log('═'.repeat(75));
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

module.exports = { getFundingRate, getMultipleFundingRates, getFundingHistory, confirmsTrade, classifyFunding };

if (require.main === module) {
  main();
}
