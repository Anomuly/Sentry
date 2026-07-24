// curveTracker.js
//
// Real price data for tokens that are still on the Pump.fun bonding
// curve — i.e. almost everything in Sentry's live feed.
//
// WHY THIS EXISTS: the chart previously used GeckoTerminal, which only
// indexes tokens that already have a liquidity pool. Brand-new Pump.fun
// launches don't have one until they graduate, so the chart was empty
// for essentially every token in the feed. That was the wrong data
// source for this product.
//
// A bonding curve is a formula, not an order book: its current price is
// fully determined by the reserves held in one on-chain account. So we
// can poll that account and compute price exactly, with no indexer and
// no paid API.
//
// Pump.fun BondingCurve account layout (little-endian):
//   0..8   discriminator
//   8..16  virtualTokenReserves  u64
//   16..24 virtualSolReserves    u64
//   24..32 realTokenReserves     u64
//   32..40 realSolReserves       u64
//   40..48 tokenTotalSupply      u64
//   48     complete              bool
//
// price(SOL per token) = (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6)
// (SOL has 9 decimals; Pump.fun tokens have 6.)

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SOL_DECIMALS = 1e9;
const TOKEN_DECIMALS = 1e6;

const POLL_MS = 2000;          // how often an actively-viewed token is sampled
const IDLE_EVICT_MS = 90_000;  // stop tracking once nobody is looking at it
const MAX_SAMPLES = 2000;      // ~66 min of 2s samples per token
const MAX_TRACKED = 12;        // cap concurrent polling to respect RPC limits
const GRADUATION_SOL = 85;     // approximate Pump.fun graduation threshold

function readU64LE(buf, offset) {
  // Reserves comfortably exceed 2^53 in raw units, so read as BigInt
  // and only convert to Number after scaling down by decimals.
  return buf.readBigUInt64LE(offset);
}

export class CurveTracker {
  constructor() {
    // mint -> { curveKey, samples: [{t, p}], lastSeen, complete }
    this.tracked = new Map();
    setInterval(() => this._tick(), POLL_MS);
  }

  /**
   * Begin (or refresh) tracking a token's bonding curve. Called when a
   * client opens that token's chart.
   */
  track(mint, curveKey) {
    if (!mint || !curveKey) return;
    const existing = this.tracked.get(mint);
    if (existing) {
      existing.lastSeen = Date.now();
      return;
    }
    if (this.tracked.size >= MAX_TRACKED) {
      // Evict whichever tracked token has gone unviewed the longest.
      let oldestKey = null, oldestAt = Infinity;
      for (const [k, v] of this.tracked) {
        if (v.lastSeen < oldestAt) { oldestAt = v.lastSeen; oldestKey = k; }
      }
      if (oldestKey) this.tracked.delete(oldestKey);
    }
    this.tracked.set(mint, {
      curveKey,
      samples: [],
      lastSeen: Date.now(),
      complete: false,
    });
  }

  hasData(mint) {
    const t = this.tracked.get(mint);
    return !!(t && t.samples.length);
  }

  async _tick() {
    const now = Date.now();
    const active = [];

    for (const [mint, entry] of this.tracked) {
      if (now - entry.lastSeen > IDLE_EVICT_MS) { this.tracked.delete(mint); continue; }
      if (entry.complete) continue; // graduated — curve no longer moves
      active.push([mint, entry]);
    }
    if (!active.length) return;

    // One batched RPC call for every tracked curve, rather than one per
    // token — this is the difference between working and being rate
    // limited on the public endpoint.
    try {
      const keys = active.map(([, e]) => e.curveKey);
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
          params: [keys, { encoding: 'base64', commitment: 'confirmed' }],
        }),
      });
      const json = await res.json();
      const values = json?.result?.value || [];

      values.forEach((val, i) => {
        if (!val || !val.data) return;
        const [mint, entry] = active[i];
        const buf = Buffer.from(val.data[0], 'base64');
        if (buf.length < 49) return;

        const vTokens = readU64LE(buf, 8);
        const vSol = readU64LE(buf, 16);
        const rTokens = readU64LE(buf, 24);
        const rSol = readU64LE(buf, 32);
        const totalSupply = readU64LE(buf, 40);
        entry.complete = buf.readUInt8(48) === 1;

        if (vTokens === 0n) return;
        const solAmt = Number(vSol) / SOL_DECIMALS;
        const tokAmt = Number(vTokens) / TOKEN_DECIMALS;
        if (!(tokAmt > 0)) return;

        const price = solAmt / tokAmt;
        if (!Number.isFinite(price) || price <= 0) return;

        // realSolReserves is the actual SOL sitting in the curve — this
        // IS the token's liquidity, and it's free to read. Graduation
        // happens near ~85 SOL on Pump.fun; treating that as the target
        // gives a progress bar without needing any extra data source.
        entry.liquiditySol = Number(rSol) / SOL_DECIMALS;
        entry.realTokenReserves = Number(rTokens) / TOKEN_DECIMALS;
        entry.totalSupply = Number(totalSupply) / TOKEN_DECIMALS;
        entry.gradProgress = Math.max(0, Math.min(1, entry.liquiditySol / GRADUATION_SOL));
        entry.lastPrice = price;

        entry.samples.push({ t: Date.now(), p: price });
        if (entry.samples.length > MAX_SAMPLES) entry.samples.shift();
      });
    } catch (err) {
      console.error('[curveTracker] poll failed:', err.message);
    }
  }

  /**
   * Aggregate raw price samples into OHLC candles.
   *
   * Honest note on volume: a bonding curve exposes price, not per-trade
   * size. Deriving true volume would need the trade stream (paid). So
   * candles report price faithfully and volume is reported as null
   * rather than fabricated from price movement.
   */
  getCandles(mint, bucketMs = 5000, limit = 180) {
    const entry = this.tracked.get(mint);
    if (entry) entry.lastSeen = Date.now();
    if (!entry || !entry.samples.length) return { candles: [], source: 'curve', tracking: !!entry };

    const buckets = new Map();
    for (const s of entry.samples) {
      const key = Math.floor(s.t / bucketMs) * bucketMs;
      const b = buckets.get(key);
      if (!b) {
        buckets.set(key, { t: key / 1000, o: s.p, h: s.p, l: s.p, c: s.p, v: null });
      } else {
        b.h = Math.max(b.h, s.p);
        b.l = Math.min(b.l, s.p);
        b.c = s.p;
      }
    }

    const candles = [...buckets.values()].sort((a, b) => a.t - b.t).slice(-limit);
    return {
      candles,
      source: 'curve',
      tracking: true,
      complete: entry.complete,
      liquiditySol: entry.liquiditySol ?? null,
      gradProgress: entry.gradProgress ?? null,
      lastPrice: entry.lastPrice ?? null,
      totalSupply: entry.totalSupply ?? null,
    };
  }
}
