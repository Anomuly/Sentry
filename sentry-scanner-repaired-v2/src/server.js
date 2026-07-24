// server.js
//
// Wires PumpFeed -> RiskEngine -> connected dashboard clients.
// Run with: npm install && npm start
// Then open http://localhost:8080

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { PumpFeed } from './pumpFeed.js';
import { RobinhoodFeed } from './robinhoodFeed.js';
import { RiskEngine } from './riskEngine.js';
import { getOhlcv } from './chartData.js';
import { DeepScanner } from './deepScan.js';
import { CurveTracker } from './curveTracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

// --- Platform fee config ---
// FEE_WALLET_ADDRESS must be a PUBLIC Solana address only — never a
// private key or seed phrase. Set both env vars on Railway to enable;
// leave either unset and fee injection is a no-op (trades work exactly
// as before, just with no fee added).
const FEE_WALLET = process.env.FEE_WALLET_ADDRESS || null;
const FEE_BPS = Number(process.env.FEE_BPS || 0); // basis points, e.g. 50 = 0.5%

// Public Solana RPC is rate limited (~100-200 req/s shared per IP) and
// runs 2-5 seconds behind chain head. That latency is felt everywhere
// downstream. Setting SOLANA_RPC_URL to a dedicated endpoint is the
// single highest-impact upgrade available — Alchemy's free tier (30M
// compute units/month) and Helius's (1M credits) both work.
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
if (!process.env.SOLANA_RPC_URL) {
  console.warn('[server] Using public Solana RPC — rate limited and ~2-5s behind chain head. Set SOLANA_RPC_URL for materially better performance.');
}

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason);
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });

const engine = new RiskEngine();
const curveTracker = new CurveTracker();
const deepScanner = new DeepScanner(engine, (token) => broadcast({ type: 'update', token }));
const pumpFeed = new PumpFeed();
const robinhoodFeed = new RobinhoodFeed();

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

// --- Pump.fun (Solana) ---
pumpFeed.on('tokenCreated', (evt) => {
  const record = engine.onTokenCreated(evt);
  broadcast({ type: 'token', token: record });

  // Real bundle-detection check: wait until the 15s "bundle window" has
  // passed, then count how many transactions actually hit the bonding
  // curve in that time. Free public Solana RPC, no paid key needed —
  // just rate-limited, so this checks once per token rather than
  // polling repeatedly.
  if (evt.bondingCurveKey) {
    record.bondingCurveKey = evt.bondingCurveKey;
    setTimeout(() => checkBundleActivity(evt.mint, evt.bondingCurveKey), 15_000);
  }

  // Deeper on-chain checks (honeypot / mint authority / holder
  // concentration) run on a paced queue — see deepScan.js.
  deepScanner.schedule(record);
});
pumpFeed.on('trade', (evt) => {
  const record = engine.onTrade(evt);
  if (record) broadcast({ type: 'update', token: record });
});
pumpFeed.on('status', (status) => broadcast({ type: 'feedStatus', chain: 'solana', status }));

async function checkBundleActivity(mint, bondingCurveKey) {
  try {
    const rpcRes = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
        params: [bondingCurveKey, { limit: 200 }],
      }),
    });
    const data = await rpcRes.json();
    const count = Array.isArray(data.result) ? data.result.length : 0;
    const record = engine.applyBundleSignal(mint, count);
    if (record) broadcast({ type: 'update', token: record });
  } catch (err) {
    console.error('[server] bundle activity check failed:', err.message);
  }
}

// --- Robinhood Chain ---
robinhoodFeed.on('tokenCreated', (evt) => {
  const record = engine.onTokenCreated(evt);
  broadcast({ type: 'token', token: record });
});
robinhoodFeed.on('status', (status) => broadcast({ type: 'feedStatus', chain: 'robinhood', status }));

// --- SOL/USD price, refreshed periodically ---
// Needed to convert on-chain SOL market caps into dollar figures. Public,
// no API key required. If this fails (rate limit, network hiccup), market
// caps just stay SOL-denominated on the dashboard rather than breaking.
async function refreshSolPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json();
    const price = data?.solana?.usd;
    if (typeof price === 'number') {
      engine.setSolUsdPrice(price);
      broadcast({ type: 'solPrice', usd: price });
    }
  } catch (err) {
    console.error('[server] SOL price fetch failed:', err.message);
  }
}
refreshSolPrice();
setInterval(refreshSolPrice, 60_000);

// Deployment health check used by Railway/Render and similar hosts.
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, uptime: Math.round(process.uptime()), timestamp: Date.now() });
});

// REST snapshot for anything that just wants current state (e.g. page load)
app.get('/api/feed', (_req, res) => {
  res.json(engine.getRecent(300));
});

// Look up any address — checks Sentry's own live history first (fast,
// includes score/flags), and if it's never been seen, falls back to a
// direct read of the chain itself so this isn't limited to only what's
// launched since the server started.
//
// Honest limitation: the on-chain fallback confirms a token exists and
// pulls its raw supply/decimals — it can't reconstruct historical
// launch behavior (creator wallet, bundling, etc.) for a token Sentry
// never watched live. That kind of retroactive history needs a paid
// indexer (Helius/Bitquery/Shyft), same as the fetchFundingGraph stub
// in riskEngine.js.
app.get('/api/lookup', async (req, res) => {
  const address = (req.query.address || '').trim();
  if (!address) return res.status(400).json({ error: 'address query param required' });

  const seen = engine.findByAddress(address);
  if (seen) return res.json({ found: true, source: 'live-history', token: seen });

  const isEvm = /^0x[a-fA-F0-9]{40}$/.test(address);
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);

  if (isEvm) {
    try {
      const info = await robinhoodFeed.probeAddress(address);
      if (info) {
        return res.json({ found: true, source: 'on-chain-direct', chain: 'robinhood', ...info });
      }
      return res.json({ found: false, chain: 'robinhood', reason: 'No ERC-20 contract found at that address on Robinhood Chain.' });
    } catch (err) {
      return res.json({ found: false, chain: 'robinhood', reason: 'Lookup failed: ' + err.message });
    }
  }

  if (isSolana) {
    try {
      const rpcRes = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
          params: [address, { encoding: 'jsonParsed' }],
        }),
      });
      const data = await rpcRes.json();
      const parsed = data?.result?.value?.data?.parsed;
      if (parsed?.type === 'mint') {
        return res.json({
          found: true,
          source: 'on-chain-direct',
          chain: 'solana',
          supply: parsed.info.supply,
          decimals: parsed.info.decimals,
          mintAuthority: parsed.info.mintAuthority,
        });
      }
      return res.json({ found: false, chain: 'solana', reason: 'Not a recognized SPL token mint.' });
    } catch (err) {
      return res.json({ found: false, chain: 'solana', reason: 'Lookup failed: ' + err.message });
    }
  }

  return res.json({ found: false, reason: "Doesn't match a Solana or Robinhood Chain address format." });
});

// OHLCV candles + volume for the chart. Proxied through the server so
// the GeckoTerminal rate limit is shared and cached across all users
// rather than hit once per browser tab.
app.get('/api/chart', async (req, res) => {
  const address = (req.query.address || '').trim();
  const chain = (req.query.chain || 'solana').trim();
  const bucket = Number(req.query.bucket) > 0 ? Number(req.query.bucket) : 5000;
  if (!address) return res.status(400).json({ error: 'address required' });

  const record = engine.getToken(address);

  // PREFERRED PATH for anything still on a bonding curve: read the
  // curve's own reserves. This is the only source that works for
  // brand-new launches, which is most of what Sentry shows.
  if (chain === 'solana' && record && record.bondingCurveKey) {
    curveTracker.track(address, record.bondingCurveKey);
    const live = curveTracker.getCandles(address, bucket);
    if (live.candles.length) return res.json(live);

    // Tracking just started — the first sample lands within ~2s.
    return res.json({
      candles: [],
      source: 'curve',
      tracking: true,
      reason: 'Reading the bonding curve now — the first candles appear within a few seconds.',
    });
  }

  // FALLBACK for graduated tokens (they have a real pool, and
  // GeckoTerminal gives proper OHLCV including real volume).
  const timeframe = ['minute', 'hour', 'day'].includes(req.query.timeframe) ? req.query.timeframe : 'minute';
  const aggregate = Number(req.query.aggregate) > 0 ? Number(req.query.aggregate) : 1;
  try {
    const data = await getOhlcv(chain, address, timeframe, aggregate, 120);
    res.json({ ...data, source: 'pool' });
  } catch (err) {
    res.status(500).json({ error: 'Chart fetch failed: ' + err.message, candles: [] });
  }
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', tokens: engine.getRecent(150) }));
  if (engine.solUsd) ws.send(JSON.stringify({ type: 'solPrice', usd: engine.solUsd }));
});

// Adds a platform fee as an EXTRA instruction inside the same
// transaction the user already has to sign — never a separate hidden
// transfer, never something Sentry holds or routes through itself.
// This is the same pattern legitimate DEX aggregators (Jupiter, etc.)
// use for referral/platform fees.
//
// Deliberately conservative: only applies to SOL-denominated buys,
// where the fee amount is known upfront. Sell proceeds in SOL aren't
// known until the trade executes on the bonding curve, so a reliable
// fee can't be computed ahead of time for sells yet — that would need
// a separate quote step, not implemented here. And if the transaction
// uses address lookup tables, this skips fee injection entirely rather
// than risk producing a subtly broken transaction with no way to test
// it against mainnet from this environment.
async function addPlatformFee(base64Tx, traderPublicKey, amountSol) {
  if (!FEE_WALLET || !FEE_BPS || amountSol <= 0) {
    return { transaction: base64Tx, feeApplied: false };
  }

  try {
    // Load the Solana SDK only when fee injection is actually enabled.
    // This keeps the scanner/dashboard online even if the optional trade
    // feature has a dependency or configuration problem.
    const { VersionedTransaction, TransactionMessage, SystemProgram, PublicKey } = await import('@solana/web3.js');
    const txBytes = Buffer.from(base64Tx, 'base64');
    const tx = VersionedTransaction.deserialize(txBytes);

    if (tx.message.addressTableLookups && tx.message.addressTableLookups.length > 0) {
      console.warn('[fee] skipping — transaction uses address lookup tables');
      return { transaction: base64Tx, feeApplied: false };
    }

    const message = TransactionMessage.decompile(tx.message);
    const feeLamports = Math.floor(amountSol * 1_000_000_000 * (FEE_BPS / 10000));
    if (feeLamports <= 0) return { transaction: base64Tx, feeApplied: false };

    message.instructions.push(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(traderPublicKey),
        toPubkey: new PublicKey(FEE_WALLET),
        lamports: feeLamports,
      })
    );

    const newTx = new VersionedTransaction(message.compileToV0Message());
    return {
      transaction: Buffer.from(newTx.serialize()).toString('base64'),
      feeApplied: true,
      feeLamports,
    };
  } catch (err) {
    console.error('[fee] injection failed, sending unmodified transaction:', err.message);
    return { transaction: base64Tx, feeApplied: false };
  }
}
//
// SECURITY MODEL — read before touching this:
//   This endpoint NEVER handles a private key and NEVER signs anything.
//   It only builds an unsigned transaction and hands it back to the
//   browser, which passes it to the user's own wallet extension
//   (Phantom) for the user to review and sign locally. The server has
//   no ability to move anyone's funds. If a future change to this file
//   ever involves a private key or seed phrase touching this server,
//   that is a sign something has gone badly wrong — stop and reconsider.
//
// Uses PumpPortal's public trade-local API to construct the transaction
// (https://pumpportal.fun/api/trade-local) rather than hand-building
// raw bonding-curve instructions here — that's a well-established,
// purpose-built endpoint instead of custom binary-layout code that has
// had no chance to be tested against the real network from this
// environment.
app.post('/api/trade/solana-build', async (req, res) => {
  const { publicKey, action, mint, amount, denominatedInSol, slippage, priorityFee, pool } = req.body || {};

  if (!publicKey || !action || !mint || amount === undefined) {
    return res.status(400).json({ error: 'publicKey, action, mint, and amount are required' });
  }
  if (action !== 'buy' && action !== 'sell') {
    return res.status(400).json({ error: 'action must be "buy" or "sell"' });
  }

  try {
    const portalRes = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey,
        action,
        mint,
        amount,
        denominatedInSol: denominatedInSol ? 'true' : 'false',
        slippage: typeof slippage === 'number' ? slippage : 10, // percent
        priorityFee: typeof priorityFee === 'number' ? priorityFee : 0.00001,
        pool: pool || 'pump',
      }),
    });

    if (!portalRes.ok) {
      const errText = await portalRes.text();
      return res.status(502).json({ error: 'Transaction build failed: ' + errText });
    }

    // PumpPortal returns the raw serialized transaction bytes.
    const buffer = await portalRes.arrayBuffer();
    const base64Tx = Buffer.from(buffer).toString('base64');

    const isSolBuy = action === 'buy' && (denominatedInSol === true || denominatedInSol === 'true');
    const feeResult = isSolBuy
      ? await addPlatformFee(base64Tx, publicKey, amount)
      : { transaction: base64Tx, feeApplied: false };

    res.json({
      transaction: feeResult.transaction,
      feeApplied: feeResult.feeApplied,
      feeBps: feeResult.feeApplied ? FEE_BPS : 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Transaction build failed: ' + err.message });
  }
});

server.on('error', (err) => {
  console.error('[server] failed to listen:', err?.stack || err);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`[server] Sentry scanner listening on ${HOST}:${PORT}`);
});
