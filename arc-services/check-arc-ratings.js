#!/usr/bin/env node
'use strict';
// ARC RATINGS (2026-10-07, Martin: "our rating must be good"). Two things nightwatch should see:
//   1. Our own agents' on-chain reputation (#1, #211, #214, #215), read from the ERC-8004 registry: count, wallets, average,
//      and what changed since the last run (data/arc-ratings-ours.json). Information, never a failure: we cannot make anyone rate us.
//   2. The fair rater's health (core/arc/fair-rate.js + watch-feedback.js share the watchtower wallet): FAIL when that wallet is
//      under its floor (ratings stop) or when a rating write failed in the last 24 h.
// Usage: node tools/check-arc-ratings.js [--min-watchtower USDC]   (raise the floor above the balance to watch it fail)
const fs = require('fs');
const { createPublicClient, http, fallback, parseAbi } = require('/root/apex-faucet/node_modules/viem');
const { privateKeyToAccount } = require('/root/apex-faucet/node_modules/viem/accounts');
const arg = (k, d) => (process.argv.includes(k) ? Number(process.argv[process.argv.indexOf(k) + 1]) : d);
const MIN_WATCHTOWER = arg('--min-watchtower', 0.1);   // ~30 writes of warning at 0.0034 USDC each
const REG = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const OURS = [1, 211, 214, 215];
const SNAP = '/root/apex-faucet/data/arc-ratings-ours.json';
const LOGS = ['/root/apex-faucet/data/arc-fair-rate.jsonl', '/root/apex-faucet/data/arc-watch-feedback.jsonl'];
const abi = parseAbi(['function getClients(uint256 agentId) view returns (address[])', 'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)']);
const pub = createPublicClient({ transport: fallback(['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io', 'https://rpc.beamrpc.com'].map((u) => http(u, { timeout: 20000 }))) });

(async () => {
  const bad = [];
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(SNAP, 'utf8')).agents || {}; } catch (e) {}
  const now = {};
  for (const id of OURS) {
    try {
      const cl = await pub.readContract({ address: REG, abi, functionName: 'getClients', args: [BigInt(id)] });
      let count = 0, avg = null;
      if (cl.length) { const s = await pub.readContract({ address: REG, abi, functionName: 'getSummary', args: [BigInt(id), cl, '', ''] }); count = Number(s[0]); avg = Number(s[1]) / 10 ** Number(s[2]); }
      now[id] = { count, wallets: cl.length, avg };
      const p = prev[id], moved = p && (p.count !== count || p.avg !== avg) ? '  (was ' + p.count + (p.avg != null ? ' / ' + p.avg : '') + ')' : '';
      console.log('  #' + id + ' on-chain ratings: ' + count + ' from ' + cl.length + ' wallet(s)' + (avg != null ? ', average ' + +avg.toFixed(1) : '') + moved);
    } catch (e) { console.log('  #' + id + ' could not be read (' + String(e.shortMessage || e.message).slice(0, 80) + ') - not the same as zero'); now[id] = prev[id] || null; }
  }
  try { fs.writeFileSync(SNAP + '.tmp', JSON.stringify({ at: new Date().toISOString(), agents: now }) + '\n'); fs.renameSync(SNAP + '.tmp', SNAP); } catch (e) { console.log('  snapshot not written: ' + e.message); }

  const k = JSON.parse(fs.readFileSync('/root/apex-faucet/keys/arc-watchtower.json', 'utf8'));
  const wt = k.address || privateKeyToAccount(k.privateKey).address;
  try {
    const usdc = Number(await pub.getBalance({ address: wt })) / 1e18;
    (usdc < MIN_WATCHTOWER ? bad : []).push('watchtower ' + wt.slice(0, 10) + '… holds ' + usdc.toFixed(4) + ' USDC, floor ' + MIN_WATCHTOWER + ' (pays every rating we write; top up with tools/arc-watchtower-gas.js)');
    console.log('  ' + (usdc < MIN_WATCHTOWER ? 'LOW ' : 'OK  ') + ' watchtower wallet ' + usdc.toFixed(4) + ' USDC (floor ' + MIN_WATCHTOWER + ')');
  } catch (e) { bad.push('watchtower balance could not be read: ' + (e.shortMessage || e.message)); }
  const since = Date.now() - 24 * 3600e3; let ok = 0; const failed = [];
  for (const f of LOGS) {
    let lines = []; try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch (e) { continue; }
    for (const l of lines) { let r; try { r = JSON.parse(l); } catch (e) { continue; } if (!(Date.parse(r.at) > since)) continue; if (r.status === 'success') ok++; else if (r.status !== 'dry') failed.push('#' + r.agentId + ' ' + r.status); }
  }
  console.log('  rating writes in the last 24 h: ' + ok + ' ok, ' + failed.length + ' failed');
  if (failed.length) bad.push(failed.length + ' rating write(s) failed in 24 h: ' + failed.slice(0, 5).join(', '));
  if (bad.length) { for (const b of bad) console.log('  FAIL ' + b); process.exit(1); }
  console.log('  OK   ratings: our reputation read, rater funded, no failed writes');
})().catch((e) => { console.log('  FAIL check crashed: ' + e.message); process.exit(1); });
