#!/usr/bin/env node
'use strict';
// ACCOUNT LAYER sandbox self-test (rewritten 2026-09-29 after the Fable review: the first version counted a missing path
// as hidden and never tested uid, /proc, sockets or localhost). Prints every probe; exit 1 if any fails.
// Run inside:  sudo tools/account-run.sh /usr/bin/node lib/account/sandbox-selftest.js   -> must print SANDBOX OK
// Run outside: node lib/account/sandbox-selftest.js                                         -> must FAIL (planted check)
const { probe } = require('/root/apex-faucet/lib/account/assert-sandboxed.js');
const fs = require('fs');
(async () => {
  const r = await probe();
  // the inputs it needs must still be readable, and the databases must open read-only
  const need = fs.readFileSync('/root/apex-faucet/lib/account/sandbox-allow.txt', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && !l.endsWith('*') && !/-(wal|shm)$/.test(l));
  const missing = need.filter((p) => { try { fs.accessSync(p, fs.constants.R_OK); return false; } catch (e) { return true; } });
  r.push({ name: 'every allowlisted input is readable', ok: missing.length === 0, detail: missing.join(', ') || need.length + ' paths' });
  try {
    const { openReadOnly } = require('/root/apex-faucet/lib/account/db.js');
    const EXT = require('/root/apex-faucet/lib/account/extract.js');
    const c = await EXT.check();
    r.push({ name: 'reads the column-limited extract; every table copied completely', ok: c.tables > 0 && c.problems.filter((p) => !/min old/.test(p)).length === 0, detail: c.tables + ' tables, ' + (c.ageMin == null ? '?' : Math.round(c.ageMin)) + ' min old' + (c.problems.length ? '; ' + c.problems.join('; ') : '') });
  } catch (e) { r.push({ name: 'opens the databases read-only', ok: false, detail: e.message }); }
  // egress (review A1): through the proxy an allowlisted RPC answers; anything else is refused
  try {
    const rs = await fetch('https://rpc.mainnet.x1.xyz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }), signal: AbortSignal.timeout(20000) });
    const j = await rs.json();
    r.push({ name: 'an allowlisted RPC answers through the egress proxy', ok: typeof j.result === 'number', detail: 'X1 slot ' + j.result });
  } catch (e) { r.push({ name: 'an allowlisted RPC answers through the egress proxy', ok: false, detail: String(e.cause && e.cause.message || e.message) }); }
  let other = 'REACHED'; const t0 = Date.now();
  try { await fetch('https://example.com/', { signal: AbortSignal.timeout(15000) }); } catch (e) { other = String((e.cause && (e.cause.code || e.cause.message)) || e.message).slice(0, 60); }
  const ms = Date.now() - t0;   // a refusal is immediate; a timeout would mean something else is wrong
  r.push({ name: 'a host NOT on the allowlist is refused at once by the proxy (example.com)', ok: other !== 'REACHED' && ms < 10000, detail: other + ' after ' + ms + ' ms' });
  const bridgePort = Number((/:(\d+)\/?$/.exec(String(process.env.HTTPS_PROXY || '')) || [])[1]);   // the launcher's bridge
  const raw = (line) => new Promise((ok) => { const c = require('net').connect(bridgePort, '127.0.0.1', () => c.write(line + '\r\n\r\n')); let b = ''; c.on('data', (d) => { b += d; }); c.on('end', () => ok(b.split('\r\n')[0])); c.on('error', (e) => ok('ERR ' + e.code)); setTimeout(() => { c.destroy(); ok(b.split('\r\n')[0] || 'TIMEOUT'); }, 8000); });
  const p80 = await raw('CONNECT apexfaucet.xyz:80 HTTP/1.1\r\nHost: apexfaucet.xyz:80');
  r.push({ name: 'an allowlisted host on a port other than 443 is refused', ok: / 403 /.test(p80), detail: p80 });
  const plain = await raw('GET http://apexfaucet.xyz/ HTTP/1.1\r\nHost: apexfaucet.xyz');
  r.push({ name: 'a plain (non-CONNECT) proxy request is refused', ok: / 403 /.test(plain), detail: plain });
  const own = await raw('CONNECT apexfaucet.xyz:443 HTTP/1.1\r\nHost: apexfaucet.xyz:443');
  r.push({ name: 'our own site is refused too (no two-way channel out; review 3 L1)', ok: / 403 /.test(own), detail: own });
  // an idle connection must be reaped by the proxy (review 3 H1: before, 64 silent sockets jammed it for good)
  const idle = await new Promise((ok) => { const t0 = Date.now(); const c = require('net').connect(bridgePort, '127.0.0.1'); c.on('close', () => ok(Date.now() - t0)); c.on('error', () => {}); setTimeout(() => { c.destroy(); ok(-1); }, 40000); });
  r.push({ name: 'an idle connection is closed by the proxy within 30 s', ok: idle > 0 && idle < 30000, detail: idle < 0 ? 'still open after 40 s' : 'closed after ' + Math.round(idle / 1000) + ' s' });
  // a connection that trickles a header one byte at a time is closed at the same absolute deadline (09-29 load test: 34 s before)
  const trickle = await new Promise((ok) => { const t0 = Date.now(); const c = require('net').connect(bridgePort, '127.0.0.1'); const hdr = 'CONNECT rpc.mainnet.x1.xyz:443 HTTP/1.1\r\nX-Pad: ' + 'a'.repeat(100); let i = 0;
    const iv = setInterval(() => { try { c.write(hdr[i++ % hdr.length]); } catch (e) {} }, 2000); c.on('close', () => { clearInterval(iv); ok(Date.now() - t0); }); c.on('error', () => {}); setTimeout(() => { clearInterval(iv); c.destroy(); ok(-1); }, 40000); });
  r.push({ name: 'a slowly trickled header is closed at the 15 s deadline (not reset by each byte)', ok: trickle > 0 && trickle < 20000, detail: trickle < 0 ? 'still open after 40 s' : 'closed after ' + Math.round(trickle / 1000) + ' s' });
  for (const x of r) console.log((x.ok ? '  ok    ' : '  FAIL  ') + x.name + '  (' + x.detail + ')');
  const bad = r.filter((x) => !x.ok).length;
  console.log(bad ? 'SANDBOX NOT SAFE: ' + bad + ' failed' : 'SANDBOX OK');
  process.exit(bad ? 1 : 0);
})();
