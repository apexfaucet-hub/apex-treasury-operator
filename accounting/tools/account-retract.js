#!/usr/bin/env node
'use strict';
// ACCOUNT LAYER: retract alerts that a HAND-STARTED run created by a method error (2026-10-06). Never for an alert a scheduled
// cycle raised about real money: those close only when a later run explains them. Each retraction is a run of kind
// 'retract' whose summary_json carries the reason and the alert ids, and each alert's superseded_by points at that run, so
// the audit trail shows who closed what and why. Refuses an alert whose run is not listed in --hand-runs.
// Usage (inside the sandbox): account-retract.js --ids 336,350,351 --hand-runs 330,336 --reason "..."
const { open } = require('/root/apex-faucet/lib/account/db.js');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
(async () => {
  await require('/root/apex-faucet/lib/account/assert-sandboxed.js').assertSandboxed();   // refuses to run outside tools/account-run.sh
  const ids = String(arg('--ids') || '').split(',').map(Number).filter((n) => n > 0);
  const hand = new Set(String(arg('--hand-runs') || '').split(',').map(Number).filter((n) => n > 0));
  const reason = String(arg('--reason') || '');
  if (!ids.length || !hand.size || reason.length < 20) { console.error('usage: --ids a,b --hand-runs x,y --reason "<why, 20+ chars>"'); process.exit(2); }
  const db = open(); await db.init();
  const rows = [];
  for (const id of ids) {
    const a = await db.get('SELECT alert_id, run_id, kind, tx, superseded_by FROM alerts WHERE alert_id=?', [id]);
    if (!a) { console.error('REFUSED: no alert ' + id); process.exit(3); }
    if (a.superseded_by != null) { console.error('REFUSED: alert ' + id + ' is already closed'); process.exit(3); }
    if (!hand.has(a.run_id)) { console.error('REFUSED: alert ' + id + ' came from run ' + a.run_id + ', which is not a listed hand run'); process.exit(3); }
    rows.push(a);
  }
  const now = new Date().toISOString();
  const runId = (await db.run('INSERT INTO runs (kind, started_at, finished_at, method_version, complete, summary_json) VALUES (?,?,?,?,?,?)',
    ['retract', now, now, 1, 1, JSON.stringify({ reason, alerts: rows.map((a) => ({ id: a.alert_id, run: a.run_id, kind: a.kind, tx: a.tx })) })])).lastID;
  for (const a of rows) await db.run('UPDATE alerts SET superseded_by=? WHERE alert_id=?', [runId, a.alert_id]);
  console.log(JSON.stringify({ retractRun: runId, retracted: rows.map((a) => a.alert_id), reason }, null, 1));
})().catch((e) => { console.error('RETRACT FAILED: ' + e.message); process.exit(1); });
