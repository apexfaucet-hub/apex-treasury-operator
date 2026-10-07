#!/usr/bin/env node
'use strict';
// LEDGER COVERAGE SWEEP (2026-09-29, CLAUDE.md §20). The account layer alarms on any outflow no sender recorded; on
// 29 Sep three senders had never recorded anything and one hid its transaction inside a library call. This sweep makes
// the gap visible BEFORE the chain does: every server-side file that can send a transaction must either use
// lib/ledger-log.js or be listed, with a reason, in tools/ledger-coverage-baseline.json. A NEW sender that does neither
// fails the sweep (exit 1). Browser code under public/ is excluded: those transactions are signed by the user's own wallet.
//   node tools/sweep-ledger-coverage.js            check
//   node tools/sweep-ledger-coverage.js --baseline  (re)write the baseline from today's uncovered senders
const fs = require('fs');
const path = require('path');

const ROOTS = ['/root/apex-faucet', '/home/claudeuser/ghost-agent', '/home/claudeuser/core'];
const SKIP_DIR = /(^|\/)(node_modules|public|data|backups|\.git|pocket-site[^/]*|[^/]*\.prev-[^/]*|archive[^/]*|old|tmp)(\/|$)/;
const SKIP_FILE = /\.(bak|orig|prev)|\.bak-|-bak\.|\.test\.js$/;
const SEND = /\b(sendRawTransaction|sendAndConfirmTransaction|sendAndConfirmRawTransaction|sendTransaction|eth_sendRawTransaction|writeContract)\s*\(/;
const BASELINE = path.join(__dirname, 'ledger-coverage-baseline.json');

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (SKIP_DIR.test(p + (e.isDirectory() ? '/' : ''))) continue;
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.(c?js|mjs)$/.test(e.name) && !SKIP_FILE.test(e.name)) out.push(p);
  }
  return out;
}

const senders = [];
for (const r of ROOTS) for (const f of walk(r, [])) {
  let src = '';
  try { src = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
  if (f.endsWith('/lib/ledger-log.js') || f.endsWith('/lib/ledger-log-evm.js')) continue; // the recorders themselves (EVM one added 6 Oct)
  // hand-gate.js (7 Oct) records through lib/ledger-log-evm.js: a file is covered by it only if it also calls its record()
  if (SEND.test(src)) senders.push({ file: f, covered: /ledger-log(-evm)?(\.js)?['"]/.test(src) || (/hand-gate(\.js)?['"]/.test(src) && /\.record\(/.test(src)) });
}
const uncovered = senders.filter((s) => !s.covered).map((s) => s.file).sort();

if (process.argv.includes('--baseline')) {
  const prev = (() => { try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')).files || {}; } catch (e) { return {}; } })();
  const files = {};
  for (const f of uncovered) files[f] = prev[f] || 'existing sender on 2026-09-29, not yet reviewed: record its moves through lib/ledger-log.js or state here why none leave a registered wallet unexplained';
  fs.writeFileSync(BASELINE, JSON.stringify({ written: new Date().toISOString(), note: 'Senders that do not use lib/ledger-log.js, each with the reason it is tolerated. Shrink this list; never grow it without a reason.', files }, null, 1) + '\n');
  console.log('baseline written: ' + uncovered.length + ' uncovered sender(s), ' + senders.filter((s) => s.covered).length + ' covered');
  process.exit(0);
}

let base = {};
try { base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).files || {}; } catch (e) { console.error('FAIL: no baseline at ' + BASELINE + ' (run with --baseline once)'); process.exit(1); }
const fresh = uncovered.filter((f) => !(f in base));
const nowCovered = Object.keys(base).filter((f) => senders.some((s) => s.file === f && s.covered));
console.log('senders: ' + senders.length + ', using the ledger recorder: ' + senders.filter((s) => s.covered).length + ', tolerated by baseline: ' + (uncovered.length - fresh.length));
for (const f of nowCovered) console.log('note: ' + f + ' now uses the recorder; remove it from the baseline');
if (fresh.length) {
  for (const f of fresh) console.log('FAIL: ' + f + ' can send a transaction but neither records through lib/ledger-log.js nor is in the baseline');
  process.exit(1);
}
console.log('PASS: no new sender outside the ledger recorder');
