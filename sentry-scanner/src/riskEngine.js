// riskEngine.js
//
// Turns raw creation/trade events into a live trust score (0-100, higher
// = safer). Signals are split into two tiers:
//
//   TIER 1 — computable right now, free, no extra API key needed.
//   TIER 2 — needs a paid indexer (Helius/Bitquery/Shyft) to trace wallet
//            funding graphs and historical holder distribution. Stubbed
//            with a clear interface so you can plug a real key in later
//            without touching the scoring logic.

const RUG_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const BUNDLE_WINDOW_MS = 15 * 1000; // first 15s after launch = highest bundle risk
const MAX_TRACKED_TOKENS = 2000; // memory cap — without this the token Map grows forever

// Pump.fun tokens are minted with a fixed total supply of 1 billion at
// creation (standard across the platform, both pre- and post-migration).
const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000;

export class RiskEngine {
  constructor() {
    // creator wallet -> [{id, createdAt}]  (serial-rugger detection)
    this.creatorHistory = new Map();
    // id -> { createdAt, creator, trades: [], score, flags: [] }
    this.tokens = new Map();
    // SOL/USD, refreshed periodically by the server — null until first fetch succeeds.
    this.solUsd = null;
  }

  setSolUsdPrice(price) {
    this.solUsd = price;
  }

  _evictOldestIfNeeded() {
    // Map preserves insertion order, so the first key is the oldest —
    // cheap way to cap memory without a separate priority queue.
    while (this.tokens.size > MAX_TRACKED_TOKENS) {
      const oldestKey = this.tokens.keys().next().value;
      this.tokens.delete(oldestKey);
    }
  }

  onTokenCreated(evt) {
    // evt.mint (Solana) or evt.address (EVM chains) — normalize to `id`.
    const id = evt.mint || evt.address;
    const marketCapSol = typeof evt.marketCapSol === 'number' ? evt.marketCapSol : null;
    const record = {
      id,
      chain: evt.chain || 'solana',
      creator: evt.creator,
      name: evt.name,
      symbol: evt.symbol,
      createdAt: evt.createdAt,
      trades: [],
      score: 100,
      flags: [],
      priceSol: marketCapSol !== null ? marketCapSol / PUMPFUN_TOTAL_SUPPLY : null,
      marketCapSol,
      marketCapUsd: marketCapSol !== null && this.solUsd ? marketCapSol * this.solUsd : null,
      marketCapIsInitialOnly: marketCapSol !== null, // true until a real trade updates it
    };
    this.tokens.set(id, record);
    this._evictOldestIfNeeded();

    // --- TIER 1: serial creator check ---
    const history = this.creatorHistory.get(evt.creator) || [];
    const recent = history.filter(t => evt.createdAt - t.createdAt < RUG_HISTORY_WINDOW_MS);
    if (recent.length >= 3) {
      record.flags.push(`Creator has launched ${recent.length + 1} tokens in 24h — serial-launch pattern`);
      record.score -= 35;
    } else if (recent.length >= 1) {
      record.flags.push(`Creator has launched ${recent.length} other token(s) in 24h`);
      record.score -= 12;
    }
    recent.push({ id, createdAt: evt.createdAt });
    this.creatorHistory.set(evt.creator, recent);

    return record;
  }

  onTrade(evt) {
    const id = evt.mint || evt.address;
    const record = this.tokens.get(id);
    if (!record) return null; // trade for a token we didn't see created (backfill gap)

    record.trades.push(evt);
    const ageMs = evt.timestamp - record.createdAt;

    // --- Price / market cap ---
    // Real trade data (only arrives if a paid PumpPortal key is set —
    // see pumpFeed.js). When it does arrive, it's authoritative and
    // replaces the initial creation-time estimate.
    if (record.chain === 'solana') {
      if (typeof evt.marketCapSol === 'number') {
        record.marketCapSol = evt.marketCapSol;
        record.priceSol = evt.marketCapSol / PUMPFUN_TOTAL_SUPPLY;
        record.marketCapIsInitialOnly = false;
      } else if (evt.solAmount > 0 && evt.tokenAmount > 0) {
        record.priceSol = evt.solAmount / evt.tokenAmount;
        record.marketCapSol = record.priceSol * PUMPFUN_TOTAL_SUPPLY;
        record.marketCapIsInitialOnly = false;
      }
      record.marketCapUsd = record.marketCapSol !== null && this.solUsd
        ? record.marketCapSol * this.solUsd
        : null;
    }

    // --- TIER 1: bundle/sniper clustering ---
    // Real bundling requires tracing whether many early-buyer wallets share
    // a funding source (see fetchFundingGraph stub below). As a same-feed
    // proxy: an unusually high number of *distinct* buy transactions in the
    // first BUNDLE_WINDOW_MS is itself a strong tell — organic discovery
    // doesn't move that fast.
    if (evt.side === 'buy' && ageMs < BUNDLE_WINDOW_MS) {
      const earlyBuys = record.trades.filter(
        t => t.side === 'buy' && t.timestamp - record.createdAt < BUNDLE_WINDOW_MS
      );
      if (earlyBuys.length === 12) { // fire once, at threshold crossing
        record.flags.push(`${earlyBuys.length} buys within 15s of launch — likely bundled/sniped`);
        record.score -= 25;
      }
    }

    // --- TIER 1: dump pattern ---
    // Large sell volume from a wallet that only just bought = rug signal.
    if (evt.side === 'sell') {
      const priorBuy = record.trades.find(t => t.side === 'buy' && t.trader === evt.trader);
      if (priorBuy && evt.timestamp - priorBuy.timestamp < 30_000 && evt.solAmount > priorBuy.solAmount * 0.8) {
        record.flags.push(`Wallet ${short(evt.trader)} bought and dumped within 30s`);
        record.score -= 15;
      }
    }

    record.score = Math.max(0, Math.min(100, record.score));
    return record;
  }

  // Real bundle-detection signal, fed by server.js polling the token's
  // bonding curve address directly via free public Solana RPC (see
  // pumpFeed.js for why that address is available for free). This
  // replaces the old trade-event-based proxy, which never actually had
  // data feeding it on the free tier since live trade events require a
  // paid PumpPortal subscription.
  //
  // Still a proxy, not proof: a high transaction count in the first
  // ~15s is a strong tell of bundled/sniped activity, but confirming
  // multiple wallets share one funding source (the deepest signal)
  // still needs the Tier 2 indexer — see fetchFundingGraph below.
  applyBundleSignal(id, txCountInWindow) {
    const record = this.tokens.get(id);
    if (!record || record.bundleSignalApplied) return null;
    record.bundleSignalApplied = true;

    if (txCountInWindow >= 15) {
      record.flags.push(`${txCountInWindow} transactions hit this token in its first 15s — likely bundled/sniped`);
      record.score -= 25;
    } else if (txCountInWindow >= 8) {
      record.flags.push(`${txCountInWindow} transactions in the first 15s — higher than organic launches typically see`);
      record.score -= 10;
    }
    record.score = Math.max(0, Math.min(100, record.score));
    return record;
  }

  // --- TIER 2 (stub) ---
  // Plug in Helius `getAssetsByOwner` / parsed tx history, or Bitquery's
  // TokenSupplyUpdates + DEXTrades, to answer:
  //   1. Do the top N early-buyer wallets share a common funding wallet?
  //   2. What % of supply do the top 10 holders currently control?
  //   3. Has the creator wallet been linked to a token that later lost
  //      >90% of its value within 24h of migrating (i.e. a confirmed rug)?
  // Wire the real API call in here — everything above already calls
  // `record.flags.push` / `record.score -=` the same way, so the pattern
  // to follow is established.
  async fetchFundingGraph(_mint) {
    throw new Error('Not implemented — plug in Helius/Bitquery here.');
  }

  getToken(mint) {
    return this.tokens.get(mint);
  }

  // Case-insensitive — Solana addresses are case-sensitive base58, but
  // EVM addresses are commonly pasted in mixed case, so normalize.
  findByAddress(address) {
    const direct = this.tokens.get(address);
    if (direct) return direct;
    const lower = address.toLowerCase();
    for (const token of this.tokens.values()) {
      if (token.id.toLowerCase() === lower) return token;
    }
    return null;
  }

  getRecent(limit = 50) {
    return [...this.tokens.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }
}

function short(addr) {
  if (!addr) return 'unknown';
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}
