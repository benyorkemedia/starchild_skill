#!/usr/bin/env node
/**
 * Centralized Configuration Loader
 * Single source of truth for strategy.json
 */

const fs = require('fs');
const path = require('path');

let _strategy = null;
let _lastLoad = 0;
const CACHE_TTL = 60_000; // 1 minute

// Default config path, can be overridden
let configPath = process.env.STRATEGY_PATH || 
  path.join(process.cwd(), 'strategy.json');

/**
 * Set custom config path
 */
function setConfigPath(newPath) {
  configPath = newPath;
  _strategy = null; // Force reload
}

/**
 * Get strategy config (cached with TTL)
 */
function getStrategy(forceReload = false) {
  const now = Date.now();
  if (!_strategy || forceReload || (now - _lastLoad > CACHE_TTL)) {
    try {
      _strategy = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      _lastLoad = now;
    } catch (err) {
      throw new Error(`Failed to load strategy from ${configPath}: ${err.message}`);
    }
  }
  return _strategy;
}

/**
 * Get specific config value with default
 */
function getConfig(key, defaultValue = null) {
  const strategy = getStrategy();
  const keys = key.split('.');
  let value = strategy;
  
  for (const k of keys) {
    if (value === undefined || value === null) return defaultValue;
    value = value[k];
  }
  
  return value !== undefined ? value : defaultValue;
}

/**
 * Rate limit settings (centralized)
 */
const RATE_LIMITS = {
  ORDER_DELAY_MS: 5000,      // Between orders
  DATA_DELAY_MS: 100,        // Between data fetches
  BATCH_SIZE: 5,             // Concurrent data requests
  BATCH_DELAY_MS: 500,       // Between batches
};

module.exports = {
  getStrategy,
  getConfig,
  setConfigPath,
  RATE_LIMITS,
};
