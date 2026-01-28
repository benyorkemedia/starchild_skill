#!/usr/bin/env node
/**
 * Strategy Runner - Daily Cycle
 * 
 * Orchestrates the complete trading cycle:
 * 1. Fetch RSI signals
 * 2. Run risk checks
 * 3. Close positions that no longer qualify
 * 4. Open new positions based on signals
 * 5. Set SL/TP for all positions
 * 6. Generate summary report
 * 
 * Production Features:
 * - Idempotency guard with lock file
 * - Structured JSON logging
 * - Alert integration for failures
 * - Cycle ID tracing
 * 
 * Usage: node daily-cycle.js [--dry-run] [--live] [--json]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getStrategy, getConfig, RATE_LIMITS } = require('./config.js');
const { getTradeableSignals, getAssetRSI } = require('./rsi.js');
const { 
  placeMarketOrder, 
  closePosition, 
  setStopLossTakeProfit, 
  getPositions,
  cancelAllOrders,
  setDryRun,
  cleanupOldOrders,
  setLeverage,
  checkLeverageCompatibility,
} = require('./orders.js');
const { 
  runAllChecks, 
  calculatePositionSize, 
  recordTrade,
  loadState 
} = require('./risk.js');
const logger = require('./logger.js');
const alerts = require('./alerts.js');

// Rate limit delay between orders (5 seconds)
const ORDER_DELAY_MS = 5000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Lock file configuration
const LOCK_FILE = process.env.CYCLE_LOCK_FILE || '/root/clawd/trading/state/cycle.lock';
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Generate cycle ID for tracing
const CYCLE_ID = crypto.randomUUID();

// State
// DRY_RUN now handled by orders.js via config.js
let REPORT = {
  timestamp: new Date().toISOString(),
  cycle_id: CYCLE_ID,
  mode: 'dry-run',
  signals: null,
  riskCheck: null,
  actions: [],
  closedPositions: [],
  openedPositions: [],
  slTpSet: [],
  errors: [],
  summary: {},
};

/**
 * Acquire lock for cycle execution (idempotency guard)
 * Returns { acquired: boolean, reason?: string }
 */
function acquireLock() {
  const lockDir = path.dirname(LOCK_FILE);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }
  
  // Check if lock exists
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const lockAge = Date.now() - new Date(lockData.timestamp).getTime();
      
      // If lock is recent, abort
      if (lockAge < LOCK_TIMEOUT_MS) {
        const ageMinutes = Math.round(lockAge / 60000);
        return { 
          acquired: false, 
          reason: `Lock held by cycle ${lockData.cycle_id.slice(0, 8)}... (${ageMinutes}m old, PID: ${lockData.pid})`,
          existingLock: lockData,
        };
      }
      
      // Lock is stale, log warning and proceed
      logger.warn('LOCK_STALE', `Overriding stale lock from cycle ${lockData.cycle_id}`, {
        stale_cycle_id: lockData.cycle_id,
        lock_age_ms: lockAge,
      });
    } catch (e) {
      // Corrupt lock file, proceed
      logger.warn('LOCK_CORRUPT', 'Lock file corrupt, overriding', { error: e.message });
    }
  }
  
  // Write lock
  const lockData = {
    timestamp: new Date().toISOString(),
    cycle_id: CYCLE_ID,
    pid: process.pid,
    started_by: process.env.USER || 'unknown',
  };
  
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData, null, 2));
  logger.info('LOCK_ACQUIRED', `Cycle lock acquired`, { cycle_id: CYCLE_ID });
  
  return { acquired: true, lockData };
}

/**
 * Release lock after cycle completion
 */
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      
      // Only release if we own the lock
      if (lockData.cycle_id === CYCLE_ID) {
        fs.unlinkSync(LOCK_FILE);
        logger.info('LOCK_RELEASED', 'Cycle lock released', { cycle_id: CYCLE_ID });
        return true;
      } else {
        logger.warn('LOCK_NOT_OWNED', 'Lock owned by different cycle, not releasing', {
          our_cycle: CYCLE_ID,
          lock_owner: lockData.cycle_id,
        });
        return false;
      }
    }
  } catch (e) {
    logger.error('LOCK_RELEASE_FAILED', `Failed to release lock: ${e.message}`);
  }
  return false;
}

/**
 * Log action to report (now uses structured logger)
 */
function log(message, type = 'info', context = {}) {
  const entry = { time: new Date().toISOString(), type, message };
  REPORT.actions.push(entry);
  
  // Map type to logger level
  const levelMap = {
    'info': 'info',
    'trade': 'info',
    'skip': 'info',
    'error': 'error',
    'warn': 'warn',
  };
  const level = levelMap[type] || 'info';
  
  // Map type to action name
  const actionMap = {
    'info': 'CYCLE_INFO',
    'trade': 'TRADE_ACTION',
    'skip': 'TRADE_SKIP',
    'error': 'CYCLE_ERROR',
    'warn': 'CYCLE_WARN',
  };
  const action = actionMap[type] || 'CYCLE_LOG';
  
  // Log with structured logger
  logger[level](action, message, { trade_type: type, ...context });
  
  // Also console output with emoji for human readability
  const emoji = type === 'error' ? '❌' : type === 'trade' ? '💰' : type === 'skip' ? '⏭️' : 'ℹ️';
  console.log(`${emoji} ${message}`);
}

/**
 * Lite Reconciliation - Log current exchange state, warn on issues
 * No complex state tracking - exchange is source of truth
 */
async function liteReconcile() {
  log('Reconciling with exchange...');
  
  const positions = await getPositions();
  if (!positions.success) {
    log('Failed to fetch positions from exchange', 'error');
    logger.error('RECONCILE_FAILED', 'Could not fetch positions from exchange');
    return;
  }
  
  const active = positions.data.rows.filter(p => p.position_qty !== 0);
  const marginRatio = positions.data.margin_ratio;
  
  // Calculate exposure
  let longExp = 0, shortExp = 0;
  const positionList = [];
  
  for (const p of active) {
    const asset = p.symbol.replace('PERP_', '').replace('_USDC', '');
    const notional = Math.abs(p.position_qty * p.mark_price);
    const side = p.position_qty > 0 ? 'LONG' : 'SHORT';
    positionList.push(`${asset}:${side}`);
    if (p.position_qty > 0) longExp += notional;
    else shortExp += notional;
  }
  
  // Log state
  logger.info('RECONCILE_OK', 'Exchange state snapshot', {
    positions: active.length,
    position_list: positionList,
    margin_ratio: (marginRatio * 100).toFixed(1) + '%',
    long_exposure: '$' + longExp.toFixed(0),
    short_exposure: '$' + shortExp.toFixed(0),
    net_exposure: '$' + (longExp - shortExp).toFixed(0),
  });
  
  console.log(`📋 Exchange: ${active.length} positions | Margin: ${(marginRatio * 100).toFixed(1)}% | Long: $${longExp.toFixed(0)} | Short: $${shortExp.toFixed(0)}`);
  
  // Warnings
  if (marginRatio < 0.10) {
    log(`Low margin warning: ${(marginRatio * 100).toFixed(1)}%`, 'warn');
    logger.warn('LOW_MARGIN', `Margin ratio ${(marginRatio * 100).toFixed(1)}% is below 10%`, { margin_ratio: marginRatio });
    // Trigger urgent alert for Starclawd to deliver
    alerts.lowMargin(marginRatio, { 
      collateral: positions.data.total_collateral_value,
      positions: active.length,
      long_exposure: longExp,
      short_exposure: shortExp,
    });
  }
  
  if (active.length > getConfig('risk.max_positions', 8)) {
    log(`Position count ${active.length} exceeds max ${getConfig('risk.max_positions', 8)}`, 'warn');
  }
  
  // Leverage check and set
  const desiredLeverage = getConfig('position.default_leverage', 10);
  const allAssets = [
    ...(getConfig('long_assets', []) || []),
    ...(getConfig('short_assets', []) || []),
  ];
  
  if (allAssets.length > 0) {
    log(`Checking leverage compatibility (${desiredLeverage}x)...`);
    const levCheck = await checkLeverageCompatibility(desiredLeverage, allAssets.slice(0, 5)); // Check first 5 to avoid rate limits
    
    if (!levCheck.compatible) {
      log(`⚠️ Leverage warnings:`, 'warn');
      levCheck.warnings.forEach(w => console.log(`   ${w}`));
      logger.warn('LEVERAGE_MISMATCH', 'Some assets have lower max leverage than desired', {
        desired: desiredLeverage,
        warnings: levCheck.warnings,
      });
    }
  }
  
  // Set account leverage
  try {
    await setLeverage(desiredLeverage);
    logger.info('LEVERAGE_SET', `Account leverage set to ${desiredLeverage}x`, { leverage: desiredLeverage });
  } catch (e) {
    log(`Failed to set leverage: ${e.message}`, 'warn');
  }
}

/**
 * Step 1: Fetch RSI signals
 */
async function fetchSignals() {
  log('Fetching RSI signals from Binance...');
  const signals = await getTradeableSignals();
  REPORT.signals = signals;
  
  log(`Found ${signals.summary.longSignals} long signals, ${signals.summary.shortSignals} short signals`);
  return signals;
}

/**
 * Step 2: Run risk checks
 */
async function checkRisk() {
  log('Running risk checks...');
  const riskCheck = await runAllChecks();
  REPORT.riskCheck = riskCheck;
  
  if (!riskCheck.canTrade) {
    log(`Risk check failed: ${riskCheck.issues.join(', ')}`, 'error');
  } else {
    log('Risk checks passed ✓');
  }
  
  return riskCheck;
}

/**
 * Step 3: Evaluate existing positions
 */
async function evaluatePositions(signals, positions) {
  log('Evaluating existing positions...');
  
  if (!positions.success) {
    log('Failed to fetch positions', 'error');
    return [];
  }
  
  const toClose = [];
  
  for (const pos of positions.data.rows) {
    if (pos.position_qty === 0) continue;
    
    const asset = pos.symbol.replace('PERP_', '').replace('_USDC', '');
    const isLong = pos.position_qty > 0;
    
    // Use RSI data from signals (already fetched) instead of re-fetching
    const rsiData = signals.allData?.find(r => r.asset === asset);
    
    if (!rsiData || rsiData.error) {
      log(`No RSI data for ${asset}, skipping evaluation`, 'skip');
      continue;
    }
    
    // Check if position should be closed (configurable thresholds)
    // Long position: close if RSI > long_exit (default 55)
    // Short position: close if RSI < short_exit (default 45)
    const longExit = getConfig('rsi.long_exit', getConfig('signals.long_exit', 55));
    const shortExit = getConfig('rsi.short_exit', getConfig('signals.short_exit', 45));
    
    const shouldClose = isLong 
      ? rsiData.rsi > longExit 
      : rsiData.rsi < shortExit;
    
    const exitThreshold = isLong ? longExit : shortExit;
    
    if (shouldClose) {
      toClose.push({
        asset,
        side: isLong ? 'LONG' : 'SHORT',
        quantity: Math.abs(pos.position_qty),
        rsi: rsiData.rsi,
        pnl: pos.unsettled_pnl,
        reason: `RSI ${rsiData.rsi.toFixed(2)} crossed ${exitThreshold} threshold`,
      });
    } else {
      log(`Keeping ${asset} ${isLong ? 'LONG' : 'SHORT'} - RSI ${rsiData.rsi.toFixed(2)}`);
    }
  }
  
  return toClose;
}

/**
 * Step 4: Close positions that no longer qualify
 */
async function closePositions(toClose) {
  for (const pos of toClose) {
    log(`Closing ${pos.asset} ${pos.side}: ${pos.reason}`, 'trade');
    
    const result = await closePosition(pos.asset);
    
    if (result.success || result.dry_run) {
      REPORT.closedPositions.push({
        ...pos,
        result: result.dry_run ? 'DRY_RUN' : 'CLOSED',
      });
      
      if (!result.dry_run) {
        recordTrade(pos.pnl);
      }
    } else {
      log(`Failed to close ${pos.asset}: ${JSON.stringify(result)}`, 'error');
      REPORT.errors.push({ action: 'close', asset: pos.asset, error: result });
    }
  }
}

/**
 * Step 5: Open new positions based on signals
 */
async function openNewPositions(signals, riskCheck, positions) {
  if (!riskCheck.canTrade) {
    log('Skipping new positions - risk check failed', 'skip');
    return;
  }
  
  // Use passed positions (already fetched) instead of re-fetching
  const existingAssets = new Set(
    positions.data?.rows
      ?.filter(p => p.position_qty !== 0)
      .map(p => p.symbol.replace('PERP_', '').replace('_USDC', '')) || []
  );
  
  const openCount = riskCheck.checks.positions.openPositions;
  const maxPositions = getConfig("position.max_positions", getConfig("risk.max_positions", 8));
  let slotsAvailable = maxPositions - openCount;
  
  const excludeListLong = getConfig("excludeSymbols", []) || [];
  
  // Process long signals
  for (const signal of signals.longs) {
    if (slotsAvailable <= 0) {
      log(`Max positions reached, skipping remaining signals`, 'skip');
      break;
    }
    
    if (existingAssets.has(signal.asset)) {
      log(`Already have position in ${signal.asset}`, 'skip');
      continue;
    }
    
    // Check exclusion list (event risk, etc.)
    if (excludeListLong.includes(signal.asset)) {
      const reason = getConfig("excludeReason", {})?.[signal.asset] || 'manually excluded';
      log(`Skipping ${signal.asset}: ${reason}`, 'skip');
      continue;
    }
    
    // Calculate position size
    const sizing = await calculatePositionSize(signal.asset, 'buy', signal.price);
    
    if (!sizing.canTrade) {
      log(`Cannot trade ${signal.asset}: ${sizing.reason}`, 'skip');
      continue;
    }
    
    log(`Opening LONG ${signal.asset}: RSI ${signal.rsi.toFixed(2)}, qty ${sizing.quantity}`, 'trade');
    
    const result = await placeMarketOrder(signal.asset, 'buy', sizing.quantity);
    await sleep(ORDER_DELAY_MS); // Rate limit protection
    
    if (result.success || result.dry_run) {
      REPORT.openedPositions.push({
        asset: signal.asset,
        side: 'LONG',
        rsi: signal.rsi,
        price: signal.price,
        quantity: sizing.quantity,
        value: sizing.positionValue,
        result: result.dry_run ? 'DRY_RUN' : 'OPENED',
      });
      slotsAvailable--;
      existingAssets.add(signal.asset);
      
      // Set SL/TP
      const slTp = await setStopLossTakeProfit(
        signal.asset, 
        signal.price, 
        'buy', 
        sizing.quantity,
        getConfig("risk.stop_loss_pct", 5),
        getConfig("risk.take_profit_pct", 25)
      );
      await sleep(ORDER_DELAY_MS); // Rate limit protection
      REPORT.slTpSet.push({ asset: signal.asset, ...slTp });
    } else {
      log(`Failed to open ${signal.asset}: ${JSON.stringify(result)}`, 'error');
      REPORT.errors.push({ action: 'open', asset: signal.asset, error: result });
    }
  }
  
  // Process short signals (if enabled)
  if (getConfig("flags.allow_shorts", true)) {
    const excludeList = getConfig("excludeSymbols", []) || [];
    
    for (const signal of signals.shorts) {
      if (slotsAvailable <= 0) break;
      
      if (existingAssets.has(signal.asset)) continue;
      
      // Check exclusion list (event risk, etc.)
      if (excludeList.includes(signal.asset)) {
        const reason = getConfig("excludeReason", {})?.[signal.asset] || 'manually excluded';
        log(`Skipping ${signal.asset}: ${reason}`, 'skip');
        continue;
      }
      
      const sizing = await calculatePositionSize(signal.asset, 'sell', signal.price);
      
      if (!sizing.canTrade) {
        log(`Cannot trade ${signal.asset}: ${sizing.reason}`, 'skip');
        continue;
      }
      
      log(`Opening SHORT ${signal.asset}: RSI ${signal.rsi.toFixed(2)}, qty ${sizing.quantity}`, 'trade');
      
      const result = await placeMarketOrder(signal.asset, 'sell', sizing.quantity);
      await sleep(ORDER_DELAY_MS); // Rate limit protection
      
      if (result.success || result.dry_run) {
        REPORT.openedPositions.push({
          asset: signal.asset,
          side: 'SHORT',
          rsi: signal.rsi,
          price: signal.price,
          quantity: sizing.quantity,
          value: sizing.positionValue,
          result: result.dry_run ? 'DRY_RUN' : 'OPENED',
        });
        slotsAvailable--;
        
        const slTp = await setStopLossTakeProfit(
          signal.asset, 
          signal.price, 
          'sell', 
          sizing.quantity,
          getConfig("risk.stop_loss_pct", 5),
          getConfig("risk.take_profit_pct", 25)
        );
        await sleep(ORDER_DELAY_MS); // Rate limit protection
        REPORT.slTpSet.push({ asset: signal.asset, ...slTp });
      } else {
        log(`Failed to open SHORT ${signal.asset}: ${JSON.stringify(result)}`, 'error');
        REPORT.errors.push({ action: 'open', asset: signal.asset, error: result });
      }
    }
  }
}

/**
 * Calculate exposure breakdown from positions
 */
function calculateExposure(positions) {
  if (!positions?.success) return null;
  
  let longExposure = 0;
  let shortExposure = 0;
  
  for (const p of positions.data.rows) {
    if (p.position_qty === 0) continue;
    const notional = Math.abs(p.position_qty * p.mark_price);
    if (p.position_qty > 0) {
      longExposure += notional;
    } else {
      shortExposure += notional;
    }
  }
  
  const netExposure = longExposure - shortExposure;
  const totalExposure = longExposure + shortExposure;
  const netBiasPct = totalExposure > 0 ? ((netExposure / totalExposure) * 100) : 0;
  
  return {
    long: longExposure,
    short: shortExposure,
    net: netExposure,
    total: totalExposure,
    netBiasPct: netBiasPct,
    bias: netBiasPct > 10 ? 'LONG' : netBiasPct < -10 ? 'SHORT' : 'NEUTRAL',
    collateral: positions.data.total_collateral_value,
  };
}

/**
 * Generate summary
 */
function generateSummary() {
  const isDryRun = getConfig("flags.dry_run", true);
  REPORT.summary = {
    mode: isDryRun ? 'DRY_RUN' : 'LIVE',
    signalsFound: {
      long: REPORT.signals?.summary?.longSignals || 0,
      short: REPORT.signals?.summary?.shortSignals || 0,
    },
    positionsClosed: REPORT.closedPositions.length,
    positionsOpened: REPORT.openedPositions.length,
    slTpOrdersSet: REPORT.slTpSet.length,
    errors: REPORT.errors.length,
    riskCheckPassed: REPORT.riskCheck?.canTrade || false,
  };
  
  return REPORT;
}

/**
 * Save report to file
 */
function saveReport(report) {
  const date = new Date().toISOString().split('T')[0];
  const reportDir = '/root/clawd/trading/reports';
  
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  
  const filename = `${reportDir}/${date}-cycle.json`;
  fs.writeFileSync(filename, JSON.stringify(report, null, 2));
  log(`Report saved to ${filename}`);
}

/**
 * Main cycle
 */
async function runCycle() {
  const isDryRun = getConfig("flags.dry_run", true);
  
  // Set up logger context for this cycle
  logger.setContext({ cycle_id: CYCLE_ID, mode: isDryRun ? 'dry-run' : 'live' });
  
  console.log('\n' + '═'.repeat(60));
  console.log('🐺 Strategy Runner - Daily Cycle');
  console.log(`📅 ${new Date().toISOString()}`);
  console.log(`🔑 Cycle ID: ${CYCLE_ID.slice(0, 8)}...`);
  console.log(`🔧 Mode: ${isDryRun ? 'DRY-RUN (no real trades)' : '⚠️  LIVE'}`);
  console.log('═'.repeat(60) + '\n');
  
  REPORT.mode = isDryRun ? 'dry-run' : 'live';
  
  // Acquire idempotency lock
  const lock = acquireLock();
  if (!lock.acquired) {
    logger.warn('CYCLE_BLOCKED', `Cycle blocked by existing lock: ${lock.reason}`, {
      existing_cycle: lock.existingLock?.cycle_id,
    });
    console.log(`\n⚠️  CYCLE ABORTED: ${lock.reason}\n`);
    REPORT.summary = { status: 'BLOCKED', reason: lock.reason };
    return REPORT;
  }
  
  try {
    logger.cycle('CYCLE_START', `Starting trading cycle`, {
      dry_run: isDryRun,
      strategy: getConfig("name", "Unknown"),
    });
    
    // Check if trading is enabled
    if (!getConfig("flags.enabled", true)) {
      log('Trading is disabled in strategy.json', 'skip');
      REPORT.summary = { status: 'DISABLED' };
      releaseLock();
      return REPORT;
    }
    
    // Cleanup old order state
    cleanupOldOrders();
    
    // Step 0: Lite reconciliation - log current state from exchange
    await liteReconcile();
    
    // Step 1: Fetch signals
    const signals = await fetchSignals();
    
    // Step 2: Risk checks (also fetches positions)
    const riskCheck = await checkRisk();
    
    // Check for alert conditions
    await alerts.checkAlertConditions(riskCheck);
    
    // Step 2b: Fetch positions ONCE (reused by evaluate + open)
    const positions = await getPositions();
    
    // Step 3: Evaluate existing positions (pass signals + positions)
    const toClose = await evaluatePositions(signals, positions);
    
    // Step 4: Close positions
    if (toClose.length > 0) {
      await closePositions(toClose);
    } else {
      log('No positions to close');
    }
    
    // Step 5: Open new positions (pass positions to avoid re-fetch)
    await openNewPositions(signals, riskCheck, positions);
    
    // Step 6: Calculate exposure (fetch fresh positions for accurate state)
    const finalPositions = await getPositions();
    const exposure = calculateExposure(finalPositions);
    REPORT.exposure = exposure;
    
    // Generate and save report
    const report = generateSummary();
    saveReport(report);
    
    logger.cycle('CYCLE_COMPLETE', `Cycle completed successfully`, {
      positions_closed: report.summary.positionsClosed,
      positions_opened: report.summary.positionsOpened,
      errors: report.summary.errors,
    });
    
    console.log('\n' + '═'.repeat(60));
    console.log('📊 CYCLE COMPLETE');
    console.log(`   Closed: ${report.summary.positionsClosed} | Opened: ${report.summary.positionsOpened} | Errors: ${report.summary.errors}`);
    if (exposure) {
      console.log(`   🟢 Long: $${exposure.long.toFixed(0)} | 🔴 Short: $${exposure.short.toFixed(0)}`);
      console.log(`   📈 Net: $${exposure.net.toFixed(0)} (${exposure.netBiasPct.toFixed(1)}% ${exposure.bias})`);
    }
    console.log('═'.repeat(60) + '\n');
    
    return report;
    
  } catch (error) {
    log(`Fatal error: ${error.message}`, 'error');
    logger.error('CYCLE_FATAL', `Cycle failed with fatal error`, {
      error: error.message,
      stack: error.stack,
    });
    
    // Create alert for cycle failure
    alerts.cycleFailure(error, { cycle_id: CYCLE_ID });
    
    REPORT.errors.push({ fatal: true, error: error.message, stack: error.stack });
    return generateSummary();
  } finally {
    // Always release lock, even on error
    releaseLock();
    logger.clearContext();
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--dry-run')) {
    setDryRun(true);
  }
  
  if (args.includes('--live')) {
    setDryRun(false);
    console.log('\n⚠️  WARNING: LIVE MODE - Real trades will be executed!\n');
  }
  
  const report = await runCycle();
  
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  }
}

// Export for use as module
module.exports = { runCycle };

if (require.main === module) {
  main();
}
