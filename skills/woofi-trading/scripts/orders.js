#!/usr/bin/env node
/**
 * WOOFi Pro Order Manager
 * Usage: node orders.js <command> [options] [--dry-run]
 * 
 * Commands:
 *   place --symbol BTC --side buy --qty 0.01 [--price 50000]
 *   cancel --order-id 12345
 *   cancel-all [--symbol BTC]
 *   list [--symbol BTC]
 *   set-sl-tp --symbol BTC --sl 48000 --tp 55000
 * 
 * Production Features:
 *   - Order state machine (PENDING → SUBMITTED → FILLED/FAILED/TIMEOUT)
 *   - Order tracking and verification
 *   - Persistent state storage
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default;
const { getStrategy, RATE_LIMITS } = require('./config.js');

// Order states
const ORDER_STATE = {
  PENDING: 'PENDING',       // Order created, not yet submitted
  SUBMITTED: 'SUBMITTED',   // Order sent to exchange
  FILLED: 'FILLED',         // Order fully filled
  PARTIAL: 'PARTIAL',       // Order partially filled
  FAILED: 'FAILED',         // Order rejected by exchange
  TIMEOUT: 'TIMEOUT',       // Order verification timed out
  CANCELLED: 'CANCELLED',   // Order was cancelled
};

// Order state file
const ORDER_STATE_FILE = process.env.ORDER_STATE_FILE || 
  '/root/clawd/trading/state/orders.json';

/**
 * Load order state from file
 */
function loadOrderState() {
  try {
    if (fs.existsSync(ORDER_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(ORDER_STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[WARN] Failed to load order state:', e.message);
  }
  return { orders: {}, lastUpdate: null };
}

/**
 * Save order state to file
 */
function saveOrderState(state) {
  try {
    const dir = path.dirname(ORDER_STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    state.lastUpdate = new Date().toISOString();
    fs.writeFileSync(ORDER_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[ERROR] Failed to save order state:', e.message);
  }
}

/**
 * Track a new order in state
 */
function trackOrder(clientOrderId, orderDetails) {
  const state = loadOrderState();
  state.orders[clientOrderId] = {
    clientOrderId,
    state: ORDER_STATE.PENDING,
    ...orderDetails,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [{ state: ORDER_STATE.PENDING, timestamp: new Date().toISOString() }],
  };
  saveOrderState(state);
  return state.orders[clientOrderId];
}

/**
 * Update order state
 */
function updateOrderState(clientOrderId, newState, details = {}) {
  const state = loadOrderState();
  if (state.orders[clientOrderId]) {
    state.orders[clientOrderId].state = newState;
    state.orders[clientOrderId].updatedAt = new Date().toISOString();
    state.orders[clientOrderId] = { ...state.orders[clientOrderId], ...details };
    state.orders[clientOrderId].history.push({ 
      state: newState, 
      timestamp: new Date().toISOString(),
      ...details 
    });
    saveOrderState(state);
  }
  return state.orders[clientOrderId];
}

/**
 * Get order by client order ID
 */
function getTrackedOrder(clientOrderId) {
  const state = loadOrderState();
  return state.orders[clientOrderId] || null;
}

/**
 * Clean up old orders (older than 7 days)
 */
function cleanupOldOrders() {
  const state = loadOrderState();
  const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  let cleaned = 0;
  
  for (const [id, order] of Object.entries(state.orders)) {
    if (new Date(order.createdAt).getTime() < cutoff) {
      delete state.orders[id];
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    saveOrderState(state);
    console.log(`[INFO] Cleaned up ${cleaned} old orders`);
  }
  return cleaned;
}

// Load credentials
const creds = JSON.parse(fs.readFileSync(
  process.env.WOOFI_CREDS || '/root/clawd/secrets/woofi.json', 'utf8'
));

const API_KEY = creds.key;
const SECRET_KEY = creds.secret_key.replace('ed25519:', '');
const ACCOUNT_ID = creds.account_id;

const secretKeyBytes = bs58.decode(SECRET_KEY);
const keyPair = nacl.sign.keyPair.fromSeed(secretKeyBytes.slice(0, 32));

// State - use getter for lazy loading
let _dryRunOverride = null;

function isDryRun() {
  if (_dryRunOverride !== null) return _dryRunOverride;
  return getStrategy().flags?.dry_run ?? true;
}

/**
 * Sign a message with ed25519
 */
function sign(message) {
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, keyPair.secretKey);
  return Buffer.from(signature).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Make authenticated API request
 */
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const signatureContent = body 
      ? timestamp + method + path + bodyStr
      : timestamp + method + path;
    const signature = sign(signatureContent);
    
    const req = https.request({
      hostname: 'api-evm.orderly.org',
      port: 443,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'orderly-timestamp': timestamp,
        'orderly-account-id': ACCOUNT_ID,
        'orderly-key': API_KEY,
        'orderly-signature': signature,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ success: false, error: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

/**
 * Convert asset to WOOFi symbol format
 */
function toSymbol(asset) {
  asset = asset.toUpperCase();
  if (asset.startsWith('PERP_')) return asset;
  return `PERP_${asset}_USDC`;
}

// Cache for symbol info with TTL (1 hour)
const SYMBOL_CACHE_TTL = 3600_000;
let symbolInfoCache = {};
let symbolCacheTimestamps = {};

/**
 * Get full symbol info from Orderly API (cached with TTL)
 */
async function getSymbolInfo(asset) {
  const symbol = toSymbol(asset);
  const now = Date.now();
  
  // Check cache with TTL
  if (symbolInfoCache[symbol] && (now - symbolCacheTimestamps[symbol]) < SYMBOL_CACHE_TTL) {
    return symbolInfoCache[symbol];
  }
  
  return new Promise((resolve) => {
    https.get('https://api-evm.orderly.org/v1/public/info', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          for (const row of info.data?.rows || []) {
            if (row.symbol === symbol) {
              symbolInfoCache[symbol] = {
                base_tick: row.base_tick || 1,
                base_min: row.base_min || 1,
                quote_tick: row.quote_tick || 0.01,
                min_notional: row.min_notional || 10,
                base_imr: row.base_imr || 0.1,
              };
              symbolCacheTimestamps[symbol] = now;
              resolve(symbolInfoCache[symbol]);
              return;
            }
          }
          resolve({ base_tick: 1, base_min: 1, quote_tick: 0.01, min_notional: 10, base_imr: 0.1 });
        } catch (e) {
          resolve({ base_tick: 1, base_min: 1, quote_tick: 0.01, min_notional: 10, base_imr: 0.1 });
        }
      });
    }).on('error', () => resolve({ base_tick: 1, base_min: 1, quote_tick: 0.01, min_notional: 10, base_imr: 0.1 }));
  });
}

/**
 * Get step size for an asset (wrapper for backward compatibility)
 */
async function getStepSize(asset) {
  const info = await getSymbolInfo(asset);
  return info.base_tick;
}

/**
 * Round quantity to match step size (rounds DOWN to nearest step)
 */
function roundToStepSize(quantity, stepSize) {
  return Math.floor(quantity / stepSize) * stepSize;
}

/**
 * Round price to match quote tick
 */
function roundPrice(price, quoteTick) {
  const precision = Math.max(0, -Math.floor(Math.log10(quoteTick)));
  const factor = Math.pow(10, precision);
  return Math.round(price * factor) / factor;
}

/**
 * Pre-flight validation for order placement
 * Returns { valid: true, ... } or { valid: false, reason: "..." }
 */
async function validateOrder(asset, quantity, price = null) {
  const info = await getSymbolInfo(asset);
  const errors = [];
  
  // Round quantity to step size
  const roundedQty = roundToStepSize(quantity, info.base_tick);
  
  // Check minimum quantity
  if (roundedQty < info.base_min) {
    errors.push(`Qty ${roundedQty} below min ${info.base_min}`);
  }
  
  // Check minimum notional (need price for this)
  if (price) {
    const notional = roundedQty * price;
    if (notional < info.min_notional) {
      errors.push(`Notional $${notional.toFixed(2)} below min $${info.min_notional}`);
    }
  }
  
  if (errors.length > 0) {
    return { valid: false, reason: errors.join('; '), info, roundedQty };
  }
  
  return { valid: true, info, roundedQty };
}

/**
 * Calculate minimum viable quantity for an asset at given price
 */
async function getMinQuantity(asset, price) {
  const info = await getSymbolInfo(asset);
  
  // Calculate qty needed for min notional
  const notionalQty = info.min_notional / price;
  
  // Round up to nearest step size
  const steppedQty = Math.ceil(notionalQty / info.base_tick) * info.base_tick;
  
  // Ensure at least base_min
  return Math.max(steppedQty, info.base_min);
}

/**
 * Get order status by order ID from exchange
 */
async function getOrderStatus(orderId) {
  return request('GET', `/v1/order/${orderId}`);
}

/**
 * Get order status by client order ID from exchange
 */
async function getOrderByClientId(clientOrderId) {
  return request('GET', `/v1/client/order/${clientOrderId}`);
}

/**
 * Verify an order was filled (poll with retries)
 * @param {string} orderId - Exchange order ID or client order ID
 * @param {object} options - { maxRetries: 5, delayMs: 2000, useClientId: false }
 * @returns {object} - { filled: boolean, status: string, details: object }
 */
async function verifyOrderFilled(orderId, options = {}) {
  const maxRetries = options.maxRetries || 5;
  const delayMs = options.delayMs || 2000;
  const useClientId = options.useClientId || false;
  
  console.log(`[DEBUG] Verifying order ${orderId} (max ${maxRetries} retries)...`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = useClientId 
        ? await getOrderByClientId(orderId)
        : await getOrderStatus(orderId);
      
      if (!result.success) {
        console.log(`[WARN] Order status check failed (attempt ${attempt}): ${JSON.stringify(result)}`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        return { 
          filled: false, 
          status: 'UNKNOWN', 
          error: result.message || 'Failed to fetch order',
          attempts: attempt 
        };
      }
      
      const order = result.data;
      const status = order.status;
      
      // Check if filled
      if (status === 'FILLED' || status === 'COMPLETED') {
        console.log(`[INFO] Order ${orderId} FILLED after ${attempt} attempt(s)`);
        return {
          filled: true,
          status: 'FILLED',
          details: {
            orderId: order.order_id,
            clientOrderId: order.client_order_id,
            executedQty: order.executed_quantity || order.executed,
            avgPrice: order.average_executed_price || order.avg_price,
            fee: order.fee,
          },
          attempts: attempt,
        };
      }
      
      // Check if partially filled
      if (status === 'PARTIAL_FILLED') {
        console.log(`[INFO] Order ${orderId} partially filled (attempt ${attempt})`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        return {
          filled: false,
          status: 'PARTIAL',
          details: {
            orderId: order.order_id,
            executedQty: order.executed_quantity || order.executed,
            remainingQty: order.remaining_quantity || order.remaining,
          },
          attempts: attempt,
        };
      }
      
      // Check if failed/rejected
      if (status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED') {
        console.log(`[ERROR] Order ${orderId} ${status}`);
        return {
          filled: false,
          status: status,
          error: order.reason || `Order ${status.toLowerCase()}`,
          attempts: attempt,
        };
      }
      
      // Still pending, wait and retry
      if (status === 'NEW' || status === 'PENDING' || status === 'INCOMPLETE') {
        console.log(`[DEBUG] Order ${orderId} status: ${status} (attempt ${attempt}/${maxRetries})`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
      }
      
    } catch (error) {
      console.log(`[ERROR] Order verification failed (attempt ${attempt}): ${error.message}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
    }
  }
  
  return {
    filled: false,
    status: 'TIMEOUT',
    error: `Order verification timed out after ${maxRetries} attempts`,
    attempts: maxRetries,
  };
}

/**
 * Place a market order with state tracking
 */
async function placeMarketOrder(asset, side, quantity, options = {}) {
  // Validate and round quantity
  const validation = await validateOrder(asset, quantity, options.price);
  if (!validation.valid) {
    console.log(`[ERROR] ${asset}: ${validation.reason}`);
    return { success: false, code: -9000, message: validation.reason };
  }
  const roundedQty = validation.roundedQty;
  console.log(`[DEBUG] ${asset}: qty ${quantity} → step ${validation.info.base_tick} → rounded ${roundedQty}`);
  const symbol = toSymbol(asset);
  
  // Generate idempotent client order ID
  const clientOrderId = options.clientOrderId || 
    `${asset}-${side}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  
  const order = {
    symbol,
    client_order_id: clientOrderId,
    order_type: 'MARKET',
    side: side.toUpperCase(),
    order_quantity: roundedQty,
    broker_id: 'woofi_pro',
  };

  if (options.reduceOnly) {
    order.reduce_only = true;
  }

  // Track order in state (PENDING)
  trackOrder(clientOrderId, {
    asset,
    symbol,
    side: side.toUpperCase(),
    quantity: roundedQty,
    orderType: 'MARKET',
    reduceOnly: options.reduceOnly || false,
  });

  if (isDryRun()) {
    console.log(`[DRY-RUN] Would place MARKET ${side.toUpperCase()} ${roundedQty} ${asset}`);
    updateOrderState(clientOrderId, ORDER_STATE.FILLED, { dry_run: true });
    return { success: true, dry_run: true, order, clientOrderId };
  }

  // Submit order (transition to SUBMITTED)
  updateOrderState(clientOrderId, ORDER_STATE.SUBMITTED);
  const result = await request('POST', '/v1/order', order);
  
  if (!result.success) {
    // Order failed
    updateOrderState(clientOrderId, ORDER_STATE.FAILED, { 
      error: result.message || result.code,
      response: result 
    });
    return { ...result, clientOrderId };
  }
  
  const orderId = result.data?.order_id;
  
  // Verify order fill if requested (default: true for production)
  if (options.verify !== false && orderId) {
    const verification = await verifyOrderFilled(orderId, {
      maxRetries: options.verifyRetries || 5,
      delayMs: options.verifyDelay || 2000,
    });
    
    if (verification.filled) {
      updateOrderState(clientOrderId, ORDER_STATE.FILLED, {
        orderId,
        executedQty: verification.details.executedQty,
        avgPrice: verification.details.avgPrice,
        fee: verification.details.fee,
      });
    } else if (verification.status === 'PARTIAL') {
      updateOrderState(clientOrderId, ORDER_STATE.PARTIAL, {
        orderId,
        executedQty: verification.details.executedQty,
        remainingQty: verification.details.remainingQty,
      });
    } else if (verification.status === 'TIMEOUT') {
      updateOrderState(clientOrderId, ORDER_STATE.TIMEOUT, {
        orderId,
        error: verification.error,
      });
    } else {
      updateOrderState(clientOrderId, ORDER_STATE.FAILED, {
        orderId,
        error: verification.error,
        status: verification.status,
      });
    }
    
    result.verification = verification;
  } else {
    // No verification requested, assume submitted
    updateOrderState(clientOrderId, ORDER_STATE.SUBMITTED, { orderId });
  }
  
  return { ...result, clientOrderId };
}

/**
 * Place a limit order
 */
async function placeLimitOrder(asset, side, quantity, price, options = {}) {
  const symbol = toSymbol(asset);
  const order = {
    symbol,
    order_type: 'LIMIT',
    side: side.toUpperCase(),
    order_quantity: quantity,
    order_price: price,
    broker_id: 'woofi_pro',
  };

  if (options.reduceOnly) {
    order.reduce_only = true;
  }
  if (options.postOnly) {
    order.order_type = 'POST_ONLY';
  }

  if (isDryRun()) {
    console.log(`[DRY-RUN] Would place LIMIT ${side.toUpperCase()} ${quantity} ${asset} @ ${price}`);
    return { success: true, dry_run: true, order };
  }

  const result = await request('POST', '/v1/order', order);
  return result;
}

/**
 * Place stop-loss order (algo order)
 */
async function placeStopLoss(asset, side, quantity, triggerPrice) {
  const symbol = toSymbol(asset);
  const order = {
    symbol,
    algo_type: 'STOP',
    type: 'MARKET',
    side: side.toUpperCase(), // Opposite of position
    quantity: quantity.toString(),
    trigger_price: triggerPrice.toString(),
    reduce_only: true,
    broker_id: 'woofi_pro',
  };

  if (isDryRun()) {
    console.log(`[DRY-RUN] Would place STOP_LOSS ${side.toUpperCase()} ${quantity} ${asset} @ trigger ${triggerPrice}`);
    return { success: true, dry_run: true, order };
  }

  const result = await request('POST', '/v1/algo/order', order);
  return result;
}

/**
 * Place take-profit order (algo order)
 */
async function placeTakeProfit(asset, side, quantity, triggerPrice) {
  const symbol = toSymbol(asset);
  const order = {
    symbol,
    algo_type: 'STOP',
    type: 'MARKET',
    side: side.toUpperCase(), // Opposite of position
    quantity: quantity.toString(),
    trigger_price: triggerPrice.toString(),
    reduce_only: true,
    is_take_profit: true,
    broker_id: 'woofi_pro',
  };

  if (isDryRun()) {
    console.log(`[DRY-RUN] Would place TAKE_PROFIT ${side.toUpperCase()} ${quantity} ${asset} @ trigger ${triggerPrice}`);
    return { success: true, dry_run: true, order };
  }

  const result = await request('POST', '/v1/algo/order', order);
  return result;
}

/**
 * Set SL/TP for a position
 */
async function setStopLossTakeProfit(asset, entryPrice, side, quantity, slPct, tpPct) {
  const isLong = side.toLowerCase() === 'buy' || side.toLowerCase() === 'long';
  const closeSide = isLong ? 'SELL' : 'BUY';
  
  // Get symbol info for proper price precision
  const info = await getSymbolInfo(asset);
  
  const slPrice = isLong 
    ? entryPrice * (1 - slPct / 100)
    : entryPrice * (1 + slPct / 100);
  
  const tpPrice = isLong
    ? entryPrice * (1 + tpPct / 100)
    : entryPrice * (1 - tpPct / 100);

  // Round prices to quote_tick precision
  const roundedSL = roundPrice(slPrice, info.quote_tick);
  const roundedTP = roundPrice(tpPrice, info.quote_tick);
  
  console.log(`[DEBUG] ${asset} SL/TP: entry ${entryPrice} → SL ${roundedSL} / TP ${roundedTP} (tick ${info.quote_tick})`);
  
  const stopLoss = await placeStopLoss(asset, closeSide, quantity, roundedSL);
  
  // Rate limit delay between SL and TP orders (5 seconds)
  await new Promise(r => setTimeout(r, 5000));
  
  const takeProfit = await placeTakeProfit(asset, closeSide, quantity, roundedTP);

  return { stopLoss, takeProfit };
}

/**
 * Cancel an order
 */
async function cancelOrder(orderId, symbol) {
  if (isDryRun()) {
    console.log(`[DRY-RUN] Would cancel order ${orderId}`);
    return { success: true, dry_run: true };
  }

  const result = await request('DELETE', `/v1/order?order_id=${orderId}&symbol=${toSymbol(symbol)}`);
  return result;
}

/**
 * Cancel all orders for a symbol (or all)
 */
async function cancelAllOrders(symbol = null) {
  if (isDryRun()) {
    console.log(`[DRY-RUN] Would cancel all orders${symbol ? ` for ${symbol}` : ''}`);
    return { success: true, dry_run: true };
  }

  const path = symbol ? `/v1/orders?symbol=${toSymbol(symbol)}` : '/v1/orders';
  const result = await request('DELETE', path);
  return result;
}

/**
 * Get open orders
 */
async function getOpenOrders(symbol = null) {
  const path = symbol ? `/v1/orders?symbol=${toSymbol(symbol)}&status=INCOMPLETE` : '/v1/orders?status=INCOMPLETE';
  return request('GET', path);
}

/**
 * Get algo orders (SL/TP)
 */
async function getAlgoOrders(symbol = null) {
  const path = symbol ? `/v1/algo/orders?symbol=${toSymbol(symbol)}&status=INCOMPLETE` : '/v1/algo/orders?status=INCOMPLETE';
  return request('GET', path);
}

/**
 * Get positions
 */
async function getPositions() {
  return request('GET', '/v1/positions');
}

/**
 * Close a position
 */
async function closePosition(asset) {
  const positions = await getPositions();
  if (!positions.success) return positions;
  
  const symbol = toSymbol(asset);
  const position = positions.data.rows.find(p => p.symbol === symbol);
  
  if (!position || position.position_qty === 0) {
    return { success: false, error: `No open position for ${asset}` };
  }
  
  const side = position.position_qty > 0 ? 'SELL' : 'BUY';
  const qty = Math.abs(position.position_qty);
  
  return placeMarketOrder(asset, side, qty, { reduceOnly: true });
}

/**
 * Set dry run mode
 */
function setDryRun(enabled) {
  _dryRunOverride = enabled;
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--dry-run')) {
    _dryRunOverride = true;
    console.log('🔒 DRY-RUN MODE ENABLED\n');
  }
  
  if (args.includes('--live')) {
    _dryRunOverride = false;
    console.log('⚠️  LIVE MODE - REAL TRADES\n');
  }
  
  const command = args[0];
  
  const getArg = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : null;
  };

  try {
    let result;
    
    switch (command) {
      case 'place':
        const symbol = getArg('symbol');
        const side = getArg('side');
        const qty = parseFloat(getArg('qty'));
        const price = getArg('price');
        
        if (!symbol || !side || !qty) {
          console.log('Usage: node orders.js place --symbol BTC --side buy --qty 0.01 [--price 50000]');
          process.exit(1);
        }
        
        result = price 
          ? await placeLimitOrder(symbol, side, qty, parseFloat(price))
          : await placeMarketOrder(symbol, side, qty);
        break;
        
      case 'cancel':
        const orderId = getArg('order-id');
        const cancelSymbol = getArg('symbol');
        if (!orderId || !cancelSymbol) {
          console.log('Usage: node orders.js cancel --order-id 12345 --symbol BTC');
          process.exit(1);
        }
        result = await cancelOrder(orderId, cancelSymbol);
        break;
        
      case 'cancel-all':
        result = await cancelAllOrders(getArg('symbol'));
        break;
        
      case 'list':
        result = await getOpenOrders(getArg('symbol'));
        break;
        
      case 'algo-orders':
        result = await getAlgoOrders(getArg('symbol'));
        break;
        
      case 'positions':
        result = await getPositions();
        break;
        
      case 'close':
        const closeSymbol = getArg('symbol');
        if (!closeSymbol) {
          console.log('Usage: node orders.js close --symbol BTC');
          process.exit(1);
        }
        result = await closePosition(closeSymbol);
        break;
        
      case 'set-sl-tp':
        const stSymbol = getArg('symbol');
        const entry = parseFloat(getArg('entry'));
        const posSide = getArg('side') || 'buy';
        const posQty = parseFloat(getArg('qty'));
        const sl = parseFloat(getArg('sl') || strategy.risk.stop_loss_pct);
        const tp = parseFloat(getArg('tp') || strategy.risk.take_profit_pct);
        
        if (!stSymbol || !entry || !posQty) {
          console.log('Usage: node orders.js set-sl-tp --symbol BTC --entry 50000 --side buy --qty 0.01 [--sl 5] [--tp 10]');
          process.exit(1);
        }
        result = await setStopLossTakeProfit(stSymbol, entry, posSide, posQty, sl, tp);
        break;
        
      default:
        console.log(`
WOOFi Pro Order Manager

Commands:
  place       Place a market or limit order
  cancel      Cancel a specific order
  cancel-all  Cancel all orders
  list        List open orders
  algo-orders List algo orders (SL/TP)
  positions   List current positions
  close       Close a position
  set-sl-tp   Set stop-loss and take-profit

Options:
  --dry-run   Simulate without executing
  --live      Execute real trades (override strategy.json)

Examples:
  node orders.js place --symbol BTC --side buy --qty 0.01 --dry-run
  node orders.js close --symbol ETH --dry-run
  node orders.js set-sl-tp --symbol BTC --entry 50000 --side buy --qty 0.01 --sl 5 --tp 10
`);
        process.exit(0);
    }
    
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

/**
 * Set account leverage via API
 */
async function setLeverage(leverage) {
  const result = await request('POST', '/v1/client/leverage', { leverage });
  if (result.success) {
    console.log(`✅ Account leverage set to ${leverage}x`);
  }
  return result;
}

/**
 * Get max leverage for a specific instrument based on IMR
 */
async function getInstrumentMaxLeverage(asset) {
  const info = await getSymbolInfo(asset);
  if (!info) return null;
  
  // Max leverage = 1 / IMR (Initial Margin Ratio)
  const imr = info.base_imr || 0.1; // Default 10% = 10x
  return Math.floor(1 / imr);
}

/**
 * Check leverage compatibility with assets
 * Returns { compatible: bool, warnings: [], maxPerAsset: {} }
 */
async function checkLeverageCompatibility(desiredLeverage, assets) {
  const result = {
    compatible: true,
    warnings: [],
    maxPerAsset: {},
  };
  
  for (const asset of assets) {
    const maxLev = await getInstrumentMaxLeverage(asset);
    result.maxPerAsset[asset] = maxLev;
    
    if (maxLev && desiredLeverage > maxLev) {
      result.compatible = false;
      result.warnings.push(`${asset}: max ${maxLev}x (you want ${desiredLeverage}x)`);
    }
  }
  
  return result;
}

// Export for use as module
module.exports = {
  placeMarketOrder,
  placeLimitOrder,
  placeStopLoss,
  placeTakeProfit,
  setStopLossTakeProfit,
  cancelOrder,
  cancelAllOrders,
  getOpenOrders,
  getAlgoOrders,
  getPositions,
  closePosition,
  setDryRun,
  request,
  toSymbol,
  getSymbolInfo,
  validateOrder,
  getMinQuantity,
  roundToStepSize,
  roundPrice,
  // Order state machine exports
  ORDER_STATE,
  getOrderStatus,
  getOrderByClientId,
  verifyOrderFilled,
  trackOrder,
  updateOrderState,
  getTrackedOrder,
  loadOrderState,
  cleanupOldOrders,
  // Leverage functions
  setLeverage,
  getInstrumentMaxLeverage,
  checkLeverageCompatibility,
};

if (require.main === module) {
  main();
}
