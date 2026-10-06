#!/usr/bin/env node
'use strict';
// SEND GATE -> a human (2026-10-06). Nightwatch check "send-gate" (alert at once). FAILS when the send gate
// (lib/arc-send-gate.js) wrote a deny or a would-deny that this check has not reported before, or when the gate's policy
// is unreadable. A deny means a sender tried to move money outside its written limits; a would-deny means a sender still in
// shadow mode did it and the money moved. Either one needs a human the same day. Seen rows: data/nightwatch/.send-gate-seen.json.
const fs = require('fs');
const LOG = process.env.SEND_GATE_LOG || '/root/apex-faucet/data/send-gate/log/decisions.ndjson';
const SEEN = process.env.SEND_GATE_SEEN || '/root/apex-faucet/data/nightwatch/.send-gate-seen.json';
const fail = [];
try { const p = JSON.parse(fs.readFileSync('/etc/apex/send-gate.json', 'utf8')); if (!p.senders) fail.push('policy has no senders'); if (p.kill_file && fs.existsSync(p.kill_file)) console.log('NOTE the kill file is present (' + p.kill_file + '): every gated send is stopped'); }
catch (e) { fail.push('policy unreadable: ' + (e.code || e.message)); }
let rows = [];
try { rows = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { if (e.code !== 'ENOENT') fail.push('decision log unreadable: ' + (e.code || e.message)); }
const key = (r) => r.at + '|' + r.source + '|' + r.to + '|' + r.usdc;
let seen = []; try { seen = JSON.parse(fs.readFileSync(SEEN, 'utf8')).keys || []; } catch (e) {}
const S = new Set(seen);
const bad = rows.filter((r) => (r.decision === 'deny' || r.decision === 'would-deny') && !S.has(key(r)));
if (bad.length) {
  fail.push(bad.length + ' new gate refusal(s): ' + bad.slice(0, 5).map((r) => r.decision + ' ' + r.source + ' ' + r.usdc + ' USDC -> ' + r.to + ' (' + (r.reasons || []).join('; ') + ')').join(' | '));
  try { fs.writeFileSync(SEEN + '.tmp', JSON.stringify({ updated: new Date().toISOString(), keys: [...seen, ...bad.map(key)].slice(-2000) })); fs.renameSync(SEEN + '.tmp', SEEN); } catch (e) { fail.push('seen-state not written: ' + e.message); }
}
// the chain-side twin of the gate (tools/arc-outflow-watch.js, every 15 min) must be running: a watch that stopped protects nothing
try { const w = JSON.parse(fs.readFileSync(process.env.ARC_WATCH_STATE || '/root/apex-faucet/data/arc-outflow-watch.json', 'utf8')); const age = (Date.now() - Date.parse(w.checkedAt)) / 60000; if (!(age < 60)) fail.push('the Arc outflow watch last ran ' + Math.round(age) + ' min ago (every 15 min expected)');
  if (w.secondOkAt === undefined || !(Date.now() - Date.parse(w.secondOkAt) < 3 * 3600000)) fail.push('the Arc outflow watch has had no second node confirm its reads for 3 h (last ' + (w.secondOkAt || 'never') + ')');
  if ((w.pending || []).length) fail.push('the Arc outflow watch holds ' + w.pending.length + ' alert(s) it could not deliver: ' + w.pending.slice(0, 3).map((b) => b.usdc + ' USDC -> ' + b.to + ' tx ' + b.tx).join(' | ')); }
catch (e) { fail.push('the Arc outflow watch state is unreadable: ' + (e.code || e.message)); }
const today = new Date().toISOString().slice(0, 10);
console.log('send gate: ' + rows.length + ' decisions logged, ' + rows.filter((r) => r.at.startsWith(today)).length + ' today, ' + bad.length + ' new refusals');
if (fail.length) { for (const f of fail) console.log('FAIL ' + f); process.exit(1); }
console.log('OK   no new refusals');
