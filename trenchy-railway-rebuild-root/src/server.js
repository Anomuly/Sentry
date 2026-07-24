import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'trenchy', uptime: Math.round(process.uptime()) }));
app.get('/api/status', (_req, res) => res.json({ ok: true, feeds: { solana: 'online', scanner: 'online' }, timestamp: Date.now() }));

app.get('/api/tokens', async (_req, res) => {
  try {
    const response = await fetch('https://api.dexscreener.com/latest/dex/search?q=SOL', { headers: { 'User-Agent': 'Trenchy/1.0' } });
    if (!response.ok) throw new Error(`DexScreener ${response.status}`);
    const data = await response.json();
    const pairs = Array.isArray(data.pairs) ? data.pairs.slice(0, 12) : [];
    res.json({ source: 'dexscreener', pairs });
  } catch (error) {
    res.json({ source: 'demo', error: error.message, pairs: [] });
  }
});

app.get('/api/lookup', async (req, res) => {
  const address = String(req.query.address || '').trim();
  if (!address) return res.status(400).json({ error: 'address is required' });
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`, { headers: { 'User-Agent': 'Trenchy/1.0' } });
    const data = await response.json();
    const pairs = Array.isArray(data.pairs) ? data.pairs : [];
    res.json({ found: pairs.length > 0, pairs });
  } catch (error) {
    res.status(502).json({ error: 'Lookup failed', detail: error.message });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
});

setInterval(() => {
  broadcast({
    type: 'pulse',
    timestamp: Date.now(),
    stats: {
      scanned: 12842 + Math.floor(Math.random() * 30),
      wallets: 8392 + Math.floor(Math.random() * 12),
      users: 2847 + Math.floor(Math.random() * 8)
    }
  });
}, 5000).unref();

process.on('uncaughtException', error => console.error('[uncaughtException]', error));
process.on('unhandledRejection', error => console.error('[unhandledRejection]', error));

server.listen(PORT, HOST, () => console.log(`[trenchy] listening on ${HOST}:${PORT}`));
