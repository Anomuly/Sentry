// robinhoodFeed.js
//
// Watches Robinhood Chain for new ERC-20 tokens (CASHCAT-style meme
// coins live here).
//
// WHY THIS WAS REWRITTEN — the previous version scanned blocks directly
// via ethers `provider.on('block')` and it fundamentally could not work:
//   - Robinhood Chain produces a block every ~100ms. ethers' HTTP
//     provider polls roughly every 4 seconds, so it saw about 1 block
//     in 40 and silently missed ~97% of all activity.
//   - For every contract-creation tx it found, it made a getReceipt
//     call plus two contract calls (name/symbol) — against a public
//     RPC that is explicitly rate-limited and "not recommended for
//     production". Under any real launch volume it would be throttled
//     into uselessness.
// That's why no Robinhood tokens ever appeared in the dashboard.
//
// This version polls Robinhood Chain's Blockscout explorer API, which
// already indexes every token on the chain and returns them in one
// request. Blockscout is the official explorer for the chain (linked
// from Robinhood's own docs), the API is free and needs no key, and
// one HTTP call replaces thousands of RPC calls.

import { EventEmitter } from 'events';

const BLOCKSCOUT_BASE = 'https://robinhoodchain.blockscout.com';
const POLL_INTERVAL_MS = 20_000;

export class RobinhoodFeed extends EventEmitter {
  constructor() {
    super();
    this.seen = new Set();
    this.firstRun = true;
    this._poll();
    setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  async _poll() {
    try {
      const res = await fetch(`${BLOCKSCOUT_BASE}/api/v2/tokens?type=ERC-20`, {
        headers: { 'accept': 'application/json' },
      });
      if (!res.ok) throw new Error(`Blockscout returned ${res.status}`);

      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];

      for (const item of items) {
        const address = item.address || item.address_hash;
        if (!address || this.seen.has(address)) continue;
        this.seen.add(address);

        this.emit('tokenCreated', {
          address,
          creator: null, // Blockscout's token list doesn't include the deployer
          name: item.name || null,
          symbol: item.symbol || null,
          createdAt: Date.now(),
          chain: 'robinhood',
          holders: item.holders ? Number(item.holders) : null,
          totalSupply: item.total_supply || null,
          iconUrl: item.icon_url || null,
          // Blockscout surfaces a fiat market cap for tokens it has
          // price data on. Frequently null for brand-new meme coins.
          marketCapUsd: item.circulating_market_cap ? Number(item.circulating_market_cap) : null,
        });
      }

      if (this.firstRun) {
        this.firstRun = false;
        console.log(`[robinhoodFeed] connected — seeded ${items.length} existing tokens from Blockscout`);
      }
      this.emit('status', 'connected');
    } catch (err) {
      console.error('[robinhoodFeed] poll failed:', err.message);
      this.emit('status', 'disconnected');
    }
  }

  // On-demand lookup for /api/lookup, using the same explorer API.
  async probeAddress(address) {
    try {
      const res = await fetch(`${BLOCKSCOUT_BASE}/api/v2/tokens/${address}`, {
        headers: { 'accept': 'application/json' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || (!data.name && !data.symbol)) return null;
      return {
        name: data.name || null,
        symbol: data.symbol || null,
        holders: data.holders ? Number(data.holders) : null,
        totalSupply: data.total_supply || null,
      };
    } catch {
      return null;
    }
  }
}
