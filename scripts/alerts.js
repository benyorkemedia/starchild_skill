#!/usr/bin/env node
/**
 * Alerting System - Production monitoring and notifications
 * 
 * Alert Conditions:
 * - Cycle failure (any unhandled error in daily-cycle)
 * - Order rejection (API returns error)
 * - Margin < 10% (low margin warning)
 * - Position mismatch (expected vs actual)
 * 
 * Output:
 * - Write to /root/clawd/trading/alerts/pending.json
 * - TODO: Telegram integration via message tool
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

// Directories
const ALERTS_DIR = process.env.ALERTS_DIR || '/root/clawd/trading/alerts';
const PENDING_FILE = path.join(ALERTS_DIR, 'pending.json');
const HISTORY_FILE = path.join(ALERTS_DIR, 'history.jsonl');
const URGENT_FILE = path.join(ALERTS_DIR, 'urgent.json'); // For Starclawd to deliver

// Alert severity levels
const SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

// Alert types
const ALERT_TYPE = {
  CYCLE_FAILURE: 'cycle_failure',
  ORDER_REJECTION: 'order_rejection',
  LOW_MARGIN: 'low_margin',
  POSITION_MISMATCH: 'position_mismatch',
  CIRCUIT_BREAKER: 'circuit_breaker',
  API_ERROR: 'api_error',
  CUSTOM: 'custom',
};

/**
 * Ensure alerts directory exists
 */
function ensureAlertsDir() {
  if (!fs.existsSync(ALERTS_DIR)) {
    fs.mkdirSync(ALERTS_DIR, { recursive: true });
  }
}

/**
 * Load pending alerts
 */
function loadPendingAlerts() {
  ensureAlertsDir();
  if (fs.existsSync(PENDING_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Save pending alerts
 */
function savePendingAlerts(alerts) {
  ensureAlertsDir();
  fs.writeFileSync(PENDING_FILE, JSON.stringify(alerts, null, 2));
}

/**
 * Append to alert history
 */
function appendToHistory(alert) {
  ensureAlertsDir();
  const line = JSON.stringify({ ...alert, archived_at: new Date().toISOString() }) + '\n';
  fs.appendFileSync(HISTORY_FILE, line);
}

/**
 * Create a new alert
 */
function createAlert(type, message, details = {}, severity = SEVERITY.WARNING) {
  const alert = {
    id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type,
    severity,
    message,
    details,
    created_at: new Date().toISOString(),
    acknowledged: false,
    cycle_id: logger.getContext().cycle_id || null,
  };
  
  // Log the alert
  logger.error('ALERT_CREATED', message, { 
    alert_type: type, 
    severity, 
    alert_id: alert.id,
    ...details 
  });
  
  // Add to pending
  const pending = loadPendingAlerts();
  pending.push(alert);
  savePendingAlerts(pending);
  
  // Queue critical/warning alerts for Starclawd to deliver via Telegram
  if (severity === SEVERITY.CRITICAL || severity === SEVERITY.WARNING) {
    queueUrgentAlert(alert);
  }
  
  return alert;
}

/**
 * Queue alert for Starclawd to deliver (checked during heartbeats)
 */
function queueUrgentAlert(alert) {
  ensureAlertsDir();
  let urgent = [];
  if (fs.existsSync(URGENT_FILE)) {
    try {
      urgent = JSON.parse(fs.readFileSync(URGENT_FILE, 'utf8'));
    } catch { urgent = []; }
  }
  urgent.push({
    ...alert,
    queued_at: new Date().toISOString(),
  });
  fs.writeFileSync(URGENT_FILE, JSON.stringify(urgent, null, 2));
}

/**
 * Get urgent alerts (for Starclawd heartbeat check)
 */
function getUrgentAlerts() {
  if (!fs.existsSync(URGENT_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(URGENT_FILE, 'utf8'));
  } catch { return []; }
}

/**
 * Clear urgent alerts after delivery
 */
function clearUrgentAlerts() {
  if (fs.existsSync(URGENT_FILE)) {
    fs.unlinkSync(URGENT_FILE);
  }
}

/**
 * Alert helper functions for specific conditions
 */
const alerts = {
  // Cycle failure (critical - stops trading)
  cycleFailure: (error, context = {}) => {
    return createAlert(
      ALERT_TYPE.CYCLE_FAILURE,
      `Trading cycle failed: ${error.message || error}`,
      { error: error.stack || String(error), ...context },
      SEVERITY.CRITICAL
    );
  },
  
  // Order rejection (warning - specific order failed)
  orderRejection: (asset, side, reason, orderDetails = {}) => {
    return createAlert(
      ALERT_TYPE.ORDER_REJECTION,
      `Order rejected: ${side} ${asset} - ${reason}`,
      { asset, side, reason, ...orderDetails },
      SEVERITY.WARNING
    );
  },
  
  // Low margin (critical - risk of liquidation)
  lowMargin: (marginRatio, threshold = 0.10) => {
    const pct = (marginRatio * 100).toFixed(2);
    const threshPct = (threshold * 100).toFixed(0);
    return createAlert(
      ALERT_TYPE.LOW_MARGIN,
      `⚠️ Margin critically low: ${pct}% (threshold: ${threshPct}%)`,
      { margin_ratio: marginRatio, threshold },
      SEVERITY.CRITICAL
    );
  },
  
  // Position mismatch (warning - discrepancy detected)
  positionMismatch: (asset, expected, actual) => {
    return createAlert(
      ALERT_TYPE.POSITION_MISMATCH,
      `Position mismatch for ${asset}: expected ${expected}, got ${actual}`,
      { asset, expected, actual },
      SEVERITY.WARNING
    );
  },
  
  // Circuit breaker triggered
  circuitBreaker: (reason, dailyPnlPct) => {
    return createAlert(
      ALERT_TYPE.CIRCUIT_BREAKER,
      `🛑 Circuit breaker triggered: ${reason}`,
      { reason, daily_pnl_pct: dailyPnlPct },
      SEVERITY.CRITICAL
    );
  },
  
  // Generic API error
  apiError: (endpoint, error, context = {}) => {
    return createAlert(
      ALERT_TYPE.API_ERROR,
      `API error on ${endpoint}: ${error}`,
      { endpoint, error, ...context },
      SEVERITY.WARNING
    );
  },
  
  // Custom alert
  custom: (message, details = {}, severity = SEVERITY.INFO) => {
    return createAlert(ALERT_TYPE.CUSTOM, message, details, severity);
  },
};

/**
 * Wrapper to catch errors and create alerts
 */
function alertOnError(fn, context = {}) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      alerts.cycleFailure(error, { 
        function: fn.name || 'anonymous',
        args: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)),
        ...context 
      });
      throw error; // Re-throw to preserve normal error handling
    }
  };
}

/**
 * Check conditions and create alerts if needed
 */
async function checkAlertConditions(riskCheck, positions = null) {
  const alertsCreated = [];
  
  // Check margin
  if (riskCheck?.checks?.margin) {
    const { marginRatio, minRequired, healthy } = riskCheck.checks.margin;
    if (!healthy) {
      alertsCreated.push(alerts.lowMargin(marginRatio, minRequired));
    }
  }
  
  // Check circuit breaker
  if (riskCheck?.checks?.circuitBreaker?.active) {
    alertsCreated.push(alerts.circuitBreaker(
      riskCheck.checks.circuitBreaker.reason,
      riskCheck.checks?.dailyPnl?.pnlPct
    ));
  }
  
  return alertsCreated;
}

/**
 * Acknowledge an alert (mark as handled)
 */
function acknowledgeAlert(alertId) {
  const pending = loadPendingAlerts();
  const index = pending.findIndex(a => a.id === alertId);
  
  if (index === -1) {
    return { success: false, error: 'Alert not found' };
  }
  
  const alert = pending[index];
  alert.acknowledged = true;
  alert.acknowledged_at = new Date().toISOString();
  
  // Move to history
  appendToHistory(alert);
  pending.splice(index, 1);
  savePendingAlerts(pending);
  
  return { success: true, alert };
}

/**
 * Clear all acknowledged alerts
 */
function clearAcknowledged() {
  const pending = loadPendingAlerts();
  const remaining = pending.filter(a => !a.acknowledged);
  
  // Archive acknowledged
  pending.filter(a => a.acknowledged).forEach(appendToHistory);
  
  savePendingAlerts(remaining);
  return { cleared: pending.length - remaining.length, remaining: remaining.length };
}

/**
 * Get pending alerts summary
 */
function getSummary() {
  const pending = loadPendingAlerts();
  return {
    total: pending.length,
    critical: pending.filter(a => a.severity === SEVERITY.CRITICAL).length,
    warnings: pending.filter(a => a.severity === SEVERITY.WARNING).length,
    byType: pending.reduce((acc, a) => {
      acc[a.type] = (acc[a.type] || 0) + 1;
      return acc;
    }, {}),
    oldest: pending[0]?.created_at || null,
    newest: pending[pending.length - 1]?.created_at || null,
  };
}

/**
 * Format alert for Telegram (when integration is ready)
 */
function formatForTelegram(alert) {
  const emoji = {
    [SEVERITY.INFO]: 'ℹ️',
    [SEVERITY.WARNING]: '⚠️',
    [SEVERITY.CRITICAL]: '🚨',
  }[alert.severity] || '📢';
  
  return `${emoji} **${alert.type.replace(/_/g, ' ').toUpperCase()}**\n\n${alert.message}\n\n` +
    `Time: ${alert.created_at}\n` +
    (alert.cycle_id ? `Cycle: ${alert.cycle_id.slice(0, 8)}...\n` : '') +
    (Object.keys(alert.details).length > 0 ? `Details: ${JSON.stringify(alert.details, null, 2)}` : '');
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'list':
      const pending = loadPendingAlerts();
      if (pending.length === 0) {
        console.log('No pending alerts ✓');
      } else {
        console.log(`\n📢 Pending Alerts (${pending.length}):\n`);
        pending.forEach((a, i) => {
          const emoji = a.severity === 'critical' ? '🚨' : '⚠️';
          console.log(`${i + 1}. ${emoji} [${a.type}] ${a.message}`);
          console.log(`   ID: ${a.id} | ${a.created_at}\n`);
        });
      }
      break;
      
    case 'summary':
      const summary = getSummary();
      console.log(JSON.stringify(summary, null, 2));
      break;
      
    case 'ack':
      const alertId = args[1];
      if (!alertId) {
        console.log('Usage: node alerts.js ack <alert-id>');
        process.exit(1);
      }
      const ackResult = acknowledgeAlert(alertId);
      console.log(JSON.stringify(ackResult, null, 2));
      break;
      
    case 'clear':
      const clearResult = clearAcknowledged();
      console.log(`Cleared ${clearResult.cleared} alerts, ${clearResult.remaining} remaining`);
      break;
      
    case 'test':
      // Create a test alert
      const testAlert = alerts.custom('Test alert from CLI', { test: true }, SEVERITY.INFO);
      console.log('Created test alert:', testAlert.id);
      break;
      
    default:
      console.log(`
Alerting System CLI

Commands:
  list              Show all pending alerts
  summary           Get alert statistics
  ack <id>          Acknowledge an alert
  clear             Clear all acknowledged alerts
  test              Create a test alert

Examples:
  node alerts.js list
  node alerts.js ack alert-1234567890-abc123
`);
  }
}

module.exports = {
  // Alert creators
  ...alerts,
  createAlert,
  
  // Alert management
  loadPendingAlerts,
  acknowledgeAlert,
  clearAcknowledged,
  getSummary,
  
  // Urgent alerts (for Starclawd delivery)
  getUrgentAlerts,
  clearUrgentAlerts,
  queueUrgentAlert,
  
  // Utilities
  alertOnError,
  checkAlertConditions,
  formatForTelegram,
  
  // Constants
  SEVERITY,
  ALERT_TYPE,
};

if (require.main === module) {
  main();
}
