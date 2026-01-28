# Orderly API Reference

## Authentication

WOOFi Pro uses ed25519 signatures via Orderly Network.

### Request Headers
```
orderly-timestamp: <unix_ms>
orderly-account-id: <account_id>
orderly-key: <public_key>
orderly-signature: <base64_signature>
```

### Signature Format
```
signature = ed25519_sign(timestamp + method + path + body)
```

## Endpoints

Base URL: `https://api-evm.orderly.org`

### Public (no auth)
| Endpoint | Description |
|----------|-------------|
| `GET /v1/public/info` | Symbol info (tick sizes, minimums) |
| `GET /tv/history` | TradingView candles for RSI |

### Private (auth required)
| Endpoint | Description |
|----------|-------------|
| `POST /v1/order` | Place market/limit order |
| `POST /v1/algo/order` | Place SL/TP (algo) order |
| `DELETE /v1/order?order_id=X` | Cancel order |
| `DELETE /v1/orders` | Cancel all orders |
| `GET /v1/orders` | List open orders |
| `GET /v1/algo/orders` | List algo orders |
| `GET /v1/positions` | Get positions |

## Symbol Format

```
PERP_{BASE}_USDC
```

Examples: `PERP_BTC_USDC`, `PERP_PUMP_USDC`

## Order Parameters

### Market Order
```json
{
  "symbol": "PERP_BTC_USDC",
  "order_type": "MARKET",
  "side": "BUY",
  "order_quantity": 0.01,
  "broker_id": "woofi_pro"
}
```

### Algo Order (SL/TP)
```json
{
  "symbol": "PERP_BTC_USDC",
  "algo_type": "STOP",
  "type": "MARKET",
  "side": "SELL",
  "quantity": "0.01",
  "trigger_price": "95000",
  "reduce_only": true,
  "broker_id": "woofi_pro"
}
```

## Common Errors

| Code | Message | Solution |
|------|---------|----------|
| -1104 | Order quantity does not match step size | Round to `base_tick` |
| -1103 | Precision of triggerPrice must meet tick | Round to `quote_tick` |
| -1000 | Order quantity below minimum | Use `base_min` or higher |

## Symbol Info Fields

```json
{
  "symbol": "PERP_PUMP_USDC",
  "base_tick": 10,        // Quantity step
  "base_min": 10,         // Minimum quantity
  "quote_tick": 0.000001, // Price step
  "min_notional": 10      // Minimum order value ($)
}
```
