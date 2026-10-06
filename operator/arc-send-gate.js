'use strict';
// ARC SEND GATE (2026-10-06, Fable review gap 5: "zero enforced per-transaction policy on any live Arc send").
// Every sender that moves VALUE out of one of our Arc (or Base) wallets asks this gate first, with what it is about to sign.
// Caps used to be constants inside each script; now they live in ONE file (data/send-gate/policy.json, root-owned) that the
// senders cannot raise, and one log (data/send-gate/log/decisions.ndjson) shows every decision.
//
//   const G = require('/root/apex-faucet/lib/arc-send-gate.js');
//   const d = G.check({ source: 'arc-gas-refill', chain: 'arc', chainId: 5042, from, to, usdc: 0.6 });
//   if (!d.allow) { ...do not sign... }
//
// A check fails closed: a missing or unreadable policy, an unknown sender, a kill file, a wrong chain id, a wallet the sender
// is not registered for, a destination not on the list, a per-transaction or per-day cap exceeded, or a lock it cannot take
// => deny. Each sender runs in one of two modes, set in the policy:
//   enforce  a deny returns allow:false and the caller must not sign;
//   shadow   a deny is logged as 'would-deny' and allow:true is returned, so a live money job is never stopped by a gate
//            nobody has watched yet. A sender moves from shadow to enforce only after a full cycle of it ran clean.
// Every deny and would-deny is loud: tools/check-send-gate.js (nightwatch "send-gate", alert at once) reports new ones.
// The per-day total counts only ALLOWED sends (a refused send moved nothing). It is kept in the decisions log itself, under
// a lock directory, so two processes (root app, claudeuser bots) cannot both spend the last of a day's cap.
// The gate protects only the code that calls it; tools/arc-outflow-watch.js watches the chain for everything else.
// What it defends against, stated plainly (Fable review, 6 Oct): bugs in a sender, and a key copied off this machine (the
// watch). NOT a compromise of the claudeuser account itself: the bots' keys, this log and the watch's records are all
// claudeuser-writable, so such an attacker can sign directly. The kill file stops only the senders listed in the policy.
const fs = require('fs');
const path = require('path');

const DIR = process.env.SEND_GATE_DIR || '/root/apex-faucet/data/send-gate';   // SEND_GATE_DIR: tests only
// The policy lives in /etc/apex (root-owned all the way up): /root/apex-faucet/data belongs to claudeuser, who could
// rename a directory there. The gate guards against a bug in a sender; a stolen key is the outflow watch's job.
const POLICY = process.env.SEND_GATE_POLICY || '/etc/apex/send-gate.json';   // SEND_GATE_POLICY: tests only
// The log and the lock sit in data/send-gate/log/, which both writers (root app, claudeuser bots) can append to.
const LOG = path.join(DIR, 'log', 'decisions.ndjson');
const LOCK = path.join(DIR, 'log', '.lock');
const lc = (a) => String(a || '').toLowerCase();
const day = (t) => new Date(t).toISOString().slice(0, 10);

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function withLock(fn) {
  for (let i = 0; i < 100; i++) {   // up to ~10 s
    try { fs.mkdirSync(LOCK); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 30000) { fs.rmdirSync(LOCK); continue; } } catch (_) {}   // a crashed holder
      sleepMs(100); continue;
    }
    try { return fn(); } finally { try { fs.rmdirSync(LOCK); } catch (_) {} }
  }
  throw new Error('send-gate lock busy for 10 s');
}
function readLog() {
  try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function append(row) {
  const fresh = !fs.existsSync(LOG);
  fs.appendFileSync(LOG, JSON.stringify(row) + '\n');
  if (fresh) { try { fs.chmodSync(LOG, 0o644); if (process.getuid && process.getuid() === 0) fs.chownSync(LOG, 1000, 1000); } catch (_) {} }
}

// Pure: the reasons a send breaks the policy (empty = allowed). Exported for the tests.
function reasons(policy, req, todayAllowedUsdc) {
  const r = [];
  if (!policy || typeof policy !== 'object' || !policy.senders) return ['policy missing or malformed'];
  if (policy.kill_file && fs.existsSync(policy.kill_file)) r.push('kill file present: ' + policy.kill_file);
  const s = policy.senders[req.source];
  if (!s) return r.concat(['unknown sender "' + req.source + '": add it to the policy first']);
  const chain = policy.chains && policy.chains[req.chain];
  if (!chain) r.push('chain ' + req.chain + ' not in the policy');
  else if (Number(req.chainId) !== Number(chain.id)) r.push('chain id ' + req.chainId + ' is not ' + req.chain + ' (' + chain.id + ')');
  if (!(s.wallets || []).map(lc).includes(lc(req.from))) r.push('wallet ' + req.from + ' is not registered for ' + req.source);
  // a sender may use the shared list only when its policy says so; otherwise only its own destinations
  const dest = Object.assign({}, s.global_destinations === true ? (policy.destinations || {}) : {}, s.destinations || {});
  if (!Object.keys(dest).map(lc).includes(lc(req.to))) r.push('destination ' + req.to + ' is not on the list');
  const usdc = Number(req.usdc);
  if (!(usdc >= 0)) r.push('amount missing or not a number');
  else {
    if (!(Number(s.per_tx_usdc) >= 0)) r.push('no per-transaction cap set for ' + req.source);
    else if (usdc > Number(s.per_tx_usdc)) r.push(usdc + ' USDC is over the per-transaction cap of ' + s.per_tx_usdc);
    if (!(Number(s.per_day_usdc) >= 0)) r.push('no per-day cap set for ' + req.source);
    else if (todayAllowedUsdc + usdc > Number(s.per_day_usdc)) r.push('today ' + todayAllowedUsdc + ' + ' + usdc + ' USDC is over the per-day cap of ' + s.per_day_usdc);
  }
  if (req.tokens && Object.keys(req.tokens).length) {
    const allowed = Object.keys(s.tokens || {}).map(lc);
    for (const [t, amt] of Object.entries(req.tokens)) {
      if (!allowed.includes(lc(t))) r.push('token ' + t + ' is not allowed for ' + req.source);
      else if (Number(amt) > Number(s.tokens[Object.keys(s.tokens).find((k) => lc(k) === lc(t))])) r.push('token ' + t + ': ' + amt + ' over its cap');
    }
  }
  return r;
}

// req: { source, chain, chainId, from, to, usdc, tokens?: { address: units }, purpose? }
// returns { allow, decision: 'allow'|'deny'|'would-deny', mode, reasons }
function check(req) {
  const at = new Date().toISOString();
  let policy = null, mode = 'enforce';
  try { policy = JSON.parse(fs.readFileSync(POLICY, 'utf8')); } catch (e) { policy = null; }
  if (policy && policy.senders && policy.senders[req.source] && policy.senders[req.source].mode === 'shadow') mode = 'shadow';
  try {
    return withLock(() => {
      const today = day(Date.now());
      const used = readLog().filter((d) => d.source === req.source && d.decision !== 'deny' && d.counted !== false && day(d.at) === today)
        .reduce((t, d) => t + (Number(d.usdc) || 0), 0);
      const why = reasons(policy, req, used);
      const decision = why.length ? (mode === 'shadow' ? 'would-deny' : 'deny') : 'allow';
      append({ at, source: req.source, chain: req.chain, from: lc(req.from), to: lc(req.to), usdc: Number(req.usdc), tokens: req.tokens || null, purpose: req.purpose || null, mode, decision, reasons: why });
      if (why.length) console.error('[send-gate] ' + decision.toUpperCase() + ' ' + req.source + ' ' + req.usdc + ' USDC -> ' + req.to + ': ' + why.join('; '));
      return { allow: decision !== 'deny', decision, mode, reasons: why };
    });
  } catch (e) {
    console.error('[send-gate] DENY (gate error, fail closed) ' + req.source + ': ' + e.message);
    try { append({ at, source: req.source, chain: req.chain, from: lc(req.from), to: lc(req.to), usdc: Number(req.usdc), mode, decision: mode === 'shadow' ? 'would-deny' : 'deny', reasons: ['gate error: ' + e.message] }); } catch (_) {}
    return { allow: mode === 'shadow', decision: mode === 'shadow' ? 'would-deny' : 'deny', mode, reasons: ['gate error: ' + e.message] };
  }
}

// After a send that the gate allowed did NOT happen (simulation failed, the caller gave up), give the amount back to the
// day's allowance: the caller records it so the cap counts only money that left.
function release(req, why) {
  try {
    withLock(() => {
      // never give back more than this sender actually took today for this destination (Fable review NOTE)
      const today = day(Date.now());
      const net = readLog().filter((d) => d.source === req.source && lc(d.to) === lc(req.to) && d.decision !== 'deny' && day(d.at) === today)
        .reduce((t, d) => t + (Number(d.usdc) || 0), 0);
      const back = Math.min(Math.abs(Number(req.usdc) || 0), Math.max(0, net));
      append({ at: new Date().toISOString(), source: req.source, chain: req.chain, from: lc(req.from), to: lc(req.to), usdc: -back, decision: 'release', reasons: [String(why || 'not sent')] });
    });
  }
  catch (e) { console.error('[send-gate] release not written: ' + e.message); }
}

module.exports = { check, release, reasons, DIR, POLICY, LOG };
