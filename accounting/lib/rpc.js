'use strict';
// ACCOUNT LAYER: read-only RPC (2026-09-29).
//
// Every chain read of the account layer goes through here. Three rules, each enforced in code:
//   1. READ METHODS ONLY. A method outside the allowlist throws BEFORE any network call. There is no way to send a
//      transaction from this module (tools/sweep-account-safety.js also checks that nothing in lib/account or
//      tools/account-* names a send method).
//   2. A FAILED READ THROWS. It never becomes 0, [] or a cached value. Callers record the error and mark the run
//      incomplete (CLAUDE.md §1).
//   3. NOT THROUGH x1-rpc-bus. The bus caches balances for 30 s and serves stale values on upstream errors without
//      saying so; accounting needs the chain's answer or an error. Our own throttle keeps X1 under 3 req/s, far below
//      the 50 req / 5 s the whole server shares.
// Every answer carries the endpoint that gave it, so a number can always be traced to where it came from.

const READ_METHODS = new Set([
  // SVM (X1, Solana)
  'getBalance', 'getTokenAccountsByOwner', 'getTokenAccountBalance', 'getAccountInfo', 'getMultipleAccounts',
  'getSignaturesForAddress', 'getTransaction', 'getSlot', 'getBlockTime', 'getGenesisHash', 'getTokenSupply',
  // EVM (Arc, Base)
  'eth_getBalance', 'eth_call', 'eth_getLogs', 'eth_getTransactionCount', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_chainId', 'eth_getCode',
]);

const ENDPOINTS = {
  x1: ['https://rpc.mainnet.x1.xyz'],
  solana: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
  // Arc (2026-10-06): the old deep-log endpoint went dark (Cloudflare 1033). Blockdaemon, from Arc's own chain list, answers reads and
  // 100,000-block log ranges (~70 h of history); beamrpc now caps getLogs at 1,000 blocks; the official RPC rate-limits bursts.
  arc: ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.beamrpc.com', 'https://arc.drpc.org', 'https://rpc.mainnet.arc.io'],
  // 1rpc.io/base answered 'This endpoint has been discontinued' on 2026-09-29; these three served a historical block.
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://base-mainnet.public.blastapi.io'],
};
// eth_getLogs only where it is served: tested 2026-09-29 with a 1,000-block range and a contract filter. arc.drpc.org and
// base.drpc.org refuse on the free plan; blastapi allows 10-block ranges; rpc.mainnet.arc.io refuses a 45-address filter
// (callers chunk the filter to 20). Falling through to an endpoint that cannot answer turned a blip into 'incomplete'.
const LOG_ENDPOINTS = {
  arc: ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.beamrpc.com', 'https://rpc.mainnet.arc.io'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
};
// Minimum gap between two calls to the same host (ms). X1: 350 ms = under 3 req/s.
const GAP_MS = { x1: 350, solana: 400, arc: 150, base: 150 };
const _last = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle(chain, url) {
  const gap = GAP_MS[chain] || 200;
  const t = _last.get(url) || 0;
  const wait = t + gap - Date.now();
  if (wait > 0) await sleep(wait);
  _last.set(url, Date.now());
}

class RpcError extends Error {}

// call(chain, method, params, { endpoints, tries }) -> { result, url }
async function call(chain, method, params, opts = {}) {
  if (!READ_METHODS.has(method)) throw new RpcError('account layer: "' + method + '" is not a read method and is refused');
  const urls = opts.endpoints || (method === 'eth_getLogs' && LOG_ENDPOINTS[chain]) || ENDPOINTS[chain];
  if (!urls || !urls.length) throw new RpcError('account layer: no endpoint for chain ' + chain);
  const tries = opts.tries || 5;
  let last = null, nullFrom = null, unanswered = 0;
  // 2026-10-06 (Fable review): a node that pruned old blocks answers a receipt or transaction lookup with null, as if the
  // transaction did not exist (Blockdaemon on a 1-Oct and a 4-Oct hash). For lookups by hash a null is therefore not an
  // answer: ask the next endpoint, and return null only when every endpoint said null.
  const nullIsNotAnswer = method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash';
  outer:
  for (const url of urls) {
    unanswered++;   // undone below when this endpoint answers (with null)
    for (let i = 0; i < tries; i++) {
      await throttle(chain, url);
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(opts.timeoutMs || 20000) });
        // 429 = the shared X1 budget is busy: back off harder (1, 2, 4, 6 s) instead of burning retries in under 5 s.
        if (r.status === 429 || r.status >= 500) { last = new RpcError(url + ' HTTP ' + r.status); await sleep(r.status === 429 ? [1000, 2000, 4000, 6000, 8000][i] || 8000 : 800 * (i + 1)); continue; }
        const j = await r.json();
        if (j.error) {
          const msg = String(j.error.message || JSON.stringify(j.error));
          last = new RpcError(url + ': ' + msg.slice(0, 160));
          if (/rate|limit|busy|saturat|timeout|try again/i.test(msg)) { await sleep(800 * (i + 1)); continue; }
          break;   // a real error from this endpoint: try the next endpoint, never retry the same wrong question
        }
        if (!('result' in j)) { last = new RpcError(url + ': no result field'); break; }
        if (j.result === null && nullIsNotAnswer) { nullFrom = nullFrom || url; unanswered--; continue outer; }
        return { result: j.result, url };
      } catch (e) { last = e instanceof RpcError ? e : new RpcError(url + ': ' + String(e.message || e).slice(0, 160)); await sleep(500 * (i + 1)); }
    }
  }
  // null only when EVERY endpoint answered null; if one of them failed, it might have had it: incomplete, not 'not found'
  if (nullFrom && unanswered === 0) return { result: null, url: nullFrom };
  throw last || new RpcError('account layer: every endpoint failed for ' + chain + ' ' + method);
}

module.exports = { LOG_ENDPOINTS, call, READ_METHODS, ENDPOINTS, RpcError };
