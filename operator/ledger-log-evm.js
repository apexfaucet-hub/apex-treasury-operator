'use strict';
// SHARED LEDGER WRITER, EVM (2026-10-06, Fable review gap 3). lib/ledger-log.js records what left our X1/Solana wallets;
// it parses Solana instructions and cannot read an Arc or Base transaction. This is the same recorder for Arc and Base.
//
// RULES (the same as lib/ledger-log.js)
// - Only the SENDER calls it, with the hash IT got back for a transaction IT signed. Never run over a wallet's history.
// - It records the VALUE that left each named wallet, read from the receipt; the network fee is NOT included (the
//   reconciler adds fees from receipts itself).
//     Arc: every native USDC movement (a plain value send, an ERC-20 transfer on 0x3600…, a transferFrom, a contract
//          pulling USDC) emits a Transfer log from 0xffff…fffe in 18 decimals. A transfer through the ERC-20 face (0x3600…)
//          also emits a 6-decimal face log; a plain value send emits only the native one (0x308f4e9e… and 0x3d8f55a3…,
//          6 Oct; Fable sampled 32 of 32 pulls with the native log). USDC is counted from the 0xff…fe logs only.
//     Base: native ETH = tx.value when the sender is ours (an EOA's ETH cannot be pulled by a contract); tokens from
//          their Transfer logs.
//     Any other token: its ERC-20 Transfer logs (3 topics) out of our wallets, in the token's own decimals.
// - The sender states the most it meant to move (`expect`). It fails closed, like H5 in lib/ledger-log.js:
//     an outflow above its bound, an outflow of an asset `expect` does not name, an ERC-721 transfer out of our wallet,
//     or a token whose decimals() cannot be read => NOTHING is recorded for that transaction, the failure is written to
//     data/ledger/_errors-<source>.ndjson, and the reconciler alarms on the unrecorded outflow. That is the point: a
//     contract called with our key that moves more than intended must never be "explained" by the chain it moved on.
// - It never throws into the caller's payment flow.
//
// expect: { usdc: max USDC (Arc native USDC / Base USDC), native: max ETH (Base only), tokens: { <address>: max units } }
// Usage: await recordSentEvm(hash, { source: 'arc-gas-refill', chain: 'arc', wallets: [from], expect: { usdc: 0.7 },
//          category: 'internal:gas-topup', product: null, notes: '...' })
const LL = require('./ledger-log.js');

const NATIVE_LOG = '0xfffffffffffffffffffffffffffffffffffffffe';   // Arc: native USDC Transfer logs, 18 decimals
const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000';  // Arc: the ERC-20 face of the same USDC (mirror, ignored)
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// ERC-1155 TransferSingle / TransferBatch: topics [sig, operator, from, to]. Not valued here, so one out of our wallet fails closed.
const T1155 = ['0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62', '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb'];
const RPCS = {
  arc: ['https://rpc.mainnet.arc.io', 'https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.beamrpc.com'],
  base: ['https://mainnet.base.org', 'https://base.llamarpc.com'],
};
const lc = (a) => String(a || '').toLowerCase();
const topicAddr = (t) => '0x' + String(t || '').slice(26).toLowerCase();

// Pure: the value that left `wallets` in one transaction. Exported for the tests.
// tx: { from, to, value (bigint) }; receipt: { status, logs: [{ address, topics, data }] }
// Returns { flows: [{ wallet, to, asset, raw (bigint), decimals|null, kind }], problems: [string] }
function evmOutflows(chain, tx, receipt, wallets) {
  const mine = new Set(wallets.map(lc));
  const flows = [], problems = [];
  if (chain === 'base' && mine.has(lc(tx.from)) && BigInt(tx.value || 0) > 0n) {
    flows.push({ wallet: lc(tx.from), to: lc(tx.to), asset: 'base:native', raw: BigInt(tx.value), decimals: 18, kind: 'native value' });
  }
  for (const l of receipt.logs || []) {
    const addr = lc(l.address);
    if (l.topics && T1155.includes(lc(l.topics[0])) && mine.has(topicAddr(l.topics[2]))) { problems.push('an ERC-1155 transfer left ' + topicAddr(l.topics[2]) + ' (token ' + addr + ')'); continue; }
    if (!l.topics || lc(l.topics[0]) !== TRANSFER) continue;
    if (chain === 'arc' && addr === ARC_USDC_ERC20) continue;   // mirror of the native log
    const from = topicAddr(l.topics[1]);
    if (!mine.has(from)) continue;
    if (l.topics.length === 4) { problems.push('an ERC-721 transfer left ' + from + ' (token ' + addr + ')'); continue; }
    if (l.topics.length !== 3) { problems.push('a Transfer log of unknown shape from ' + addr); continue; }
    const raw = BigInt(l.data);
    if (raw === 0n) continue;
    if (chain === 'arc' && addr === NATIVE_LOG) flows.push({ wallet: from, to: topicAddr(l.topics[2]), asset: 'arc:native', raw, decimals: 18, kind: 'usdc' });
    else if (chain === 'base' && addr === BASE_USDC) flows.push({ wallet: from, to: topicAddr(l.topics[2]), asset: 'base:' + BASE_USDC, raw, decimals: 6, kind: 'usdc' });
    else flows.push({ wallet: from, to: topicAddr(l.topics[2]), asset: chain + ':' + addr, raw, decimals: null, kind: 'token' });
  }
  return { flows, problems };
}

// Pure: compare flows with what the sender said it meant to move. Returns a list of problems (empty = within bounds).
function checkExpect(chain, flows, expect) {
  const problems = [];
  if (!expect || typeof expect !== 'object') return ['no expect given: refusing to record an unbounded outflow'];
  const sums = {};
  for (const f of flows) sums[f.asset] = (sums[f.asset] || 0) + Number(f.raw) / 10 ** f.decimals;
  for (const [asset, amt] of Object.entries(sums)) {
    let max = null;
    if (asset === 'arc:native' || asset === 'base:' + BASE_USDC) max = expect.usdc;
    else if (asset === 'base:native') max = expect.native;
    else { const t = asset.split(':')[1]; const k = Object.keys(expect.tokens || {}).find((x) => lc(x) === t); max = k ? expect.tokens[k] : undefined; }
    if (max == null || !(Number(max) >= 0)) problems.push('undeclared outflow: ' + amt + ' of ' + asset + ' left, and expect does not name it');
    else if (amt > Number(max) * (1 + 1e-9)) problems.push('exceeds-expectation: ' + amt + ' of ' + asset + ' left, the sender expected at most ' + max);
  }
  return problems;
}

async function client(chain, rpc) {
  const v = require('/root/apex-faucet/node_modules/viem');
  const urls = rpc ? [rpc] : RPCS[chain];
  return { v, pub: v.createPublicClient({ transport: v.fallback(urls.map((u) => v.http(u, { timeout: 15000, retryCount: 1 })), { rank: false }) }) };
}

async function recordSentEvm(hash, meta) {
  const source = meta && meta.source;
  try {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(String(source || ''))) return LL._fail(String(source), hash, 'bad source name');
    const chain = meta.chain;
    if (chain !== 'arc' && chain !== 'base') return LL._fail(source, hash, 'chain must be arc or base');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || '')) || !Array.isArray(meta.wallets) || !meta.wallets.length) return LL._fail(source, hash, 'missing hash or wallets');
    const { pub } = await client(chain, meta.rpc);
    let rc = null, tx = null;
    for (let i = 0; i < 18 && !rc; i++) {
      try { rc = await pub.getTransactionReceipt({ hash }); } catch (e) { /* not yet, or one node behind */ }
      if (!rc) await new Promise((r) => setTimeout(r, 5000));
    }
    if (!rc) return LL._fail(source, hash, 'receipt not found after 90 s (not landed, or RPC behind)');
    tx = await pub.getTransaction({ hash });
    if (rc.status !== 'success') { LL._append(source + '.ndjson', { at: new Date().toISOString(), chain, tx: hash, failed: true, note: 'reverted on chain: only its fee left our wallet, which the reconciler counts itself' }); return []; }
    const { flows, problems } = evmOutflows(chain, tx, rc, meta.wallets);
    for (const f of flows) {
      if (f.decimals != null) continue;
      try { f.decimals = Number(await pub.readContract({ address: f.asset.split(':')[1], abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }], functionName: 'decimals' })); }
      catch (e) { problems.push('decimals() unreadable for ' + f.asset + ': ' + (e.shortMessage || e.message).slice(0, 80)); }
    }
    if (problems.length) return LL._fail(source, hash, problems.join('; '));
    const over = checkExpect(chain, flows, meta.expect);
    if (over.length) return LL._fail(source, hash, over.join('; '));
    const blk = await pub.getBlock({ blockNumber: rc.blockNumber }).catch(() => null);
    const at = blk ? new Date(Number(blk.timestamp) * 1000).toISOString() : new Date().toISOString();
    flows.forEach((f, n) => LL._append(source + '.ndjson', {
      at, chain, tx: hash, leg: n, wallet: f.wallet, direction: 'out', asset_id: f.asset,
      amount: Number(f.raw) / 10 ** f.decimals, amount_raw: f.raw.toString(), counterparty: f.to,
      category: meta.category || 'transfer', product: meta.product || null, notes: (meta.notes ? meta.notes + '; ' : '') + f.kind,
    }));
    return flows;
  } catch (e) { return LL._fail(source, hash, 'recorder error: ' + (e && e.message)); }
}

module.exports = { recordSentEvm, evmOutflows, checkExpect, NATIVE_LOG, ARC_USDC_ERC20, BASE_USDC, DIR: LL.DIR };
