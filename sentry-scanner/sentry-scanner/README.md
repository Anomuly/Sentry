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

## Real candlestick + volume chart (v0.5)

Replaced the DexScreener iframe with a chart drawn directly on canvas
from real OHLCV data, using **GeckoTerminal's free public API**
(CoinGecko's on-chain DEX arm — no API key required).

I was wrong in an earlier version when I said live chart data required
a paid subscription; that was true of PumpPortal's trade stream, but
GeckoTerminal exposes OHLCV candles and volume for free. Attribution
back to GeckoTerminal is appreciated by them and worth adding to the
UI if this goes public.

What you get: candlesticks with wicks, colored volume bars underneath,
a price axis, hover tooltips with OHLC + volume per candle, timeframe
switching (1m / 5m / 15m / 1H / 4H / 1D), and a 30-second auto-refresh
on the selected token.

**Real limitation:** GeckoTerminal only indexes tokens that have a
liquidity pool. A Pump.fun token still on its bonding curve
(pre-graduation) typically has no pool yet, so there is genuinely no
chart to draw for the very newest launches — the UI says so plainly
rather than showing an empty frame. Charts appear once a token
graduates or otherwise gets an indexed pool.

Requests are proxied and cached server-side (pools 10 min, candles
20 s) because GeckoTerminal rate-limits to ~30 calls/min — without
caching, a handful of open tabs would exhaust that immediately.

## Terminal navigation

The sidebar now has terminal-style tabs with live counts: Live,
Rug Watch (flagged only), Clean, Pump.fun, and Robinhood. Counts
update as tokens stream in.

## Trade panel always visible

Buy/Sell controls now render upfront in a disabled state with a
"Connect Phantom to Trade" button, instead of hiding the entire
trading UI behind wallet connection.

## Scam detection signals (v0.6)

Free-data checks, in rough order of how much they matter:

**Critical (shown in red with a HONEYPOT RISK badge):**
- **Freeze authority still active** — the deployer can freeze token
  accounts, potentially leaving buyers unable to sell. This is the
  classic honeypot setup and is the single highest-value check here.
- **Mint authority not renounced** — the deployer can mint unlimited
  supply and dilute every holder toward zero.

**Serious:**
- **Holder concentration** — top-10 and single-wallet share of visible
  supply, via `getTokenLargestAccounts` (free RPC — an earlier version
  of this README wrongly claimed this needed a paid indexer).
- **Outsized creator launch buy** — deployer opening with a large buy
  of their own token means they hold a big position from block zero.
- **Bundled launch** — real transaction count against the bonding
  curve in the first 15 seconds.
- **Serial launcher** — creator wallet spinning up repeat tokens.

**Notable:**
- **Ticker squatting** — new token reusing the ticker of another live
  token, a common trick to catch buyers pasting the wrong address.
  Free, because Sentry already sees the entire launch stream.

### Concentration caveat, stated plainly
For a token still on its bonding curve, the largest token account is
the curve itself holding unsold supply — normal, not a red flag — so
it's excluded from the concentration math. The tradeoff: for a token
that has already graduated, this excludes a genuine top holder and
slightly understates concentration. Telling the two apart cleanly
would need ~20 extra RPC calls per token, which the public endpoint
won't sustain at Pump.fun's launch volume.

### Rate limits are the binding constraint
Deep scans are queued and paced (~1 every 1.5s, queue capped at 40)
because public Solana RPC is shared and throttled. Under heavy launch
volume some tokens get skipped rather than every scan failing. Setting
`SOLANA_RPC_URL` to a dedicated endpoint (Helius has a free tier)
raises this ceiling a lot and is the single best upgrade for detection
coverage.

### What still isn't covered
- Wallet-funding-graph analysis (proving multiple early buyers were
  funded from one source) — still needs a paid indexer.
- LP lock / burn status.
- Robinhood Chain gets far fewer checks than Solana: Blockscout's
  token list doesn't expose a deployer, so serial-launcher detection
  can't run there. Tokens on that chain are labeled accordingly
  instead of being given a misleadingly clean score.

## Interactive chart (v0.7)

The chart is no longer a static image. Interactions:

- **Scroll wheel** — zoom in/out, anchored on the candle under the
  cursor (so the thing you're pointing at stays put)
- **Click + drag** — pan through history
- **Double-click** — reset to fit all candles
- **Crosshair** — follows the cursor with a live price label on the
  right axis and an OHLCV tooltip for the hovered candle
- **Toolbar** — zoom in / zoom out / Fit / Live toggle
- **Last-price marker** — dashed line with a colored price tag
- **Time axis** — labels along the bottom, spaced to fit the width

Zoom and pan persist across the 30-second auto-refresh. The viewport
only resets when you switch token or timeframe — an earlier version
would have thrown away your zoom every refresh, which would have made
zooming useless in practice.

"Live" mode keeps the view pinned to the newest candle as data streams
in; it turns itself off as soon as you manually zoom or pan, so the
chart doesn't yank away from what you're looking at.

## Chart rebuilt on bonding curve data (v0.8)

**The previous chart could never have worked for this product**, and
that was a design mistake worth naming: it used GeckoTerminal, which
only indexes tokens that already have a liquidity pool. Sentry's entire
feed is brand-new Pump.fun launches still on the bonding curve, which
have no pool. So the chart was empty for essentially every token in the
list.

Fixed by reading the bonding curve directly. A bonding curve is a
formula, not an order book — its price is fully determined by the
reserves in one on-chain account. The server polls that account
(`getMultipleAccounts`, batched across all tracked tokens in a single
RPC call), decodes the reserves, and aggregates the samples into OHLC
candles. Free, no indexer, and it works from the token's first second
of existence.

Graduated tokens still fall back to GeckoTerminal, which has real
volume data for them.

### Volume, honestly
A bonding curve exposes price, not per-trade size. Rather than
fabricate volume bars out of price movement, the volume lane is simply
omitted for curve-sourced charts and the axis says so. Real volume
needs the paid trade stream.

### Performance
The chart previously repainted every candle on every mousemove to draw
the crosshair — that's what made it feel slow. The crosshair now lives
on a separate overlay canvas, so moving the mouse repaints two lines
instead of the whole chart. Pan redraws are also coalesced to one per
animation frame rather than one per mouse event.

Refresh cadence matches the source: ~3s for live curve data (which
samples every 2s), 30s for pool data.

## v0.9 — features pulled from the fomo reference screenshots

Added, all from data already available for free:

- **Price / MCap toggle** on the chart, matching fomo's. Market cap is
  price × 1B (fixed Pump.fun supply), so it's a pure display transform
  — same candles, different axis.
- **Graduation progress bar** — Pump.fun's signature metric. Read from
  the SOL actually sitting in the bonding curve against the ~85 SOL
  graduation threshold. Shows "GRADUATED" once the curve completes.
- **Liquidity stat pill** — the curve's real SOL reserves. This is
  genuine liquidity, not an estimate.
- **Live price + market cap** in the header, sourced from the curve
  rather than the creation-time snapshot, so they move in real time.
- **Chain badges** on token avatars.

### What from those screenshots is NOT built, and why
- **24H volume** — needs per-trade data (paid stream).
- **Buys vs sells pressure bars** — same; requires counting individual
  trades.
- **Holder PnL / avg entry columns** — requires every holder's full
  trade history. Not derivable from on-chain balances alone.
- **Holder count** — `getTokenLargestAccounts` returns the top 20 only.
  A true count needs `getProgramAccounts` (very heavy) or a paid
  indexer.

These are left out rather than approximated. On a tool whose job is
flagging scams, a fabricated number is worse than a missing one.

## v1.0 — research-driven rewrite of the chart + infrastructure notes

### Chart: replaced hand-rolled canvas with TradingView Lightweight Charts
Writing a chart engine from scratch was the wrong call. TradingView
publishes **Lightweight Charts** free under Apache 2.0 (~45KB), and
it's what fomo uses too (their logo is visible in the reference
screenshots). It handles zoom, pan, crosshair, auto-scaling, the time
axis, and large datasets properly — all things the hand-rolled version
did poorly.

TradingView attribution is a license requirement and is satisfied via
the `attributionLogo` chart option.

Kept working on top of it: Price/MCap toggle, timeframe switching,
graduation bar, and the bonding-curve data source.

### The real bottleneck: public RPC
Research finding worth acting on — public Solana RPC endpoints are
capped around 100-200 req/s **shared per IP**, run **2-5 seconds
behind chain head**, and suffer noisy-neighbor effects. That latency
propagates into everything: curve price sampling, deep scans, holder
lookups.

**Set `SOLANA_RPC_URL` on Railway.** This is the single highest-impact
change available and it's free:
- **Alchemy** — 30M compute units/month (most generous free tier;
  already powers Phantom, Solflare, Robinhood)
- **dRPC** — 50M CU/month
- **QuickNode** — 10M credits/month
- **Helius** — 1M credits/month, 10 req/s (Solana-native, but the
  tightest rate cap of the four)

The server logs a warning at startup when this isn't set.

### Worth considering next: a purpose-built Pump.fun data API
Sentry currently stitches together PumpPortal (launches) + bonding
curve reads (price) + GeckoTerminal (graduated charts) + raw RPC
(holders, authorities). **Moralis publishes a dedicated Pump.fun API**
covering OHLCV for both pre-bonded and bonded tokens, bonding status,
swaps, and metadata in one place. Bitquery and Birdeye offer similar
coverage.

That would collapse four fragile integrations into one and unlock the
things currently marked unavailable — real volume, buy/sell counts,
holder PnL. It is a paid dependency, which is why it hasn't been
adopted unilaterally; it's the obvious next step if this goes past
prototype.
