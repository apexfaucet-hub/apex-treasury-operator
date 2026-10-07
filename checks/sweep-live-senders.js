#!/usr/bin/env node
'use strict';
// LIVE SENDERS WITHOUT A RECORDER (2026-10-07). sweep-ledger-coverage.js lists every FILE that can send a transaction:
// 385 of them, 374 tolerated as "not yet reviewed", most of them old bots that never run. That list is too long to act on,
// and it is how 14 X1 alerts piled up from 29 Sep to 6 Oct: the senders behind them were on it, live, and nothing said so.
// This check asks the narrower question that matters: which senders are RUNNING (a running service, a timer's service, a
// crontab line), can sign for a wallet the account layer watches (wallet-registry.json), and do not record what they send?
//   1. live units -> their ExecStart scripts (node *.js, and node lines inside *.sh wrappers);
//   2. each script's local require() closure (files under /root/apex-faucet and /home/claudeuser, not node_modules);
//   3. sender files in that closure (the sweep's send pattern, plus spl-token's hidden getOrCreateAssociatedTokenAccount);
//   4. key files those senders (or the entry script) name -> public address (Solana keypair array, or {privateKey} for EVM),
//      matched against the registry. Secrets are read only to derive the address and never printed or stored.
// FAILS (exit 1) when a live, unrecorded sender can sign for a registered wallet and is not in tools/live-senders-baseline.json
// with a reason. --baseline writes the current list (keeping reasons already written). --json prints the full result.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASELINE = process.env.LIVE_SENDERS_BASELINE || path.join(__dirname, 'live-senders-baseline.json');   // env: planted tests only
const REGISTRY = '/root/apex-faucet/data/protected/account/wallet-registry.json';
const LOCAL = /^\/(root\/apex-faucet|home\/claudeuser)\//;
const SEND = /\b(sendRawTransaction|sendAndConfirmTransaction|sendAndConfirmRawTransaction|sendTransaction|eth_sendRawTransaction|writeContract|getOrCreateAssociatedTokenAccount)\s*\(/;
const COVERED = (src) => /ledger-log(-evm)?(\.js)?['"]/.test(src) || (/hand-gate(\.js)?['"]/.test(src) && /\.record\(/.test(src));
const KEYPATH = /['"`](\/[\w\-./]*?(?:key|wallet|keypair|secret|signer)[\w\-./]*?\.json)['"`]/gi;
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return ''; } };

// 1. live units
function liveUnits() {
  const units = new Set();
  for (const l of sh('systemctl', ['list-units', '--type=service', '--state=running', '--no-legend', '--plain']).split('\n')) { const u = l.trim().split(/\s+/)[0]; if (u) units.add(u); }
  for (const l of sh('systemctl', ['list-timers', '--no-legend', '--plain']).split('\n')) for (const t of l.trim().split(/\s+/)) if (/\.service$/.test(t)) units.add(t);
  const out = [];
  for (const u of units) {
    const ex = sh('systemctl', ['show', '-p', 'ExecStart', '--value', u]);
    const wd = sh('systemctl', ['show', '-p', 'WorkingDirectory', '--value', u]).trim() || '/';
    const argv = [...ex.matchAll(/argv\[\]=([^;]*)/g)].map((m) => m[1].trim()).join(' ');
    out.push({ unit: u, cmd: argv, wd });
  }
  for (const [who, args] of [['root', ['-l']], ['claudeuser', ['-u', 'claudeuser', '-l']]]) {
    for (const l of sh('crontab', args).split('\n')) { const t = l.trim(); if (t && !t.startsWith('#')) out.push({ unit: 'cron:' + who + ':' + t.split(/\s+/).slice(5).join(' ').slice(0, 60), cmd: t, wd: '/' }); }
  }
  return out;
}
function scriptsOf(cmd, wd, depth) {
  const files = [];
  for (const tok of cmd.split(/\s+/)) {
    const m = tok.replace(/^['"]|['"]$/g, '');
    if (!/\.(c?js|mjs|sh)$/.test(m)) continue;
    const f = path.isAbsolute(m) ? m : path.resolve(wd, m);
    if (/\.sh$/.test(f)) { const s = read(f); if (s && depth < 2) for (const line of s.split('\n')) if (/\bnode\b/.test(line) && !/^\s*#/.test(line)) files.push(...scriptsOf(line, path.dirname(f), depth + 1)); }
    else if (LOCAL.test(f) && fs.existsSync(f)) files.push(f);
  }
  return files;
}
// 2. local require closure
function resolveReq(from, spec) {
  let f = spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : spec;
  if (!LOCAL.test(f) || /\/node_modules\//.test(f)) return null;
  for (const c of [f, f + '.js', path.join(f, 'index.js')]) { try { if (fs.statSync(c).isFile()) return c; } catch (e) {} }
  return null;
}
function closure(entry) {
  const seen = new Set(), stack = [entry];
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f) || seen.size > 800) continue; seen.add(f);
    const s = read(f); if (!s) continue;
    for (const m of s.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) { const r = resolveReq(f, m[1]); if (r && !seen.has(r)) stack.push(r); }
    // a launcher that loads its app through a path variable (server-cluster.js: require(path.join(__dirname, 'server.js')))
    for (const m of s.matchAll(/path\.(?:join|resolve)\(\s*__dirname\s*,\s*['"]([^'"]+\.c?js)['"]\s*\)/g)) { const r = resolveReq(f, './' + m[1].replace(/^\.\//, '')); if (r && !seen.has(r)) stack.push(r); }
  }
  return [...seen];
}
// 4. key file -> address (never printed: only the derived address leaves this function)
const addrCache = new Map();
function addressOf(keyFile) {
  if (addrCache.has(keyFile)) return addrCache.get(keyFile);
  let a = null;
  try {
    const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    if (Array.isArray(j) && j.length === 64) a = require('/root/apex-faucet/node_modules/@solana/web3.js').Keypair.fromSecretKey(Uint8Array.from(j)).publicKey.toBase58();
    else if (j && typeof j.privateKey === 'string') a = require('/root/apex-faucet/node_modules/viem/accounts').privateKeyToAccount(j.privateKey).address;
  } catch (e) { a = null; }
  addrCache.set(keyFile, a); return a;
}

const reg = new Map();
try { for (const e of JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).entries) if (e.kind === 'wallet' && e.address) { const k = String(e.address).toLowerCase(); reg.set(k, (reg.get(k) || []).concat(e.id)); } }
catch (e) { console.log('FAIL wallet registry unreadable: ' + e.message); process.exit(1); }

const rows = [];
for (const u of liveUnits()) {
  for (const entry of scriptsOf(u.cmd, u.wd, 0)) {
    const files = closure(entry);
    const uncovered = files.filter((f) => { const s = read(f) || ''; return SEND.test(s) && !COVERED(s) && !/\/lib\/ledger-log(-evm)?\.js$/.test(f); });
    if (!uncovered.length) continue;
    const keys = new Set();
    for (const f of [entry, ...uncovered]) for (const m of (read(f) || '').matchAll(KEYPATH)) keys.add(m[1]);
    const signs = [];
    for (const k of keys) { const a = addressOf(k); if (a && reg.has(a.toLowerCase())) signs.push(...reg.get(a.toLowerCase())); }
    rows.push({ unit: u.unit, entry, uncovered, keys: [...keys].length, registeredWallets: [...new Set(signs)] });
  }
}
const risky = rows.filter((r) => r.registeredWallets.length);
const keyOf = (r) => r.unit + ' | ' + r.entry;
if (process.argv.includes('--json')) { console.log(JSON.stringify({ at: new Date().toISOString(), rows }, null, 1)); process.exit(0); }
if (process.argv.includes('--baseline')) {
  const prev = (() => { try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')).items || {}; } catch (e) { return {}; } })();
  const items = {}; for (const r of risky) items[keyOf(r)] = prev[keyOf(r)] || 'live on ' + new Date().toISOString().slice(0, 10) + ', not yet reviewed: signs for ' + r.registeredWallets.join(', ') + ' and records nothing';
  fs.writeFileSync(BASELINE, JSON.stringify({ written: new Date().toISOString(), note: 'Live units whose senders can sign for a registered wallet and do not record what they send, each with the reason it is tolerated. Shrink it; a new one fails nightwatch.', items }, null, 1));
  console.log('baseline written: ' + risky.length + ' live unrecorded signer(s) of registered wallets'); process.exit(0);
}
let base = {}; try { base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).items || {}; } catch (e) { console.log('FAIL no baseline at ' + BASELINE + ' (run with --baseline once)'); process.exit(1); }
const fresh = risky.filter((r) => !(keyOf(r) in base));
const gone = Object.keys(base).filter((k) => !risky.some((r) => keyOf(r) === k));
console.log('live units with an unrecorded sender: ' + rows.length + ', of which can sign for a registered wallet: ' + risky.length + ' (' + (risky.length - fresh.length) + ' in the baseline)');
for (const k of gone) console.log('note: ' + k + ' no longer a live unrecorded signer; remove it from the baseline');
for (const r of fresh) console.log('FAIL ' + r.unit + ' runs ' + r.entry + ': it can sign for ' + r.registeredWallets.join(', ') + ' and these send without recording: ' + r.uncovered.join(', '));
if (fresh.length) process.exit(1);
console.log('PASS: no new live sender signs for a watched wallet without recording');
