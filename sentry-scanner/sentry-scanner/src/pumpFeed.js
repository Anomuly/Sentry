// pumpFeed.js
//
// Connects to Pump.fun's free public WebSocket feed. No API key, no rate
// limit, streams new token creation events and trades within ~500-800ms
// of block confirmation. This is the ingestion layer — every other module
// consumes events from here.
//
// Docs / reference: wss://pumpdev.io/ws (community-run free relay).
// For production you'll likely want a paid Geyser/gRPC stream (Helius
// Laserstream, Shyft Yellowstone, Bitquery) for redundancy — relying on a
// single free relay is a single point of failure. Swap this module out,
// the rest of the pipeline (riskEngine, server) doesn't need to change.

import WebSocket from 'ws';
import { EventEmitter } from 'events';

const FEED_URL = 'wss://pumpdev.io/ws';
const RECONNECT_DELAY_MS = 3000;

export class PumpFeed extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this._connect();
  }

  _connect() {
    this.ws = new WebSocket(FEED_URL);

    this.ws.on('open', () => {
      console.log('[pumpFeed] connected — subscribing to new token + trade events');
      this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade' }));
      this.emit('status', 'connected');
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed frames
      }
      this._route(msg);
    });

    this.ws.on('close', () => {
      console.log('[pumpFeed] disconnected — reconnecting in', RECONNECT_DELAY_MS, 'ms');
      this.emit('status', 'disconnected');
      setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
    });

    this.ws.on('error', (err) => {
      console.error('[pumpFeed] error:', err.message);
    });
  }

  _route(msg) {
    // Pump.fun relay event shapes vary by provider; normalize the two we
    // care about into a consistent internal shape.
    if (msg.txType === 'create' || msg.method === 'newToken') {
      this.emit('tokenCreated', {
        mint: msg.mint,
        creator: msg.traderPublicKey || msg.creator,
        name: msg.name,
        symbol: msg.symbol,
        uri: msg.uri,
        createdAt: Date.now(),
      });
    } else if (msg.txType === 'buy' || msg.txType === 'sell') {
      this.emit('trade', {
        mint: msg.mint,
        trader: msg.traderPublicKey,
        side: msg.txType,
        solAmount: msg.solAmount,
        tokenAmount: msg.tokenAmount,
        timestamp: Date.now(),
      });
    }
  }
}
