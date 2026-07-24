# Sentry Scanner — v0.3

Real-time meme coin scam/bundle detector for **Pump.fun (Solana)** and
**Robinhood Chain**, with market cap, address lookup, and a full detail
view per token.

## What actually works right now (no API key needed)

- Live connection to Pump.fun via PumpPortal's free feed — new token
  creations streamed in real time, including name, symbol, mint,
  creator wallet, and **starting market cap** (Pump.fun computes and
  includes this at creation, so it's free — no paid subscription
  needed for this specific number).
- Live connection to Robinhood Chain's public RPC — watches new
  contract deployments and Uniswap V3 pool creation.
- **Serial-launcher detection** on both chains — flags creator wallets
  that have launched multiple tokens in 24h.
- Dashboard with category tabs (All / Pump.fun / Robinhood Chain /
  Flagged only / Clean only), a working search bar, copy-to-clipboard
  addresses, direct trade/explorer links per token, and a click-through
  detail view showing the full reasoning behind a score.
- **Address lookup that isn't limited to the live session** — paste
  any Solana mint or Robinhood Chain contract address. If Sentry saw
  it launch live, you get the full score/flags. If not, it falls back
  to a direct read of the chain itself (via public RPC, no key needed)
  to at least confirm the token exists and show its raw supply/decimals.

## Important limitation: live market cap updates cost money

This is worth understanding clearly, because it shapes what "market
cap" means on the dashboard right now:

- The **starting** market cap (what you see the moment a token
  launches) is free and accurate — Pump.fun includes it directly in
  the creation event.
- **Updating** that number as the token actually trades — and the
  bundle-sniping / buy-and-dump flags, which depend on watching trades
  after launch — requires PumpPortal's metered trade subscription,
  which needs an API key tied to a wallet funded with at least 0.02
  SOL. It is not free past that point.
- Right now, cards show a small "at launch" tag next to market cap to
  be upfront that the number is a snapshot, not live.
- To turn on live updates: get a PumpPortal API key, fund the linked
  wallet, and set the `PUMPPORTAL_API_KEY` environment variable on
  Railway. `src/pumpFeed.js` already has the logic to use it the
  moment it's set — nothing else needs to change.

## On "every meme coin ever created"

Worth being straightforward about scope: Sentry watches Pump.fun and
Robinhood Chain going **forward from when the server is running** — it
has no way to retroactively know about tokens launched before it
started, on either chain, without a paid historical indexer (Bitquery,
Helius, Shyft). The `/api/lookup` on-chain fallback helps for
individual addresses someone pastes in, but it can't back-fill the
whole history of either chain into the dashboard.

Also, Pump.fun is Solana's dominant meme launchpad but not the only
one (Believe, Boop, Raydium LaunchLab, and others also exist). Adding
a chain-wide watch of every SPL token mint (not just Pump.fun's) is
technically possible but would require heavy filtering to separate
meme coins from the much larger volume of non-meme token activity on
Solana — a meaningfully bigger project than adding one more launchpad,
and worth scoping separately if it's wanted.

## What's still stubbed (Tier 2 — needs a paid indexer)

`src/riskEngine.js` has a `fetchFundingGraph()` stub for the deepest
signal: whether early buyer wallets share a common funding source,
which is the real fingerprint of a bundled launch (as opposed to the
buy-count proxy currently used). Needs Helius, Bitquery, or Shyft.

## Running it

```
npm install
npm start
```

Then open http://localhost:8080. Set `PUMPPORTAL_API_KEY` as an
environment variable to enable live trade data (optional, costs SOL —
see above).

## Known gaps before this is trustworthy enough to ship

- Single feed per chain = single point of failure.
- In-memory only — a server restart clears all history. A database
  (Postgres/Timescale) is the natural next step if this needs to
  survive restarts or be queryable further back than the current
  session.
- No liquidity-lock check on either chain yet.
- This scores tokens; it does not execute anything. Auto-exit is a
  separate, much bigger piece of work involving delegated wallet
  permissions — prove out scoring accuracy first.


## Real trade execution (beta) — Solana / Pump.fun only

Every token's detail modal now has a Buy/Sell panel for Solana tokens.
**Security model: Sentry never touches a private key.** You connect
your own Phantom wallet; the server only builds an unsigned
transaction (via PumpPortal's trade-local API) and hands it back to
your browser, which passes it to Phantom for you to review and sign
locally. The server has no path to move anyone's funds.

This is genuinely untested end-to-end — this sandbox has no network
access, so none of this has touched real mainnet yet. Before trusting
it with real money:
- Test with a very small amount first, on a wallet with little in it
- Watch the browser console and the /api/trade/solana-build response
  for errors before assuming a silent failure means nothing happened
- Double-check slippage (currently hardcoded to 10%) is right for your
  risk tolerance before using it on a volatile new launch

Robinhood Chain trading is intentionally NOT wired up yet. Hand-writing
raw Uniswap V3 swap calldata without any way to test it here was judged
too risky to ship blind — that is next once it can be properly tested,
ideally against Robinhood Chain testnet first.
