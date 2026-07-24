// chartData.js
//
// Real OHLCV (candlestick + volume) data via GeckoTerminal's public API.
// Free, no API key. Rate limited to ~30 calls/min, so everything here is
// cached aggressively — without caching, a busy dashboard would blow
// through the limit in seconds and start returning nothing.
//
// Two-step lookup:
//   1. token address -> its most liquid pool address
//   2. pool address  -> OHLCV candles
// Pools are cached far longer than candles since a token's main pool
// rarely changes, while candles go stale fast.
//
// HONEST LIMITATION: GeckoTerminal only knows about tokens that have an
// indexed liquidity pool. A Pump.fun token still on its bonding curve
// (pre-graduation) usually has no pool yet, so there is genuinely no
// chart to draw for the newest launches. That's a data reality, not a
// bug — the API returns a clear "no pool" signal and the UI says so
// rather than showing an empty chart frame.

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const POOL_CACHE_MS = 10 * 60 * 1000;   // 10 min
const CANDLE_CACHE_MS = 20 * 1000;      // 20 s

const poolCache = new Map();   // tokenAddress -> { poolAddress|null, at }
const candleCache = new Map(); // cacheKey -> { data, at }

function networkSlug(chain) {
  // GeckoTerminal network identifiers.
  if (chain === 'robinhood') return 'robinhood';
  return 'solana';
}

async function findPool(chain, tokenAddress) {
  const cached = poolCache.get(tokenAddress);
  if (cached && Date.now() - cached.at < POOL_CACHE_MS) return cached.poolAddress;

  const network = networkSlug(chain);
  const url = `${GT_BASE}/networks/${network}/tokens/${tokenAddress}/pools`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });

  if (!res.ok) {
    poolCache.set(tokenAddress, { poolAddress: null, at: Date.now() });
    return null;
  }

  const json = await res.json();
  const first = Array.isArray(json.data) ? json.data[0] : null;
  // Pool ids come back namespaced like "solana_ABC123" — strip the prefix.
  const rawId = first?.id || null;
  const poolAddress = rawId ? rawId.replace(`${network}_`, '') : null;

  poolCache.set(tokenAddress, { poolAddress, at: Date.now() });
  return poolAddress;
}

export async function getOhlcv(chain, tokenAddress, timeframe = 'minute', aggregate = 1, limit = 120) {
  const cacheKey = `${chain}:${tokenAddress}:${timeframe}:${aggregate}:${limit}`;
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CANDLE_CACHE_MS) return cached.data;

  const poolAddress = await findPool(chain, tokenAddress);
  if (!poolAddress) {
    const payload = {
      candles: [],
      poolFound: false,
      reason: 'No indexed liquidity pool yet — common for tokens still on a bonding curve. A chart appears once the token has a tradeable pool.',
    };
    candleCache.set(cacheKey, { data: payload, at: Date.now() });
    return payload;
  }

  const network = networkSlug(chain);
  const url = `${GT_BASE}/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}`
    + `?aggregate=${aggregate}&limit=${limit}&currency=usd`;

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    // Don't cache transient failures as long as real answers, or a
    // single rate-limit blip would blank the chart for 20s.
    return { candles: [], poolFound: true, poolAddress, reason: `Chart data unavailable (${res.status})` };
  }

  const json = await res.json();
  const raw = json?.data?.attributes?.ohlcv_list || [];

  // GeckoTerminal returns newest-first: [timestamp, o, h, l, c, volume]
  const candles = raw
    .map(([t, o, h, l, c, v]) => ({
      t: Number(t),
      o: Number(o),
      h: Number(h),
      l: Number(l),
      c: Number(c),
      v: Number(v),
    }))
    .filter(k => Number.isFinite(k.o) && Number.isFinite(k.c))
    .sort((a, b) => a.t - b.t); // oldest-first for left-to-right plotting

  const payload = { candles, poolFound: true, poolAddress };
  candleCache.set(cacheKey, { data: payload, at: Date.now() });
  return payload;
}
