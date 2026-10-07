/* APEX Watchtower score, rubric "apex-watch v1" (2026-10-07, Martin: "write a program which rates everybody fairly").
 * One deterministic 0-100 score per Arc agent, built only from what the watchtower MEASURED (core/arc/agent-watch.js, hourly)
 * and what the chain shows (outside payers). The same file runs in the browser (window.ApexFairScore, the board at /arc/agents/)
 * and in node (core/arc/fair-rate.js, which writes the score to Arc's ERC-8004 reputation registry), so the number on the page
 * and the number on chain cannot drift.
 *   15  file       the registration file can be read
 *   10  endpoints  it lists at least one service we can call
 *   35  answers    share of measured hours it answered over 7 days (needs 6+ measured hours; fewer: its state right now)
 *   15  arcPay     it offers an x402 payment on Arc that can actually be signed (5 if offered but broken)
 *   10  domain     every domain it names is verified: each site points back to this agent
 *    5  speed      typical answer from our server: up to 1 s = 5, up to 3 s = 3
 *   10  customers  outside wallets paid it on Arc: 3+ with no single payer at 90% = 10, at least 1 (or Circle Gateway credits) = 5
 * Points are given only for what we could verify: a check we could not complete (payment terms a GET cannot read) earns nothing
 * and is not called a failure. An agent we could not check yet gets no "answers" points and is marked partial: a partial score
 * is shown, never written on chain.
 * Agent pages are free to read; nothing about the score depends on whether an agent rates us.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ApexFairScore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var RUBRIC = [
    { key: 'file', max: 15, label: 'Registration file readable' },
    { key: 'endpoints', max: 10, label: 'Lists a service we can call' },
    { key: 'answers', max: 35, label: 'Answered our hourly checks (7 days)' },
    { key: 'arcPay', max: 15, label: 'Arc payment offer verified by our check (x402)' },
    { key: 'domain', max: 10, label: 'Domain verified' },
    { key: 'speed', max: 5, label: 'Answers fast' },
    { key: 'customers', max: 10, label: 'Outside payers seen on Arc' }
  ];
  var VERSION = 'apex-watch-v1';
  // a: one agent as the watchtower stores it (data/protected/arc-agent-watch.json) or as /api/arc/watch serves it.
  // earned: { distinctPayers, topPayerShare } from the earnings index, when known. gateway: { credits } (Circle Gateway batches:
  // the chain shows that customers paid, not who they are, so they count as "at least 1", never as 3+).
  function score(a, earned, gateway) {
    var b = {}, notes = [], partial = false;
    var hasFile = a.file && typeof a.file === 'object' && 'has' in a.file ? !!a.file.has : (a.hasFile != null ? !!a.hasFile : a.status !== 'no-file');
    b.file = hasFile && a.status !== 'no-file' ? 15 : 0;
    b.endpoints = a.status && a.status !== 'listed' && a.status !== 'no-file' ? 10 : 0;
    var n7 = Number(a.samples7d) || 0;
    if (n7 >= 6 && a.uptime7d != null) { b.answers = Math.round(35 * Number(a.uptime7d) / 100); notes.push(a.uptime7d + '% of ' + n7 + ' measured hours'); }
    else if (a.status === 'up') { b.answers = 35; notes.push('answering now (' + n7 + ' measured hours so far)'); }
    else if (a.status === 'degraded') { b.answers = 17; notes.push('partly answering now'); }
    else if (a.status === 'down') { b.answers = 0; notes.push('not answering now'); }
    else { b.answers = 0; if (b.endpoints) { partial = true; notes.push('not checked yet'); } }
    var p = a.arcPayable;
    b.arcPay = p ? (p.signable ? 15 : 5) : 0;
    var doms = a.domains || [];
    b.domain = doms.length && doms.every(function (d) { return d && d.verified === true; }) ? 10 : 0;
    var ms = a.p50Ms == null ? null : Number(a.p50Ms);
    b.speed = ms == null || !(b.answers > 0) ? 0 : ms <= 1000 ? 5 : ms <= 3000 ? 3 : 0;
    var e = earned || (a.earnings && a.earnings.earned) || null, payers = e ? Number(e.distinctPayers) || 0 : 0;
    var gw = gateway || (a.earnings && a.earnings.gateway) || null;
    b.customers = payers >= 3 && Number(e.topPayerShare) < 0.9 ? 10 : payers >= 1 ? 5 : (gw && Number(gw.credits) > 0 ? 5 : 0);
    var total = 0; for (var i = 0; i < RUBRIC.length; i++) total += b[RUBRIC[i].key];
    return { score: total, partial: partial, breakdown: b, notes: notes, version: VERSION };
  }
  return { score: score, RUBRIC: RUBRIC, VERSION: VERSION };
});
