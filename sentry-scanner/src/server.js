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

// REST snapshot for anything that just wants current state (e.g. page load)
app.get('/api/feed', (_req, res) => {
  res.json(engine.getRecent(100));
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', tokens: engine.getRecent(50) }));
});

server.listen(PORT, () => {
  console.log(`Sentry scanner running at http://localhost:${PORT}`);
});
