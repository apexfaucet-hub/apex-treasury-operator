#!/usr/bin/env node
'use strict';
// ACCOUNT LAYER export (2026-09-29): the ONE thing consumers may read. Consumers never open account.db (apex-account, 700).
// Runs inside the sandbox at the end of every cycle; writes data/protected/account/summary.json and appends one line to
// data/protected/account/cycles.ndjson. The root side (account-cycle.sh) validates it with validate-summary.js and only
// then publishes it to data/account-summary.json (root:claudeuser 640, outside every web root).
//
// The rule consumers rely on: a cycle that is not complete carries NO NAV numbers (nav: null, status 'incomplete' or
// 'failed'). "Could not read it" is never rendered as a number (CLAUDE.md §1).
//
// Usage: account-export.js --steps '{"extract":0,"snapshot":0,"verify":0,"ingest":0,"reconcile":0}' --trigger timer|manual
//        --cycle-start ISO [--out FILE] [--history FILE]      (env ACCOUNT_DB selects another database, for tests)
const fs = require('fs');
const path = require('path');
const R = require('/root/apex-faucet/lib/account/registry.js');
const { open } = require('/root/apex-faucet/lib/account/db.js');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const SCHEMA = 'apex-account-summary', VERSION = 1;
const SNAPSHOT_MAX_AGE_MIN = 150;   // one 2-hour cycle plus margin

(async () => {
  await require('/root/apex-faucet/lib/account/assert-sandboxed.js').assertSandboxed();   // refuses to run outside tools/account-run.sh
  const steps = JSON.parse(arg('--steps') || '{}');
  const trigger = arg('--trigger') === 'timer' ? 'timer' : 'manual';
  const cycleStart = arg('--cycle-start') || new Date().toISOString();
  const OUT = arg('--out') || path.join(R.DIR, 'summary.json');
  const HIST = arg('--history') || path.join(R.DIR, 'cycles.ndjson');
  const db = open(); await db.init();
  const now = Date.now();
  const ageMin = (iso) => (iso ? +((now - Date.parse(iso)) / 60000).toFixed(1) : null);
  const notes = [];

  // latest snapshot and whether IT was verified
  const snap = await db.get("SELECT run_id, started_at, finished_at, method_version, complete FROM runs WHERE kind='snapshot' ORDER BY run_id DESC LIMIT 1");
  let verified = null;
  if (snap && fs.existsSync(path.join(R.DIR, 'verify-' + snap.run_id + '.json'))) {
    try { verified = JSON.parse(fs.readFileSync(path.join(R.DIR, 'verify-' + snap.run_id + '.json'), 'utf8')).ok === true; } catch (e) { verified = false; }
  }
  const snapFresh = !!snap && ageMin(snap.started_at) <= SNAPSHOT_MAX_AGE_MIN;
  const navOk = !!snap && snap.complete === 1 && verified === true && snapFresh && snap.method_version >= 2;
  let nav = null;
  if (navOk) {
    const n = await db.get('SELECT * FROM nav WHERE run_id=?', [snap.run_id]);
    if (n && n.complete === 1) {
      nav = { spot_usd: n.spot_usd, spot_ex_self_priced_usd: n.spot_ex_self_priced_usd, liquid_usd: n.liquid_usd,
        by_owner_class: JSON.parse(n.by_owner_class || '{}'), by_chain: JSON.parse(n.by_chain || '{}'),
        coverage: JSON.parse(n.coverage || '[]'), unpriced_count: (JSON.parse(n.unpriced || '[]') || []).length };
    }
  }
  if (!nav) notes.push('no NAV: ' + (!snap ? 'no snapshot' : snap.complete !== 1 ? 'latest snapshot incomplete' : verified !== true ? 'latest snapshot not verified' : !snapFresh ? 'latest snapshot older than ' + SNAPSHOT_MAX_AGE_MIN + ' min' : 'method or NAV row incomplete'));

  // latest reconcile between snapshots (history windows from tests are not the cycle's reconciliation)
  const rec = await db.get("SELECT run_id, started_at, complete, summary_json FROM runs WHERE kind='reconcile' AND json_extract(summary_json,'$.window.mode')='snapshots' ORDER BY run_id DESC LIMIT 1");
  let reconcile = null;
  if (rec) {
    const s = JSON.parse(rec.summary_json || '{}');
    reconcile = { run_id: rec.run_id, complete: rec.complete === 1, window: { open: s.window && s.window.open, close: s.window && s.window.close, open_run: s.window && s.window.openRun, close_run: s.window && s.window.closeRun },
      pairs: s.pairs, status_counts: s.status, new_alerts: s.alerts, method_version: s.methodVersion, age_min: ageMin(rec.started_at),
      covers_latest_snapshot: !!(snap && s.window && s.window.closeRun === snap.run_id) };
    if (!reconcile.covers_latest_snapshot) notes.push('the latest reconciliation does not end at the latest snapshot');
  } else notes.push('no reconciliation between snapshots yet');

  // open alerts (never deleted; closed only by a later run that explains them)
  const byId = new Map(R.load().entries.map((e) => [e.id, e]));
  const open_ = await db.all('SELECT kind, chain, wallet_id, tx, amount_usd FROM alerts WHERE superseded_by IS NULL ORDER BY alert_id');
  const alerts = { open: open_.length, items: open_.slice(0, 20).map((a) => ({ kind: a.kind, chain: a.chain, wallet: (byId.get(a.wallet_id) || {}).label || 'unregistered',
    amount_usd: a.amount_usd, tx: String(a.tx || '').slice(0, 14) })) };

  const ing = await db.get("SELECT run_id, complete, summary_json FROM runs WHERE kind='ingest' ORDER BY run_id DESC LIMIT 1");
  const is = ing ? JSON.parse(ing.summary_json || '{}') : {};
  const ingest = ing ? { run_id: ing.run_id, complete: ing.complete === 1, ledger_rows: is.ledgerTotal, quarantined: (is.quarantined || []).length } : null;
  const extract = is.extract || null;

  const stepCodes = ['site', 'extract', 'snapshot', 'verify', 'ingest', 'reconcile'].map((k) => [k, steps[k]]);
  const stepsFailed = stepCodes.filter(([k, v]) => !(v === 0 || (k === 'reconcile' && v === 2)));
  const complete = navOk && !!nav && !!reconcile && reconcile.complete && reconcile.covers_latest_snapshot && !!ingest && ingest.complete && stepsFailed.length === 0;
  // THE rule: a cycle that did not complete carries no NAV numbers, even if an older part of it had some
  if (!complete && nav) { nav = null; notes.push('NAV withheld: the cycle did not complete (' + (stepsFailed.map(([k, v]) => k + '=' + v).join(', ') || 'reconciliation or ingest incomplete') + ')'); }
  const status = !complete ? 'incomplete' : alerts.open > 0 || steps.reconcile === 2 ? 'alert' : 'ok';
  const clean = status === 'ok' && stepCodes.every(([, v]) => v === 0) && !!extract && extract.ok === true;

  // cycle history, and the readiness count consumers wait for: consecutive clean cycles STARTED BY THE TIMER
  const line = { at: new Date(now).toISOString(), cycle_start: cycleStart, trigger, steps, status, clean, snapshot_run: snap ? snap.run_id : null, reconcile_run: rec ? rec.run_id : null };
  fs.appendFileSync(HIST, JSON.stringify(line) + '\n');
  const hist = fs.readFileSync(HIST, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } });
  const run = require('/root/apex-faucet/lib/account/readiness.js').consecutiveCleanScheduled(hist);

  const summary = {
    schema: SCHEMA, version: VERSION, generated_at: new Date(now).toISOString(),
    // consumers treat a summary past expires_at as incomplete (a cycle that never came)
    expires_at: new Date(now + SNAPSHOT_MAX_AGE_MIN * 60e3).toISOString(),
    cycle: { started_at: cycleStart, trigger, steps },
    status, complete, clean,
    // informational: root's validate-summary.js overwrites this with ITS count from ITS history before publishing
    readiness: { consecutive_clean_scheduled_cycles: run, required_before_consumers: 6, ready: run >= 6, counted_by: 'sandbox (replaced by root on publish)' },
    snapshot: snap ? { run_id: snap.run_id, started_at: snap.started_at, age_min: ageMin(snap.started_at), method_version: snap.method_version, complete: snap.complete === 1, verified } : null,
    nav, reconcile, alerts, ingest, extract,
    notes,
  };
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(summary, null, 1)); fs.renameSync(tmp, OUT);
  await db.close();
  console.log(JSON.stringify({ out: OUT, status, complete, clean, readiness: summary.readiness }, null, 1));
  process.exit(0);
})().catch((e) => { console.error('EXPORT FAILED: ' + (e && e.stack || e)); process.exit(1); });
