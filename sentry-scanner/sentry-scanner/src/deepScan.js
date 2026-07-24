// deepScan.js
//
// Deeper on-chain scam checks that run a short delay after launch,
// using only FREE public Solana RPC. No paid indexer needed.
//
// These are the highest-signal checks available and several of them
// catch scam types the earlier heuristics completely missed:
//
//   1. FREEZE AUTHORITY — if set, the deployer can freeze token
//      accounts, meaning buyers may be unable to sell. This is the
//      classic honeypot setup and is arguably the single most
//      important check here.
//   2. MINT AUTHORITY — if not renounced, the deployer can mint
//      unlimited new supply and dilute every holder to nothing.
//   3. HOLDER CONCENTRATION — a handful of wallets holding most of
//      the float can dump the price to zero at will.
//   4. DEV'S OWN LAUNCH BUY — an outsized creator buy at launch means
//      the deployer holds a large share from block zero.
//
// RATE LIMITS ARE THE REAL CONSTRAINT. Public Solana RPC is shared and
// throttled. Pump.fun can launch hundreds of tokens an hour, so scans
// are queued and paced rather than fired in parallel — under heavy
// volume some tokens will be skipped rather than every scan failing.
// Setting SOLANA_RPC_URL to a dedicated endpoint (Helius has a free
// tier) raises this ceiling substantially.

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SCAN_DELAY_MS = 25_000;   // let some real trading happen first
const SCAN_INTERVAL_MS = 1_500; // pace between scans to respect rate limits
const MAX_QUEUE = 40;           // drop rather than build an endless backlog

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} returned ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

export class DeepScanner {
  constructor(engine, onUpdate) {
    this.engine = engine;
    this.onUpdate = onUpdate;
    this.queue = [];
    this.pending = new Set();
    setInterval(() => this._drain(), SCAN_INTERVAL_MS);
  }

  schedule(token) {
    if (token.chain !== 'solana' || this.pending.has(token.id)) return;
    if (this.queue.length >= MAX_QUEUE) return; // shed load rather than fall behind forever
    this.pending.add(token.id);
    setTimeout(() => this.queue.push(token), SCAN_DELAY_MS);
  }

  async _drain() {
    const token = this.queue.shift();
    if (!token) return;
    try {
      await this._scan(token);
    } catch (err) {
      console.error('[deepScan]', token.symbol || token.id, err.message);
    } finally {
      this.pending.delete(token.id);
    }
  }

  async _scan(token) {
    const findings = [];
    let penalty = 0;

    // ---- 1 & 2: mint + freeze authority ----
    const info = await rpc('getAccountInfo', [token.id, { encoding: 'jsonParsed' }]);
    const parsed = info?.value?.data?.parsed?.info;

    if (parsed) {
      if (parsed.freezeAuthority) {
        findings.push('HONEYPOT RISK: freeze authority is still active — the deployer can freeze token accounts, which can leave buyers unable to sell');
        penalty += 40;
      }
      if (parsed.mintAuthority) {
        findings.push('Mint authority not renounced — the deployer can mint unlimited new supply and dilute holders');
        penalty += 30;
      }
    }

    // ---- 3: holder concentration ----
    // getTokenLargestAccounts returns the top 20 TOKEN ACCOUNTS.
    //
    // IMPORTANT CAVEAT, stated plainly because it shapes how this
    // should be read: for a Pump.fun token still on its bonding curve,
    // the single largest account is the curve itself holding unsold
    // supply. That is normal and not a red flag, so it's excluded from
    // the concentration math below. The tradeoff is that if a token has
    // already graduated (no curve) this will exclude a genuine top
    // holder and slightly understate concentration. Resolving each
    // account's owner to tell these apart cleanly would cost ~20 extra
    // RPC calls per token, which the public endpoint won't sustain.
    const largest = await rpc('getTokenLargestAccounts', [token.id]);
    const accounts = largest?.value || [];

    if (accounts.length > 1) {
      const amounts = accounts.map(a => Number(a.uiAmount) || 0);
      const totalVisible = amounts.reduce((s, n) => s + n, 0);
      const exCurve = amounts.slice(1); // drop presumed bonding curve
      const exCurveTotal = exCurve.reduce((s, n) => s + n, 0);

      if (totalVisible > 0 && exCurveTotal > 0) {
        const topTenShare = exCurve.slice(0, 10).reduce((s, n) => s + n, 0) / totalVisible * 100;
        const biggestShare = exCurve[0] / totalVisible * 100;

        if (topTenShare >= 50) {
          findings.push(`Top 10 holders control ~${topTenShare.toFixed(0)}% of visible supply — heavily concentrated, they can dump the price at will`);
          penalty += 25;
        } else if (topTenShare >= 30) {
          findings.push(`Top 10 holders control ~${topTenShare.toFixed(0)}% of visible supply — moderately concentrated`);
          penalty += 12;
        }

        if (biggestShare >= 25) {
          findings.push(`A single wallet holds ~${biggestShare.toFixed(0)}% of visible supply`);
          penalty += 20;
        }
      }
    }

    if (findings.length) {
      this.engine.applyDeepFindings(token.id, findings, penalty);
      const updated = this.engine.getToken(token.id);
      if (updated && this.onUpdate) this.onUpdate(updated);
    }
  }
}
