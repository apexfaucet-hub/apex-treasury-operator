#!/usr/bin/env node
'use strict';
// ACCOUNT LAYER: close OLD, TINY unrecorded-outflow alerts with a stated explanation (2026-10-07). The books flagged 14 X1
// outflows from 29 Sep to 6 Oct (forge bounty posts from BRBgaxdm, faucet ATA creations from HYiep, one metadata create):
// network fees and rent of our own bots from BEFORE their senders got the ledger recorder (installed 6 Oct 06:45 UTC).
// The recorder's rule stands: a ledger is never back-filled from chain history (that would "explain" a drain as well). So the
// alerts are not explained by fake ledger rows; they are closed by a recorded human decision, like account-retract.js:
// a run of kind 'explain' whose summary carries the reason and each alert, and every alert's superseded_by points at it.
// Hard limits, enforced here: kind unrecorded-outflow only; each alert at most $0.05; raised before --before; the reason
// names what the transactions were (20+ characters). Anything else is refused.
// Usage (inside the sandbox): account-explain.js --ids 316,317 --before 2026-10-06T06:45:00Z --reason "..."
const { open } = require('/root/apex-faucet/lib/account/db.js');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const MAX_USD = 0.05;
(async () => {
  await require('/root/apex-faucet/lib/account/assert-sandboxed.js').assertSandboxed();   // refuses to run outside the account sandbox
  const ids = String(arg('--ids') || '').split(',').map(Number).filter((n) => n > 0);
  const before = Date.parse(String(arg('--before') || ''));
  const reason = String(arg('--reason') || '');
  if (!ids.length || !Number.isFinite(before) || reason.length < 20) { console.error('usage: --ids a,b --before <ISO time> --reason "<what these were, 20+ chars>"'); process.exit(2); }
  const db = open(); await db.init();
  const rows = [];
  for (const id of ids) {
    const a = await db.get('SELECT alert_id, at, run_id, kind, chain, wallet_id, tx, amount_usd, superseded_by FROM alerts WHERE alert_id=?', [id]);
    if (!a) { console.error('REFUSED: no alert ' + id); process.exit(3); }
    if (a.superseded_by != null) { console.error('REFUSED: alert ' + id + ' is already closed'); process.exit(3); }
    if (a.kind !== 'unrecorded-outflow') { console.error('REFUSED: alert ' + id + ' is a ' + a.kind + ', only unrecorded-outflow can be explained this way'); process.exit(3); }
    if (!(Math.abs(Number(a.amount_usd)) <= MAX_USD)) { console.error('REFUSED: alert ' + id + ' is $' + a.amount_usd + ', over the $' + MAX_USD + ' limit'); process.exit(3); }
    if (!(Date.parse(a.at) < before)) { console.error('REFUSED: alert ' + id + ' was raised at ' + a.at + ', not before ' + new Date(before).toISOString()); process.exit(3); }
    rows.push(a);
  }
  const now = new Date().toISOString();
  const runId = (await db.run('INSERT INTO runs (kind, started_at, finished_at, method_version, complete, summary_json) VALUES (?,?,?,?,?,?)',
    ['explain', now, now, 1, 1, JSON.stringify({ reason, before: new Date(before).toISOString(), alerts: rows.map((a) => ({ id: a.alert_id, run: a.run_id, chain: a.chain, wallet: a.wallet_id, tx: a.tx, usd: a.amount_usd })) })])).lastID;
  for (const a of rows) await db.run('UPDATE alerts SET superseded_by=? WHERE alert_id=?', [runId, a.alert_id]);
  console.log(JSON.stringify({ explainRun: runId, closed: rows.map((a) => a.alert_id), totalUsd: +rows.reduce((t, a) => t + Number(a.amount_usd), 0).toFixed(5), reason }, null, 1));
})().catch((e) => { console.error('EXPLAIN FAILED: ' + e.message); process.exit(1); });
