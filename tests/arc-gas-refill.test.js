'use strict';
// tests/arc-gas-refill.test.js (2026-10-06): the refill's decisions for planted balances. Pure: signs and sends nothing.
const { plan } = require('/root/apex-faucet/tools/arc-gas-refill.js');
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const now = Date.parse('2026-10-06T12:00:00Z'), g = 0.0009, capUsdc = 1.2;
ok(plan({ opBal: 1.2, srcBal: 5, gasCost: g, now, capUsdc }).act === 'none', 'operator above its floor: nothing to do');
let p = plan({ opBal: 0.3, srcBal: 5, gasCost: g, now, capUsdc }); ok(p.act === 'send' && p.amount === 1.2, 'operator at 0.3: send 1.2 (the policy cap; target 1.5)');
p = plan({ opBal: 0.39, srcBal: 5, gasCost: g, now, capUsdc: 2 }); ok(p.act === 'send' && Math.abs(p.amount - 1.11) < 1e-9, 'a higher cap: send only up to the target 1.5 (' + p.amount + ')');
p = plan({ opBal: 0.3, srcBal: 0.6, gasCost: g, now, capUsdc }); ok(p.act === 'send' && p.amount < 0.3 && p.amount >= 0.1, 'a small source: send only what keeps 0.3 USDC in it (' + (p.amount) + ')');
p = plan({ opBal: 0.3, srcBal: 0.35, gasCost: g, now, capUsdc }); ok(p.act === 'refuse' && /keep 0.3/.test(p.reason), 'a source that cannot keep its reserve: refused');
p = plan({ opBal: 0.3, srcBal: 5, gasCost: g, lastSentAt: '2026-10-06T00:00:00Z', now, capUsdc }); ok(p.act === 'refuse' && p.drain, 'under the floor again within 24 h of a refill: refused as a suspected drain');
p = plan({ opBal: 0.3, srcBal: 5, gasCost: g, lastSentAt: '2026-10-05T11:00:00Z', now, capUsdc }); ok(p.act === 'send', 'more than 24 h after the last refill: allowed again');
p = plan({ opBal: 0, srcBal: NaN, gasCost: g, now, capUsdc }); ok(p.act === 'refuse', 'an unreadable source balance: refused');
p = plan({ opBal: 0.3, srcBal: 5, gasCost: g, now, capUsdc: null }); ok(p.act === 'refuse' && /no per-send cap/.test(p.reason), 'no cap in the policy: refused');
process.exit(fail ? 1 : 0);
