'use strict';
// tests/annotation-filter.test.js (2026-10-06): the planted faults must be refused, the real annotations must all pass.
const fs = require('fs');
const { filterAnnotations } = require('/root/apex-faucet/lib/account/annotation-filter.js');
const W = '0x024b82335c29fa5606a8ea5c1d24fc9ead50700c';
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const t1 = '0x' + 'ab'.repeat(32), t2 = '0x' + 'cd'.repeat(32), t3 = '0x' + 'ef'.repeat(32);
const r = filterAnnotations([
  { tx: t1, chain: 'arc', wallet: W, amount: 1, category: 'internal:gas-topup' },
  { tx: t1, chain: 'arc', wallet: W, amount: 0.0004, category: 'internal:other' },
  { tx: t2, chain: 'arc', wallet: W, amount: 0.0004, category: 'cost:gas' },
  { tx: t3, chain: 'arc', wallet: W, amount: 1, category: 'internal:gas-topup', leg: 'value' },
  { tx: t3, chain: 'arc', wallet: W, amount: 0.2, category: 'internal:other', leg: 'second' },
  { tx: 'short', chain: 'arc', amount: 1 },
]);
ok(r.refused.filter((x) => x.startsWith(t1)).length === 2, 'two rows on one key: both refused');
ok(r.refused.some((x) => x.startsWith(t2) && /fee row/.test(x)), 'a fee row is refused');
ok(r.accepted.length === 2 && r.accepted.every((a) => a.tx === t3), 'distinct legs on one tx are accepted');
ok(!r.accepted.some((a) => a.tx === 'short'), 'a row without a full hash is ignored');
const t4 = '0x' + '12'.repeat(32);
ok(filterAnnotations([{ tx: t4, chain: 'arc', wallet: W, amount: 1, category: 'cost:gas-topup' }]).accepted.length === 1, 'cost:gas-topup is not mistaken for a fee row');
let real = [];
try { real = fs.readFileSync('/root/apex-faucet/data/protected/account/annotations.ndjson', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { ok(false, 'read the real annotations: ' + e.message); }
const rr = filterAnnotations(real);
ok(rr.refused.length === 0, 'the real annotations: none refused (' + rr.accepted.length + ' accepted)' + (rr.refused.length ? ': ' + rr.refused.join(', ') : ''));
process.exit(fail ? 1 : 0);
