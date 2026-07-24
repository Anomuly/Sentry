// robinhoodFeed.js
//
// Robinhood Chain is a fully EVM-compatible Arbitrum Orbit L2 (Chain ID
// 4663, ETH gas, ~100ms blocks). There's no single "launchpad program
// address" the way Pump.fun has one on Solana — tokens get deployed
// as plain ERC-20 contracts, either by hand or through a launchpad UI
// (Memecoin.Fun is the active one as of writing; Noxa paused launches).
// So detection here works two ways:
//
//   1. Watch every new contract deployment on the chain (a tx with
//      `to: null`), then check if it looks like an ERC-20 (has the
//      standard name/symbol/totalSupply methods).
//   2. Watch the Uniswap V3 factory for PoolCreated events — this is
//      the moment a token actually becomes tradeable, which is the
//      signal that matters most (a deployed-but-unlisted contract is
//      not yet a "launch" a trader needs to know about).
//
// Public endpoints (free, rate-limited, fine for development —
// swap for an Alchemy/QuickNode/Chainstack Robinhood Chain endpoint
// before relying on this for anything real):
//   RPC:  https://rpc.mainnet.chain.robinhood.com
//   Verify the mainnet WS feed URL in Robinhood's docs before
//   depending on it — only the testnet WS (wss://feed.testnet.chain.robinhood.com)
//   is confirmed in public docs as of this writing.

import { ethers } from 'ethers';
import { EventEmitter } from 'events';

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

// Canonical Uniswap V3 factory address — same across most EVM chains via
// CREATE2, but CONFIRM this is actually deployed at this address on
// Robinhood Chain before trusting it in production.
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const POOL_CREATED_TOPIC = ethers.id(
  'PoolCreated(address,address,uint24,int24,address)'
);

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
];

export class RobinhoodFeed extends EventEmitter {
  constructor() {
    super();
    this.provider = new ethers.JsonRpcProvider(RPC_URL);
    this._watchBlocks();
    this._watchPools();
  }

  _watchBlocks() {
    this.provider.on('block', async (blockNumber) => {
      try {
        const block = await this.provider.getBlock(blockNumber, true);
        if (!block || !block.prefetchedTransactions) return;

        for (const tx of block.prefetchedTransactions) {
          if (tx.to !== null) continue; // only contract-creation txs

          const receipt = await this.provider.getTransactionReceipt(tx.hash);
          if (!receipt || !receipt.contractAddress) continue;

          const info = await this._probeErc20(receipt.contractAddress);
          if (!info) continue; // not an ERC-20, skip

          this.emit('tokenCreated', {
            address: receipt.contractAddress,
            creator: tx.from,
            name: info.name,
            symbol: info.symbol,
            createdAt: Date.now(),
            chain: 'robinhood',
          });
        }
      } catch (err) {
        console.error('[robinhoodFeed] block scan error:', err.message);
      }
    });

    this.emit('status', 'connected');
  }

  _watchPools() {
    // Fires the moment a token actually gets a trading pool — this is
    // the real "it's live" signal, analogous to a Pump.fun graduation.
    this.provider.on(
      { address: UNISWAP_V3_FACTORY, topics: [POOL_CREATED_TOPIC] },
      (log) => {
        this.emit('poolCreated', {
          txHash: log.transactionHash,
          timestamp: Date.now(),
          chain: 'robinhood',
          raw: log,
        });
      }
    );
  }

  async _probeErc20(address) {
    try {
      const contract = new ethers.Contract(address, ERC20_ABI, this.provider);
      const [name, symbol] = await Promise.all([
        contract.name(),
        contract.symbol(),
      ]);
      if (!name || !symbol) return null;
      return { name, symbol };
    } catch {
      return null; // not ERC-20-shaped, or reverted — skip silently
    }
  }
}
