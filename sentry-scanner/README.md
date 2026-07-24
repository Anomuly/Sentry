# Sentry Scanner — v0.2

Real-time meme coin scam/bundle detector. Watches new token launches
on **Pump.fun (Solana)** and **Robinhood Chain** and scores them live
as activity comes in.

## What actually works right now (no API key needed)

- Live connection to Pump.fun's free public feed — new token creations
  and trades, streamed within ~1 second of block confirmation.
- Live connection to Robinhood Chain's public RPC — watches every new
  contract deployment, checks if it's an ERC-20, and watches the
  Uniswap V3 factory for pool creation (the moment a token actually
  becomes tradeable — the Robinhood Chain equivalent of a Pump.fun
  "graduation").
- **Serial-launcher detection**: flags creator wallets that have
  launched multiple tokens in the last 24h (classic rug-farm pattern) —
  works on both chains.
- **Sniper/bundle proxy detection** (Pump.fun): flags tokens with an
  unusually high number of distinct buys in the first 15 seconds after
  launch.
- **Dump detection** (Pump.fun): flags wallets that buy and then sell
  most of their position within 30 seconds.
- One live dashboard at `http://localhost:8080` showing every scanned
  token from both chains, each tagged with its source, a running trust
  score (0–100), and the specific flags that dropped it.

## What's stubbed and needs a paid data provider

- `src/riskEngine.js` has a `fetchFundingGraph()` stub — wallet-funding
  graph tracing and real holder-concentration checks need Helius,
  Bitquery, or Shyft for Solana.
- `src/robinhoodFeed.js` uses Robinhood Chain's free public RPC, which
  is explicitly rate-limited and "not recommended for production use"
  per Robinhood's own docs. Swap in an Alchemy or Chainstack endpoint
  before relying on this daily. Also worth double-checking: the
  Uniswap V3 factory address is assumed to match its address on other
  EVM chains — confirm that's actually where it's deployed on
  Robinhood Chain before trusting pool-creation events from it.
- Robinhood Chain launchpads (Memecoin.Fun is currently the active
  one) aren't specifically tracked yet — right now the feed catches
  *any* new ERC-20 + pool, launchpad or not. Add launchpad-specific
  contract watching once you've confirmed their factory addresses.

## Running it

```
npm install
npm start
```

Then open http://localhost:8080.

## Where to actually run this — and why Netlify won't work for the backend

**Netlify can't run this.** Netlify hosts static sites and short-lived
serverless functions — this server needs to hold an open, persistent
connection to two blockchains 24/7, which serverless functions aren't
built for (they spin up, run briefly, and shut down). If you deploy
this to Netlify as-is, the feeds will never stay connected.

What actually works:
- **Railway or Render** — easiest option, free/cheap tier, deploys a
  Node app straight from a GitHub repo, keeps it running continuously.
  Good starting point.
- **Fly.io** — similar, a bit more control, still simple.
- **A small VPS** (DigitalOcean, Linode, Hetzner) — more setup, but
  full control and cheap ($4-6/mo range).

Netlify *does* still have a role: once this has a real backend running
somewhere, you could host the dashboard's static frontend on Netlify
and have it talk to your backend's API/WebSocket over the network. But
the scanning engine itself needs an always-on server, not Netlify.

## Known gaps before this is trustworthy enough to ship

- Single feed per chain = single point of failure. Add a second data
  source per chain before relying on this for real money decisions.
- No persistence yet — restart the server and history resets. Add a
  database (Postgres/Timescale fits time-series token data well).
- No liquidity-lock check on either chain yet.
- This scores tokens; it does not yet execute anything. Auto-exit is a
  separate, much bigger piece of work involving delegated wallet
  permissions — prove out scoring accuracy first before touching
  custody-adjacent code.
