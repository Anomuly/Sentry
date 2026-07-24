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
  res.json(engine.getRecent(100));
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', tokens: engine.getRecent(50) }));
  if (engine.solUsd) ws.send(JSON.stringify({ type: 'solPrice', usd: engine.solUsd }));
});

server.listen(PORT, () => {
  console.log(`Sentry scanner running at http://localhost:${PORT}`);
});
