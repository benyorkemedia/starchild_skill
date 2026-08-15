#!/usr/bin/env node
/**
 * Risk Manager - Position sizing, margin checks, circuit breaker
 * Usage: node risk.js <command> [--json]
 * 
 * Commands:
 *   check          Run all risk checks
 *   margin         Check margin ratio
 *   daily-pnl      Check daily P&L
 *   position-size  Calculate safe position size
 *   status         Show circuit breaker status
 */

const fs = require('fs');
const path = require('path');
const { getPositions, request } = require('./orders.js');
const { getStrategy, getConfig } = require('./config.js');

const STATE_FILE = process.env.RISK_STATE_FILE || 
  path.join(process.cwd(), 'risk-state.json');

/**
 * Load risk state (daily tracking)
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Reset if it's a new day
      const today = new Date().toISOString().split('T')[0];
      if (state.date !== today) {
        return createNewState(today, state.starting_equity);
      }
      return state;
    }
  } catch (e) {}
  return createNewState();
}

/**
 * Create fresh daily state
 */
function createNewState(date = null, equity = null) {
  return {
    date: date || new Date().toISOString().split('T')[0],
    starting_equity: equity,
    realized_pnl: 0,
    trades_today: 0,
    circuit_breaker: false,
    circuit_breaker_reason: null,
    last_check: null,
  };
}

/**
 * Save risk state
 */
function saveState(state) {
  state.last_check = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Get account info (balance, margin)
 */
async function getAccountInfo() {
  const positions = await getPositions();
  if (!positions.success) {
    throw new Error('Failed to fetch account info');
  }
  
  return {
    totalCollateral: positions.data.total_collateral_value,
    freeCollateral: positions.data.free_collateral,
    marginRatio: positions.data.margin_ratio,
    positions: positions.data.rows,
  };
}

/**
 * Check margin ratio
 */
async function checkMarginRatio() {
  const account = await getAccountInfo();
  const minRatio = getConfig("risk.min_margin_ratio", 0.10);
  
  const result = {
    marginRatio: account.marginRatio,
    minRequired: minRatio,
    healthy: account.marginRatio >= minRatio,
    freeCollateral: account.freeCollateral,
  };
  
  if (!result.healthy) {
    result.warning = `Margin ratio ${(account.marginRatio * 100).toFixed(2)}% below minimum ${minRatio * 100}%`;
  }
  
  return result;
}

/**
 * Check daily P&L vs circuit breaker threshold
 */
async function checkDailyPnL() {
  const state = loadState();
  const account = await getAccountInfo();
  
  // Initialize starting equity if not set
  if (!state.starting_equity) {
    state.starting_equity = account.totalCollateral;
    saveState(state);
  }
  
  // Calculate unrealized P&L
  let unrealizedPnl = 0;
  for (const pos of account.positions) {
    unrealizedPnl += pos.unsettled_pnl || 0;
  }
  
  const totalPnl = state.realized_pnl + unrealizedPnl;
  const pnlPct = (totalPnl / state.starting_equity) * 100;
  const maxLossPct = getConfig("risk.max_daily_loss_pct", 10);
  
  const result = {
    startingEquity: state.starting_equity,
    currentEquity: account.totalCollateral,
    realizedPnl: state.realized_pnl,
    unrealizedPnl,
    totalPnl,
    pnlPct: Math.round(pnlPct * 100) / 100,
    maxLossPct: -maxLossPct,
    circuitBreakerTriggered: pnlPct <= -maxLossPct,
  };
  
  // Trigger circuit breaker if daily loss exceeds threshold
  if (result.circuitBreakerTriggered && !state.circuit_breaker) {
    state.circuit_breaker = true;
    state.circuit_breaker_reason = `Daily loss ${pnlPct.toFixed(2)}% exceeds -${maxLossPct}% threshold`;
    saveState(state);
  }
  
  return result;
}

/**
 * Calculate safe position size
 */
async function calculatePositionSize(asset, side, currentPrice) {
  const account = await getAccountInfo();
  const config = getConfig("position", {});
  
  // Use free collateral for sizing
  const availableCapital = account.freeCollateral;
  
  // Position size as % of free collateral
  let positionValue = availableCapital * (config.position_size_pct / 100);
  
  // Apply min/max limits
  positionValue = Math.max(positionValue, config.min_position_usd);
  positionValue = Math.min(positionValue, config.max_position_usd);
  
  // Check if we can afford it
  if (positionValue > availableCapital * 0.9) {
    return {
      canTrade: false,
      reason: `Insufficient free collateral: $${availableCapital.toFixed(2)}`,
    };
  }
  
  // Calculate quantity
  const quantity = positionValue / currentPrice;
  const leverage = config.default_leverage;
  const marginRequired = positionValue / leverage;
  
  return {
    canTrade: true,
    asset,
    side,
    price: currentPrice,
    positionValue: Math.round(positionValue * 100) / 100,
    quantity: Math.round(quantity * 1000000) / 1000000, // 6 decimal places
    leverage,
    marginRequired: Math.round(marginRequired * 100) / 100,
    freeCollateral: account.freeCollateral,
  };
}

/**
 * Check max positions limit
 */
async function checkPositionCount() {
  const account = await getAccountInfo();
  const openPositions = account.positions.filter(p => p.position_qty !== 0);
  const maxPositions = getConfig("position.max_positions", getConfig("risk.max_positions", 8));
  
  return {
    openPositions: openPositions.length,
    maxPositions,
    canOpenMore: openPositions.length < maxPositions,
    positions: openPositions.map(p => ({
      symbol: p.symbol.replace('PERP_', '').replace('_USDC', ''),
      side: p.position_qty > 0 ? 'LONG' : 'SHORT',
      size: Math.abs(p.position_qty),
      pnl: p.unsettled_pnl,
    })),
  };
}

/**
 * Get circuit breaker status
 */
function getCircuitBreakerStatus() {
  const state = loadState();
  return {
    active: state.circuit_breaker,
    reason: state.circuit_breaker_reason,
    date: state.date,
    tradestoday: state.trades_today,
    lastCheck: state.last_check,
  };
}

/**
 * Reset circuit breaker (manual override)
 */
function resetCircuitBreaker() {
  const state = loadState();
  state.circuit_breaker = false;
  state.circuit_breaker_reason = null;
  saveState(state);
  return { success: true, message: 'Circuit breaker reset' };
}

/**
 * Record a trade (for daily tracking)
 */
function recordTrade(pnl = 0) {
  const state = loadState();
  state.realized_pnl += pnl;
  state.trades_today += 1;
  saveState(state);
}

/**
 * Run all risk checks
 */
async function runAllChecks() {
  const [margin, dailyPnl, positions, circuitBreaker] = await Promise.all([
    checkMarginRatio(),
    checkDailyPnL(),
    checkPositionCount(),
    Promise.resolve(getCircuitBreakerStatus()),
  ]);
  
  const canTrade = 
    margin.healthy && 
    !dailyPnl.circuitBreakerTriggered && 
    positions.canOpenMore && 
    !circuitBreaker.active;
  
  const issues = [];
  if (!margin.healthy) issues.push(margin.warning);
  if (dailyPnl.circuitBreakerTriggered) issues.push(`Daily loss limit hit: ${dailyPnl.pnlPct}%`);
  if (!positions.canOpenMore) issues.push(`Max positions reached: ${positions.openPositions}/${positions.maxPositions}`);
  if (circuitBreaker.active) issues.push(`Circuit breaker active: ${circuitBreaker.reason}`);
  
  return {
    timestamp: new Date().toISOString(),
    canTrade,
    issues,
    checks: {
      margin,
      dailyPnl,
      positions,
      circuitBreaker,
    },
  };
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const command = args[0];

  try {
    let result;
    
    switch (command) {
      case 'check':
        result = await runAllChecks();
        break;
      case 'margin':
        result = await checkMarginRatio();
        break;
      case 'daily-pnl':
        result = await checkDailyPnL();
        break;
      case 'positions':
        result = await checkPositionCount();
        break;
      case 'status':
        result = getCircuitBreakerStatus();
        break;
      case 'reset':
        result = resetCircuitBreaker();
        break;
      case 'position-size':
        const asset = args[1] || 'BTC';
        const side = args[2] || 'buy';
        const price = parseFloat(args[3]) || 100000;
        result = await calculatePositionSize(asset, side, price);
        break;
      default:
        console.log(`
Risk Manager - Position sizing and circuit breaker

Commands:
  check          Run all risk checks (recommended before trading)
  margin         Check margin ratio only
  daily-pnl      Check daily P&L vs circuit breaker
  positions      Check position count vs limit
  status         Show circuit breaker status
  reset          Reset circuit breaker (manual override)
  position-size  Calculate position size: node risk.js position-size BTC buy 50000

Options:
  --json         Output as JSON
`);
        process.exit(0);
    }
    
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // Pretty print
      if (result.canTrade !== undefined) {
        console.log('\n📊 Risk Check Summary');
        console.log('─'.repeat(50));
        console.log(`Can Trade: ${result.canTrade ? '✅ YES' : '❌ NO'}`);
        if (result.issues.length > 0) {
          console.log('\n⚠️  Issues:');
          result.issues.forEach(i => console.log(`   • ${i}`));
        }
        console.log('\nDetails:');
        console.log(`   Margin Ratio: ${(result.checks.margin.marginRatio * 100).toFixed(2)}% (min: ${result.checks.margin.minRequired * 100}%)`);
        console.log(`   Daily P&L: ${result.checks.dailyPnl.pnlPct}% (limit: ${result.checks.dailyPnl.maxLossPct}%)`);
        console.log(`   Positions: ${result.checks.positions.openPositions}/${result.checks.positions.maxPositions}`);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Export for use as module
module.exports = {
  checkMarginRatio,
  checkDailyPnL,
  checkPositionCount,
  calculatePositionSize,
  getCircuitBreakerStatus,
  resetCircuitBreaker,
  recordTrade,
  runAllChecks,
  loadState,
  saveState,
};

if (require.main === module) {
  main();
}
