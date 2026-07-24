// pumpFeed.js
//
// Connects to Pump.fun's data feed via PumpPortal — the platform's
// official free WebSocket relay (wss://pumpportal.fun/api/data).
//
// IMPORTANT — read this before changing anything below:
//   - `subscribeNewToken` (token creation events) is free, no API key,
//     no rate limit. This is what powers everything in Sentry today.
//   - `subscribeTokenTrade` (live buy/sell events, needed for ongoing
//     price/market-cap updates and the bundle/dump-detection flags) is
//     metered and requires a PumpPortal API key tied to a wallet funded
//     with at least 0.02 SOL. It is NOT free. Earlier versions of this
//     file called subscribeTokenTrade with no key and no target tokens —
//     that silently returned nothing, which is why market cap and the
//     trade-based flags never actually populated. This version is
//     honest about that instead of pretending it works.
//
// What you get for free, right now, per token:
//   - name, symbol, mint address, creator wallet
//   - the creator's initial buy amount and the resulting starting
//     market cap (`marketCapSol` on the create event) — Pump.fun
//     computes and includes this at creation time, no trade
//     subscription needed. This is what Sentry uses for the market
//     cap shown on each card.
//
// What requires the paid key (set PUMPPORTAL_API_KEY to enable):
//   - live price/market-cap updates *after* creation
//   - the bundle/sniper and buy-and-dump flags in riskEngine.js, which
//     both depend on watching trades after launch

import WebSocket from 'ws';
import { EventEmitter } from 'events';

const API_KEY = process.env.PUMPPORTAL_API_KEY || null;
const FEED_URL = API_KEY
  ? `wss://pumpportal.fun/api/data?api-key=${API_KEY}`
  : 'wss://pumpportal.fun/api/data';
const RECONNECT_DELAY_MS = 3000;

// If a paid key is present, only bother subscribing to trades for
// tokens created in the last few minutes — watching everything forever
// would burn through the metered quota fast for no benefit (nobody
// cares about live price on a token from six hours ago in this feed).
const TRADE_WATCH_WINDOW_MS = 5 * 60 * 1000;

export class PumpFeed extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this._connect();
  }

  _connect() {
    this.ws = new WebSocket(FEED_URL);

    this.ws.on('open', () => {
      console.log('[pumpFeed] connected — subscribing to new token events');
      this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      if (API_KEY) {
        console.log('[pumpFeed] PUMPPORTAL_API_KEY set — will also subscribe to per-token trades for recently created tokens');
      } else {
        console.log('[pumpFeed] no PUMPPORTAL_API_KEY set — running free tier: creation events + initial market cap only, no live trade updates');
      }
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
    if (msg.txType === 'create') {
      const createdAt = Date.now();
      this.emit('tokenCreated', {
        mint: msg.mint,
        creator: msg.traderPublicKey || msg.creator,
        name: msg.name,
        symbol: msg.symbol,
        uri: msg.uri,
        createdAt,
        // Free, included on the creation event itself — no paid
        // subscription needed for this one data point.
        marketCapSol: typeof msg.marketCapSol === 'number' ? msg.marketCapSol : null,
        initialBuySol: typeof msg.solAmount === 'number' ? msg.solAmount : null,
      });

      // Optional paid tier: watch this token's live trades for a
      // limited window right after launch.
      if (API_KEY && msg.mint) {
        this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [msg.mint] }));
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [msg.mint] }));
          }
        }, TRADE_WATCH_WINDOW_MS);
      }
    } else if (msg.txType === 'buy' || msg.txType === 'sell') {
      this.emit('trade', {
        mint: msg.mint,
        trader: msg.traderPublicKey,
        side: msg.txType,
        solAmount: msg.solAmount,
        tokenAmount: msg.tokenAmount,
        marketCapSol: typeof msg.marketCapSol === 'number' ? msg.marketCapSol : null,
        timestamp: Date.now(),
      });
    }
  }
}
