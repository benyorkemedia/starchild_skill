#!/usr/bin/env node
/**
 * Structured Logger - Production-grade JSON logging
 * 
 * Features:
 * - JSON lines format (JSONL) for easy parsing
 * - Log levels: DEBUG, INFO, WARN, ERROR
 * - Automatic file rotation by date
 * - Cycle ID tracing for request correlation
 * - Context enrichment (orderId, asset, etc.)
 */

const fs = require('fs');
const path = require('path');

// Log levels
const LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// Configuration
const LOG_DIR = process.env.LOG_DIR || '/root/clawd/trading/logs';
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LEVELS.INFO;
const CONSOLE_OUTPUT = process.env.LOG_CONSOLE !== 'false';

// Global context (cycle_id, etc.)
let globalContext = {};

/**
 * Ensure log directory exists
 */
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Get current log file path (daily rotation)
 */
function getLogFilePath() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(LOG_DIR, `${date}.jsonl`);
}

/**
 * Format a log entry as JSON
 */
function formatEntry(level, action, message, context = {}) {
  return {
    timestamp: new Date().toISOString(),
    level,
    action,
    message,
    ...globalContext,
    ...context,
  };
}

/**
 * Write log entry to file and optionally console
 */
function writeLog(level, action, message, context = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;

  ensureLogDir();
  
  const entry = formatEntry(level, action, message, context);
  const line = JSON.stringify(entry);
  
  // Append to daily log file
  fs.appendFileSync(getLogFilePath(), line + '\n');
  
  // Console output with emoji prefix
  if (CONSOLE_OUTPUT) {
    const emoji = {
      DEBUG: '🔍',
      INFO: 'ℹ️',
      WARN: '⚠️',
      ERROR: '❌',
    }[level] || '📝';
    
    const contextStr = Object.keys(context).length > 0 
      ? ` ${JSON.stringify(context)}` 
      : '';
    console.log(`${emoji} [${level}] ${action}: ${message}${contextStr}`);
  }
  
  return entry;
}

/**
 * Set global context (persists across log calls)
 */
function setContext(ctx) {
  globalContext = { ...globalContext, ...ctx };
}

/**
 * Clear global context
 */
function clearContext() {
  globalContext = {};
}

/**
 * Get current global context
 */
function getContext() {
  return { ...globalContext };
}

/**
 * Create a child logger with additional context
 */
function child(additionalContext) {
  return {
    debug: (action, message, ctx = {}) => 
      writeLog('DEBUG', action, message, { ...additionalContext, ...ctx }),
    info: (action, message, ctx = {}) => 
      writeLog('INFO', action, message, { ...additionalContext, ...ctx }),
    warn: (action, message, ctx = {}) => 
      writeLog('WARN', action, message, { ...additionalContext, ...ctx }),
    error: (action, message, ctx = {}) => 
      writeLog('ERROR', action, message, { ...additionalContext, ...ctx }),
    child: (moreContext) => child({ ...additionalContext, ...moreContext }),
  };
}

// Main logger interface
const logger = {
  debug: (action, message, context = {}) => writeLog('DEBUG', action, message, context),
  info: (action, message, context = {}) => writeLog('INFO', action, message, context),
  warn: (action, message, context = {}) => writeLog('WARN', action, message, context),
  error: (action, message, context = {}) => writeLog('ERROR', action, message, context),
  
  // Context management
  setContext,
  clearContext,
  getContext,
  child,
  
  // Convenience methods for common trading actions
  order: (action, message, orderId, asset, ctx = {}) => 
    writeLog('INFO', action, message, { orderId, asset, ...ctx }),
  
  trade: (action, message, ctx = {}) => 
    writeLog('INFO', action, message, { type: 'trade', ...ctx }),
  
  risk: (action, message, ctx = {}) => 
    writeLog('WARN', action, message, { type: 'risk', ...ctx }),
  
  cycle: (action, message, ctx = {}) => 
    writeLog('INFO', action, message, { type: 'cycle', ...ctx }),
  
  // Read recent logs
  readLogs: (date = null, limit = 100) => {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const logFile = path.join(LOG_DIR, `${targetDate}.jsonl`);
    
    if (!fs.existsSync(logFile)) {
      return [];
    }
    
    const lines = fs.readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    
    return lines.slice(-limit).map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  },
  
  // Get log stats for a date
  getStats: (date = null) => {
    const logs = logger.readLogs(date, 10000);
    const stats = {
      total: logs.length,
      byLevel: { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 },
      byAction: {},
      errors: [],
    };
    
    for (const log of logs) {
      stats.byLevel[log.level] = (stats.byLevel[log.level] || 0) + 1;
      stats.byAction[log.action] = (stats.byAction[log.action] || 0) + 1;
      if (log.level === 'ERROR') {
        stats.errors.push(log);
      }
    }
    
    return stats;
  },
};

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'read':
      const date = args[1];
      const limit = parseInt(args[2]) || 50;
      const logs = logger.readLogs(date, limit);
      console.log(JSON.stringify(logs, null, 2));
      break;
      
    case 'stats':
      const statsDate = args[1];
      const stats = logger.getStats(statsDate);
      console.log(JSON.stringify(stats, null, 2));
      break;
      
    case 'tail':
      // Real-time tail (simplified)
      const tailLogs = logger.readLogs(null, 20);
      tailLogs.forEach(log => {
        console.log(`[${log.timestamp}] ${log.level} ${log.action}: ${log.message}`);
      });
      break;
      
    default:
      console.log(`
Structured Logger CLI

Commands:
  read [date] [limit]   Read logs for a date (default: today, last 50)
  stats [date]          Get log statistics for a date
  tail                  Show recent log entries

Examples:
  node logger.js read 2026-01-28 100
  node logger.js stats
  node logger.js tail
`);
  }
}

module.exports = logger;

if (require.main === module) {
  main();
}
