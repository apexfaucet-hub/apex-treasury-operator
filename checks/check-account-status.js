#!/usr/bin/env node
'use strict';
// ACCOUNT STATUS -> a human (2026-10-06, Fable review gap 2: "nobody is paged"). Nightwatch check "account-status".
// The account layer (sandboxed, report-only) writes data/protected/account/summary.json every 2 hours. Nothing told a human
// when it stopped, ran incomplete, or found a NEW unexplained outflow. This check FAILS (and nightwatch messages the private
// channel at once) when:
//   - the summary is missing or unreadable;
//   - it is past its own expires_at by more than 30 minutes (the cycle stopped);
//   - the last two scheduled cycles were incomplete;
//   - an alert appears that was not there before (new keys only: alerts already seen do not page again, so the channel is
//     not told the same 20 things every 3 hours - an alarm that is always on hides the real one).
// Seen alert keys live in data/nightwatch/.account-status-seen.json. Overrides for planted tests: ACCOUNT_SUMMARY, ACCOUNT_SEEN.
// Usage: node tools/check-account-status.js [--seed]   (--seed records the current alerts as seen and exits 0)
const fs = require('fs');
const SUMMARY = process.env.ACCOUNT_SUMMARY || '/root/apex-faucet/data/protected/account/summary.json';
const SEEN = process.env.ACCOUNT_SEEN || '/root/apex-faucet/data/nightwatch/.account-status-seen.json';
const GRACE_MIN = 30;
const fail = [];
let s = null;
try { s = JSON.parse(fs.readFileSync(SUMMARY, 'utf8')); } catch (e) { fail.push('summary unreadable: ' + (e.code || e.message)); }
if (s) {
  const exp = Date.parse(s.expires_at);
  if (!Number.isFinite(exp)) fail.push('summary has no valid expires_at');
  else if (Date.now() > exp + GRACE_MIN * 60000) fail.push('the account cycle stopped: summary expired ' + s.expires_at + ' (generated ' + s.generated_at + ')');
  // incomplete TWICE in a row (Fable's spec): one incomplete cycle is usually a blip (6 Oct 11:35: a 5% XNT price move between
  // two reads); two in a row means a step is broken. Read from the cycle history the export writes.
  if (s.complete !== true) {
    let hist = [];
    try { hist = fs.readFileSync(process.env.ACCOUNT_CYCLES || '/root/apex-faucet/data/protected/account/cycles.ndjson', 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.trigger === 'timer'); } catch (e) {}
    const last2 = hist.slice(-2);
    if (last2.length < 2 || last2.every((c) => c.status === 'incomplete')) fail.push('the account cycle was incomplete twice in a row (steps ' + JSON.stringify((s.cycle || {}).steps || {}) + ')');
    else console.log('NOTE the last account cycle was incomplete (steps ' + JSON.stringify((s.cycle || {}).steps || {}) + '); the one before was not: not alerted yet');
  }
  const items = (s.alerts && Array.isArray(s.alerts.items)) ? s.alerts.items : null;
  if (!items) fail.push('summary has no alert list');
  else {
    // amount too: alerts without a tx would otherwise collapse to one per wallet (Fable review NOTE)
    const key = (a) => [a.kind, a.chain, a.wallet, a.tx, a.amount_usd].join('|');
    let seen = []; try { seen = JSON.parse(fs.readFileSync(SEEN, 'utf8')).keys || []; } catch (e) { if (e.code !== 'ENOENT') fail.push('seen-state unreadable: ' + (e.code || e.message)); }
    const seenSet = new Set(seen);
    const fresh = items.filter((a) => !seenSet.has(key(a)));
    if (process.argv.includes('--seed') || fresh.length) {
      const keys = [...new Set([...seen, ...items.map(key)])].slice(-2000);
      try { fs.writeFileSync(SEEN + '.tmp', JSON.stringify({ updated: new Date().toISOString(), keys }, null, 1)); fs.renameSync(SEEN + '.tmp', SEEN); }
      catch (e) { fail.push('could not record seen alerts: ' + (e.code || e.message)); }
    }
    if (fresh.length && !process.argv.includes('--seed')) {
      fail.push(fresh.length + ' NEW account alert' + (fresh.length === 1 ? '' : 's') + ': ' + fresh.slice(0, 5).map((a) => a.kind + ' ' + a.chain + ' ' + String(a.wallet).replace(/^.*\//, '') + ' ' + (a.amount_usd != null ? Number(a.amount_usd).toFixed(4) + ' USD' : '') + ' tx ' + a.tx).join('; ') + (fresh.length > 5 ? ' …' : ''));
    }
    console.log('account: status ' + s.status + ', ' + (s.alerts.open != null ? s.alerts.open : items.length) + ' open alerts (' + fresh.length + ' new), readiness ' + ((s.readiness || {}).consecutive_clean_scheduled_cycles) + '/' + ((s.readiness || {}).required_before_consumers) + ', summary ' + s.generated_at);
  }
}
if (fail.length) { for (const f of fail) console.log('FAIL ' + f); process.exit(1); }
console.log('OK   account cycle current, no new alerts, no repeated incomplete cycle');
