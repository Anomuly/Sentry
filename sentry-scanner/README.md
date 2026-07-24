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

## Bundle detection — now backed by real data

Earlier versions had a bundle-detection check that looked reasonable in
the code but had nothing feeding it, since live trade events require a
paid PumpPortal key. Fixed properly: Pump.fun's free creation event
includes the token's bonding curve address (every buy/sell hits this
account), so the server now polls it directly via free public Solana
RPC ~15 seconds after each launch and counts real transaction activity.
High counts in that window get flagged as likely bundled/sniped.

Still a proxy, not proof — confirming multiple wallets share one
funding source (the deepest signal) still needs a paid indexer, same
as before. But this is now driven by real on-chain data instead of a
check that could never fire.

One real constraint worth knowing: this uses the public Solana RPC,
which is rate-limited and shared by everyone. Under heavy Pump.fun
launch volume, some of these checks may silently fail to complete —
they fail quietly rather than break anything, but it means coverage
isn't 100%. A dedicated RPC provider (Helius' free tier included)
would make this more reliable.

## Rebrand

Renamed to just Sentry (dropped "Live Scan"), new globe-on-fire logo,
and a red/purple/black color theme throughout. Score colors (green =
safe, red = danger, amber = caution) were kept as-is on purpose — that
mapping is how people already read risk at a glance, and changing it
would hurt readability more than it would help the aesthetic.

## Platform fee (beta) — collecting a cut of trades

**Not legal advice — get a real attorney before relying on this for
real revenue.** Charging a fee on other people's trades is a real
financial service, and depending on jurisdiction that can touch
money-transmitter rules; meme coins are already legally murky as an
asset class. This is built in the most defensible way available (the
fee is one extra instruction inside the same transaction the user
signs — Sentry never custodies funds, never routes them through
itself, and the fee is visible in the transaction, not hidden), but
that is an engineering choice, not a legal clearance.

### Setup
1. Create a brand-new Solana wallet (Phantom or any other) dedicated
   only to receiving fees. **Never share its seed phrase or private
   key with anyone, including Claude.** Only its public address is
   needed.
2. On Railway, set two environment variables on the service:
   - `FEE_WALLET_ADDRESS` — that wallet's public address
   - `FEE_BPS` — the fee in basis points (e.g. `50` = 0.5%, `100` = 1%)
3. Leave either unset and fee collection is fully off — trades work
   exactly as before, no code changes needed to disable it.

### Real limitations, on purpose
- Only applies to SOL-denominated **buys** right now. Sell proceeds in
  SOL aren't known ahead of execution on a bonding curve — computing a
  reliable fee for sells needs a separate price-quote step, not built
  yet.
- If a transaction uses Solana address lookup tables, fee injection is
  skipped entirely rather than risk producing a malformed transaction
  that's never been tested against mainnet from this environment.
- The fee is always shown to the user in the trade panel before they
  sign — this was a deliberate choice, not optional. A hidden fee
  inside a transaction someone is asked to sign is the kind of thing
  that erodes trust fast and may also carry its own disclosure
  obligations depending on jurisdiction.
