#!/usr/bin/env node
'use strict';
// BLANK PAID CALLS (2026-10-07). At 03:04 UTC a payment prober (Lumiere PayCheck, which scores every x402 endpoint in public)
// paid $0.003 for /api/x402/trade-rail-quote with no parameters: we settled the payment, then answered 400 ("chain must be
// arc, x1 or bnb"). Charged for a refusal. The rule since 22 Sep is that a call missing what it needs is refused BEFORE gate()
// takes money (preflight + QUERY_DOCS in x402-routes.js); this route was added on 6 Oct without its declaration.
// For every paid endpoint without a path parameter, this check asks two things:
//   1. the unpaid public answer: does preflight already refuse a blank call ("nothing has been charged")? then it is safe;
//   2. otherwise, what the INTERNAL route (the one the paid proxy calls after settling) answers to a blank call. A 4xx there
//      means a blank paid call is charged and then refused: FAIL (exit 1).
// The internal key goes only into a localhost request and is scrubbed from every message (post-mortem 30 Sep).
const fs = require('fs');
const X = require('/root/apex-faucet/x402-routes.js');
const KEY = fs.readFileSync('/root/apex-faucet/data/.internal-key', 'utf8').trim();
const scrub = (s) => String(s).split(KEY).join('[key]').split(encodeURIComponent(KEY)).join('[key]');
const PUBLIC = process.env.BLANK_CHECK_ORIGIN || 'http://127.0.0.1:3000';
(async () => {
  const bad = [], safe = [], ok = [], skipped = [];
  for (const ep of X.ENDPOINTS) {
    if (!ep.internal || ep.wantsParam || ep.method === 'POST' || /^POST/i.test(ep.method || '')) { skipped.push(ep.path); continue; }
    let pub;
    try {
      // x-real-ip is TEST-NET-1 (RFC 5737): never a real visitor, so no visitor count can mistake this check for one
      const r = await fetch(PUBLIC + ep.path, { headers: { 'user-agent': 'apex-blank-check/1.0', 'x-real-ip': '192.0.2.1' }, signal: AbortSignal.timeout(20000) });
      pub = { status: r.status, body: (await r.text()).slice(0, 4000) };
    } catch (e) { bad.push(ep.path + ': public answer unreadable (' + scrub(e.message) + ')'); continue; }
    if (/nothing (has been|was) charged/i.test(pub.body) && pub.status !== 200) { safe.push(ep.path); continue; }
    if (pub.status !== 402) { skipped.push(ep.path + ' (public ' + pub.status + ')'); continue; }
    try {
      const sep = ep.internal.includes('?') ? '&' : '?';
      const r = await fetch('http://127.0.0.1:3000' + ep.internal + sep + '__k=' + encodeURIComponent(KEY), { headers: { 'user-agent': 'apex-blank-check/1.0' }, signal: AbortSignal.timeout(60000) });
      const body = (await r.text()).slice(0, 300);
      if (r.status >= 400 && r.status < 500) bad.push(ep.path + ': a blank paid call would be charged, then the route answers ' + r.status + ' (' + scrub(body).replace(/\s+/g, ' ').slice(0, 120) + ')');
      else ok.push(ep.path + ' ' + r.status);
    } catch (e) { skipped.push(ep.path + ' (internal unreadable: ' + scrub(e.message).slice(0, 60) + ')'); }
  }
  console.log('paid endpoints: ' + X.ENDPOINTS.length + ' | blank call refused unpaid: ' + safe.length + ' | blank call answered: ' + ok.length + ' | skipped (path param, POST, or not a plain 402): ' + skipped.length);
  for (const b of bad) console.log('FAIL ' + b);
  if (bad.length) process.exit(1);
  console.log('PASS: no paid endpoint charges a blank call and then refuses it');
  process.exit(0);
})().catch((e) => { console.log('FAIL check crashed: ' + scrub(e.message)); process.exit(1); });
