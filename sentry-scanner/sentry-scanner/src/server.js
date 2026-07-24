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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });

const engine = new RiskEngine();
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
});
pumpFeed.on('trade', (evt) => {
  const record = engine.onTrade(evt);
  if (record) broadcast({ type: 'update', token: record });
});
pumpFeed.on('status', (status) => broadcast({ type: 'feedStatus', chain: 'solana', status }));

// --- Robinhood Chain ---
robinhoodFeed.on('tokenCreated', (evt) => {
  const record = engine.onTokenCreated(evt);
  broadcast({ type: 'token', token: record });
});
robinhoodFeed.on('poolCreated', (evt) => {
  broadcast({ type: 'poolCreated', chain: 'robinhood', ...evt });
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
      const rpcRes = await fetch('https://api.mainnet-beta.solana.com', {
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

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', tokens: engine.getRecent(150) }));
  if (engine.solUsd) ws.send(JSON.stringify({ type: 'solPrice', usd: engine.solUsd }));
});

// --- Trade transaction builder (Solana / Pump.fun) ---
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
    res.json({ transaction: base64Tx });
  } catch (err) {
    res.status(500).json({ error: 'Transaction build failed: ' + err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Sentry scanner running at http://localhost:${PORT}`);
});
