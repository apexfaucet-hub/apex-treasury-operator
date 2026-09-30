#!/usr/bin/env node
'use strict';
// ACCOUNT LAYER exit tests (2026-09-29). One command per phase; each prints PASS/FAIL per test and exits 1 on any
// failure. Run inside the account sandbox: sudo tools/account-run.sh node tools/account-exit-tests.js p1 [p2 p3 p4]
// A test that cannot fail is not a test (CLAUDE.md §17): each phase also has a planted-fault check where it matters.
const fs = require('fs');
const path = require('path');
const R = require('/root/apex-faucet/lib/account/registry.js');

let failed = 0;
// A consistent copy of account.db for planted faults. copyFileSync missed every row still in the -wal file (09-29: the
// planted tests hit an empty copy of the newest run and crashed instead of testing anything).
async function consistentCopy(dst) {
  const { open } = require('/root/apex-faucet/lib/account/db.js');
  try { fs.unlinkSync(dst); } catch (e) {}
  const src = open(); await src.init(); await src.run('VACUUM INTO ?', [dst]); await src.close();
}
const pass = (t, d) => console.log('  PASS  ' + t + (d ? '  (' + d + ')' : ''));
const fail = (t, d) => { failed++; console.log('  FAIL  ' + t + (d ? '  (' + d + ')' : '')); };
const check = (t, ok, d) => (ok ? pass(t, d) : fail(t, d));

const PHASES = {
  async p1() {
    console.log('P1 registry');
    let reg; try { reg = R.load(); pass('registry loads and validates', reg.entries.length + ' entries'); } catch (e) { fail('registry loads and validates', e.message); return; }
    const nav = JSON.parse(fs.readFileSync('/root/apex-faucet/data/treasury-nav-last.json', 'utf8'));
    const navAddrs = Object.keys(nav.per || {});
    const missing = navAddrs.filter((a) => !reg.entries.some((e) => e.chain === 'x1' && e.address === a));
    check('every X1 address treasury-nav knows is registered', missing.length === 0, navAddrs.length + ' known, ' + missing.length + ' missing');
    const need = [
      ['x1', 'faucet'], ['x1', 'founder'], ['x1', 'arena'], ['x1', 'trader'], ['x1', 'passport-hot'],
      ['arc', 'operator'], ['arc', 'receive'], ['arc', 'trader'], ['base', 'receive'], ['base', 'operator'],
      ['solana', 'faucet'], ['solana', 'fee-payer'],
    ];
    for (const [c, role] of need) check('has ' + c + ' ' + role, reg.entries.some((e) => e.chain === c && e.role === role));
    check('4 Arc LP positions registered', reg.entries.filter((e) => e.kind === 'lp-position').length === 4);
    check('faucet pot registered as program-locked', reg.entries.some((e) => e.owner_class === 'program-locked' && e.address.startsWith('1Wwdp3mi')));
    check('founder-personal wallets are registered apart from project money', reg.entries.some((e) => e.owner_class === 'founder-personal'));
    check('no founder-personal wallet has a key file on this server', reg.entries.filter((e) => e.owner_class === 'founder-personal').every((e) => !e.key_file_name));
    // No key material may ever enter the registry: no 64-byte arrays, no 32-byte hex secrets, no base58 64-byte strings.
    const raw = fs.readFileSync(R.FILE, 'utf8');
    const km = /\[\s*(\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]|0x[0-9a-fA-F]{64}\b|"[1-9A-HJ-NP-Za-km-z]{80,90}"/.test(raw);
    check('registry holds no key material', !km);
    // Planted fault: the same scanner must catch a fake key in a copy.
    const planted = raw.replace('"entries"', '"planted": [' + Array.from({ length: 64 }, (_, i) => i % 250).join(',') + '], "entries"');
    check('key-material scanner fires on a planted fake key', /\[\s*(\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/.test(planted));
    // The validator must reject a broken registry (planted fault).
    let rejected = false; try { R.validate({ entries: [{ id: 'x', chain: 'arc', kind: 'wallet', address: 'not-an-address', role: 'operator', owner_class: 'project' }] }); } catch (e) { rejected = true; }
    check('validator rejects a planted bad entry', rejected);
    const trader = reg.entries.find((e) => e.chain === 'arc' && e.role === 'trader');
    check('Arc trader resolved from chain', !!trader && /^0x0ba8/i.test(trader.address), trader ? trader.address : 'none');
    const unres = JSON.parse(fs.readFileSync(path.join(R.DIR, 'registry-unresolved.json'), 'utf8')).unresolved;
    check('unresolved list is written and short', Array.isArray(unres) && unres.length <= 3, unres.map((u) => u.what).join('; '));
  },
  async p2() {
    console.log('P2 snapshot + verification');
    const { open } = require('/root/apex-faucet/lib/account/db.js');
    const db = open(); await db.init();
    const run = await db.get("SELECT * FROM runs WHERE kind='snapshot' AND complete=1 ORDER BY run_id DESC LIMIT 1");
    check('a complete snapshot exists', !!run, run ? 'run ' + run.run_id + ' at ' + run.started_at : 'none');
    if (!run) { await db.close(); return; }
    const r = run.run_id;
    const failedRows = await db.get('SELECT COUNT(*) n FROM balances WHERE run_id=? AND ok=0', [r]);
    check('no failed read in that run', failedRows.n === 0, failedRows.n + ' failed');
    const zeroed = await db.get('SELECT COUNT(*) n FROM balances WHERE ok=0 AND (amount IS NOT NULL OR raw IS NOT NULL)');
    check('a failed read is never stored as a number (all runs)', zeroed.n === 0, zeroed.n + ' failed rows carrying a value');
    const observed = await db.get("SELECT COUNT(*) n FROM runs r WHERE complete=0 AND EXISTS (SELECT 1 FROM balances b WHERE b.run_id=r.run_id AND b.ok=0)");
    check('an observed failure made its run incomplete (real fault, run 2: X1 HTTP 429)', observed.n >= 1, observed.n + ' incomplete run(s) with failed reads');
    const chains = await db.all('SELECT chain, COUNT(*) n FROM balances WHERE run_id=? GROUP BY chain', [r]);
    check('balances on all four chains', ['x1', 'solana', 'arc', 'base'].every((c) => chains.some((x) => x.chain === c && x.n > 0)), chains.map((c) => c.chain + '=' + c.n).join(' '));
    const prices = await db.all('SELECT asset_id, method, source, source_detail FROM prices WHERE run_id=?', [r]);
    const bad = prices.filter((p) => !p.source || !p.method || (p.method === 'spot' && !/"(slot|block)"/.test(p.source_detail || '')));
    check('every price has method + source; every spot price its slot or block', bad.length === 0, prices.length + ' prices' + (bad.length ? ', missing: ' + bad.map((b) => b.asset_id).join(',') : ''));
    const pos = await db.all('SELECT mismatch FROM positions WHERE run_id=?', [r]);
    const expectPos = (JSON.parse(run.summary_json || '{}').positions);
    check('arc trader positions: every one in its state is read and equal to chain', pos.length > 0 && pos.length === expectPos && pos.every((p) => !p.mismatch), pos.length + ' positions, ' + pos.filter((p) => !p.mismatch).length + ' equal');
    const lp = await db.all('SELECT position_id, owner_matches, ok FROM lp_positions WHERE run_id=?', [r]);
    check('4 LP positions read, owners as registered', lp.length === 4 && lp.every((l) => l.ok && l.owner_matches === 1), lp.map((l) => '#' + l.position_id + ':' + l.owner_matches).join(' '));
    const nav = await db.get('SELECT * FROM nav WHERE run_id=?', [r]);
    const byOwner = JSON.parse(nav.by_owner_class || '{}');
    check('NAV split by owner class; founder and founder-personal apart from project', ['project', 'founder', 'founder-personal', 'program-locked', 'contract-held'].every((k) => byOwner[k]),
      'liquid ' + nav.liquid_usd + ' / spot ' + nav.spot_usd + ' (project liquid ' + (byOwner.project || {}).liquid_usd + ')');
    const vf = path.join(R.DIR, 'verify-' + r + '.json');
    let v = null; try { v = JSON.parse(fs.readFileSync(vf, 'utf8')); } catch (e) {}
    check('independent verification of that run passed', !!v && v.ok === true, v ? v.checks.filter((c) => c.ok).length + '/' + v.checks.length + ' checks' : 'no verify file for run ' + r);
    await db.close();
    // Planted fault: a copy of the DB with one Arc balance altered must make the verifier FAIL.
    const cp = require('child_process');
    const copy = path.join(R.DIR, 'planted-account.db');
    try { await consistentCopy(copy); } catch (e) { fail('planted copy', e.message); return; }
    const pdb = open(copy); await pdb.init();
    await pdb.run("UPDATE balances SET raw = CAST(CAST(raw AS INTEGER) + 1 AS TEXT) WHERE rowid = (SELECT rowid FROM balances WHERE run_id=? AND chain='arc' AND ok=1 LIMIT 1)", [r]);
    await pdb.close();
    fs.mkdirSync(path.join(R.DIR, 'planted-out'), { recursive: true });
    const res = cp.spawnSync('/usr/bin/node', ['/root/apex-faucet/tools/account-verify.js', String(r), '--only', 'arc'],
      { env: Object.assign({}, process.env, { ACCOUNT_DB: copy, ACCOUNT_VERIFY_OUT: path.join(R.DIR, 'planted-out') }), encoding: 'utf8', timeout: 300000 });
    check('planted fault: verifier FAILS on a copy with one Arc balance off by one unit', res.status === 1 && /FAIL\s+arc/.test(res.stdout), 'exit ' + res.status + ': ' + (res.stdout.match(/arc: every[^\n]*\n\s*([^\n]*)/) || [])[1]);
    // Planted fault 2 (Fable review finding 5): one X1 hot wallet's XNT off by ONE lamport must fail the exact-sum check.
    const pdb2 = open(copy); await pdb2.init();
    const hotRow = await pdb2.get("SELECT rowid, wallet_id FROM balances WHERE run_id=? AND chain='x1' AND ok=1 AND asset_id='x1:native' AND wallet_id='x1:HYiepS7mNC'", [r]);
    if (!hotRow) { fail('planted X1 fault', 'no x1 faucet native row in run ' + r + ' of the copy'); await pdb2.close(); return; }
    await pdb2.run("UPDATE balances SET raw = CAST(CAST(raw AS INTEGER) + 1 AS TEXT) WHERE rowid=?", [hotRow.rowid]);
    await pdb2.close();
    const res2 = cp.spawnSync('/usr/bin/node', ['/root/apex-faucet/tools/account-verify.js', String(r), '--only', 'x1', '--x1-sample', '0'],
      { env: Object.assign({}, process.env, { ACCOUNT_DB: copy, ACCOUNT_VERIFY_OUT: path.join(R.DIR, 'planted-out') }), encoding: 'utf8', timeout: 600000 });
    check('planted fault: verifier FAILS on a copy with the X1 faucet wallet off by one lamport', res2.status === 1 && /FAIL\s+x1/.test(res2.stdout) && /HYiepS7mNC/.test(res2.stdout),
      'exit ' + res2.status + ': ' + ((res2.stdout.match(/UNEXPLAINED: ([^\n]{0,140})/) || [])[1] || res2.stdout.slice(-200)));
    try { fs.unlinkSync(copy); for (const f of ['-wal', '-shm']) { try { fs.unlinkSync(copy + f); } catch (e) {} } fs.rmSync(path.join(R.DIR, 'planted-out'), { recursive: true, force: true }); } catch (e) {}
  },
  async p3() {
    console.log('P3 normalized ledger');
    // The ingest runs first, twice: the second run must change nothing (idempotent). Every count and sum below is then
    // re-derived from the SOURCES with code of its own; nothing here imports tools/account-ingest.js (§17).
    const cp = require('child_process');
    const ing = () => { const r = cp.spawnSync('/usr/bin/node', ['/root/apex-faucet/tools/account-ingest.js'], { encoding: 'utf8', timeout: 600000 });
      try { return JSON.parse(r.stdout); } catch (e) { return { error: (r.stderr || r.stdout || '').slice(0, 300), status: r.status }; } };
    const first = ing();
    check('ingest runs', first.runId > 0, first.error || 'run ' + first.runId + ', ' + first.ledgerTotal + ' entries');
    const second = ing();
    const { open, openReadOnly } = require('/root/apex-faucet/lib/account/db.js');
    const db = open(); await db.init();
    const L = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    const eq = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    const sum = (arr, f) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
    const q = async (sql, p) => (await db.get(sql, p || [])) || {};
    const r6 = (x) => Math.round(x * 1e6) / 1e6;
    // Idempotency against LIVE sources (09-29: a self-test payment landed 0.5 s after the first run read the file and
    // failed a "re-run adds nothing" test that assumed a frozen world). Precise form: the re-run changes nothing it
    // already had, creates no duplicate key, and every row it adds is a source record newer than the first run.
    {
      const t1 = (await q('SELECT started_at FROM runs WHERE run_id=?', [first.runId])).started_at, t2 = (await q('SELECT started_at FROM runs WHERE run_id=?', [second.runId])).started_at;
      const late = await db.all('SELECT source, source_ref, ts_utc FROM ledger WHERE ingested_at >= ?', [t2]);
      const stale = late.filter((r) => !(Date.parse(r.ts_utc) >= Date.parse(t1) - 60000));
      const dup = await q('SELECT COUNT(*) n FROM (SELECT source, source_ref FROM ledger GROUP BY source, source_ref HAVING COUNT(*) > 1)');
      check('re-run changes nothing it already had; it adds only source records newer than the first run; no duplicate keys',
        second.updated === 0 && second.added === late.length && stale.length === 0 && dup.n === 0,
        'added ' + second.added + (late.length ? ' (' + [...new Set(late.map((r) => r.source))].join(',') + ', all newer than run ' + first.runId + ')' : '') + ', updated ' + second.updated + ', stale ' + stale.length + ', duplicate keys ' + dup.n);
    }

    // settlements: one income leg per source row, same total amount
    const st = L('/root/apex-faucet/data/settlements.ndjson');
    const lst = await q("SELECT COUNT(*) n, SUM(amount) a FROM ledger WHERE source='settlements' AND source_ref LIKE '%:in' AND category <> 'superseded'");
    const sup = await q("SELECT COUNT(*) n FROM ledger WHERE category='superseded'");
    const supUsed = await q("SELECT COUNT(*) n FROM ledger WHERE category='superseded' AND (notes IS NULL OR notes NOT LIKE 'superseded %')");
    check('superseded rows are marked with the reason and kept for audit', supUsed.n === 0, sup.n + ' superseded row(s)');
    check('settlements: one income entry per source row, amounts equal', lst.n === st.length && eq(lst.a, sum(st, (x) => x.amount)), st.length + ' rows, ' + r6(sum(st, (x) => x.amount)) + ' vs ledger ' + lst.n + ', ' + r6(lst.a));
    // Arc dip trader
    const tr = L('/home/claudeuser/core/data/arc-dip-trader.jsonl');
    const buys = tr.filter((e) => e.ev === 'buy'), sells = tr.filter((e) => e.ev === 'sell'), shares = tr.filter((e) => e.ev === 'faucet.share');
    const lb = await q("SELECT COUNT(*) n, SUM(amount) a FROM ledger WHERE source='dip-trader' AND category='trade:buy' AND asset_id='arc:native' AND direction='out'");
    check('dip trader: buys, USDC spent equal', lb.n === buys.length && eq(lb.a, sum(buys, (e) => e.costUsdc)), buys.length + ' / ' + r6(sum(buys, (e) => e.costUsdc)) + ' vs ' + lb.n + ' / ' + r6(lb.a));
    const ls = await q("SELECT COUNT(*) n, SUM(amount) a FROM ledger WHERE source='dip-trader' AND category='trade:sell' AND asset_id='arc:native' AND direction='in'");
    check('dip trader: sells, USDC returned equal', ls.n === sells.length && eq(ls.a, sum(sells, (e) => e.backUsdc)), sells.length + ' / ' + r6(sum(sells, (e) => e.backUsdc)) + ' vs ' + ls.n + ' / ' + r6(ls.a));
    const lf = await q("SELECT COUNT(*) n, SUM(amount) a FROM ledger WHERE source='dip-trader' AND product='faucet share' AND direction='out'");
    check('dip trader: faucet shares equal', lf.n === shares.length && eq(lf.a, sum(shares, (e) => e.usdc)), shares.length + ' / ' + r6(sum(shares, (e) => e.usdc)) + ' vs ' + lf.n + ' / ' + r6(lf.a));
    const lraw = await q("SELECT COUNT(*) n, SUM(amount IS NULL) nul FROM ledger WHERE source='dip-trader' AND source_ref LIKE '%:token-in' AND amount_raw IS NOT NULL");
    check('dip trader: bought token amounts are the writer\'s raw units (no invented decimals), amount NULL', lraw.n === buys.length && lraw.nul === buys.length, lraw.n + ' raw of ' + buys.length);
    const lnull = await q("SELECT COUNT(*) n FROM ledger WHERE source='dip-trader' AND source_ref LIKE '%:token-out' AND amount IS NULL");
    check('dip trader: token amount of a sell (not logged) stays NULL, never 0', lnull.n === sells.length, lnull.n + ' NULL of ' + sells.length + ' sells');
    // Arc faucet claims
    const ac = L('/root/apex-faucet/data/arc-faucet-claims.jsonl').filter((c) => c.tx);
    const lac = await q("SELECT COUNT(*) n, SUM(amount) a FROM ledger WHERE source='arc-faucet-claims'");
    check('Arc faucet claims: count and USDC equal', lac.n === ac.length && eq(lac.a, sum(ac, (c) => c.amountUsdc)), ac.length + ' / ' + r6(sum(ac, (c) => c.amountUsdc)) + ' vs ' + lac.n + ' / ' + r6(lac.a));
    // X1 faucet claims, one assertion per paid column
    // the sandbox reads the column-limited extract, not faucet.db (review A1): prove the copy is complete, then use it
    const EXT = require('/root/apex-faucet/lib/account/extract.js');
    const ext = await EXT.check();
    check('extract: every table copied completely (source rows and checksums equal the copy) and fresh', ext.ok, ext.tables + ' tables, ' + (ext.ageMin == null ? '?' : ext.ageMin.toFixed(1)) + ' min old' + (ext.problems.length ? ': ' + ext.problems.join('; ') : ''));
    const extDb = EXT.open();
    const extCols = (await extDb.all("SELECT m.name t, p.name c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table'")).map((r) => r.t + '.' + r.c);
    await extDb.close();
    const extLeak = extCols.filter((c) => /edit_key|api_key|email|(^|\.)ip(_|$)|ip_address|ip_hash|secret|password|session|comment|message|link_url|\.ref$|\.owner$|\.signature$/.test(c));   // tx_signature is a public chain hash
    check('extract holds no secret or personal column (no edit_key, api_key, email, ip, session, message, owner, Stripe id)', extLeak.length === 0 && extCols.length > 0, extLeak.join(', ') || extCols.length + ' columns checked');
    const fdb = EXT.open();
    const cols = [['amount', 'x1:Du6Z596DwGnfUcMSyRHSBQzNybiQKu8GESVfruEv9Jqr', 'APEX'], ['xnt_amount', 'x1:native', 'XNT'], ['capy_amount', 'x1:AnvCcvnY4DLRW42EZBEAb1QeU6Pt9aab3r3D75GtgJUU', 'CAPY'],
      ['drc_amount', 'x1:GPPQhRmYzt1op59JAtNvsh1VdaueF8iXR5wjXH8xvTFG', 'DRC'], ['ibogains_amount', 'x1:EtgeAvMmZgCWJm9aZqTqQKukxNfhHiU7aHZU37pzihvp', 'IBOGAINS'], ['ash_amount', 'x1:69MtdLn7YTLnaNN4qdS9Z1cJBsNfcHewfmihLBVH1KPw', 'ASH']];
    for (const [col, asset, sym] of cols) {
      const src = await fdb.get(`SELECT COUNT(*) n, SUM(${col}) a FROM claims WHERE ${col} > 0`);
      const led = await q("SELECT COUNT(*) n, SUM(amount) a FROM ledger WHERE source='x1-claims' AND asset_id=?", [asset]);
      check('X1 claims: ' + sym + ' count and amount equal', src.n === led.n && eq(src.a || 0, led.a || 0), src.n + ' / ' + r6(src.a || 0) + ' vs ' + led.n + ' / ' + r6(led.a || 0));
    }
    const potLegs = await q("SELECT SUM(ts_utc >= '2026-09-26T12:42:45.000Z' AND wallet_id LIKE 'x1:1Wwdp3mi%') okAfter, SUM(ts_utc >= '2026-09-26T12:42:45.000Z') after_, SUM(ts_utc < '2026-09-26T12:42:45.000Z' AND wallet_id LIKE 'x1:1Wwdp3mi%') potBefore FROM ledger WHERE source='x1-claims' AND asset_id LIKE 'x1:Du6Z%'");
    check('APEX claim legs after the on-chain handover (12:42:45Z) are the pot\'s, none before', potLegs.okAfter === potLegs.after_ && !potLegs.potBefore, potLegs.after_ + ' after, ' + (potLegs.potBefore || 0) + ' pot legs before');
    // card sales and sponsors
    const card = await fdb.get("SELECT COUNT(*) n, SUM(usd) a FROM city_ownership WHERE via='card'");
    const lcard = await q("SELECT COUNT(*) n, SUM(amount) a, SUM(counterparty='card buyer') anon FROM ledger WHERE source='city_ownership'");
    check('card sales: count and USD equal, buyer anonymous', card.n === lcard.n && eq(card.a || 0, lcard.a || 0) && lcard.anon === lcard.n, card.n + ' / $' + (card.a || 0) + ' vs ' + lcard.n + ' / $' + (lcard.a || 0));
    const sp = await fdb.get("SELECT COUNT(*) n, SUM(amount) a FROM sponsors WHERE tx_signature IS NOT NULL AND tx_signature <> '' AND amount > 0");
    const lsp = await q("SELECT COUNT(*) n, SUM(amount) a FROM ledger WHERE source='sponsors'");
    check('sponsors: count and amount equal', sp.n === lsp.n && eq(sp.a || 0, lsp.a || 0), sp.n + ' / ' + r6(sp.a || 0) + ' vs ' + lsp.n + ' / ' + r6(lsp.a || 0));
    await fdb.close();
    // arc-move: every logged transaction is in the ledger; rows whose unit the tool never wrote stay NULL
    const mv = L('/home/claudeuser/core/data/arc-move.jsonl').filter((m) => m.tx || m.sig);
    const ltx = new Set((await db.all("SELECT tx FROM ledger WHERE source='arc-move'")).map((r) => r.tx));
    const miss = mv.filter((m) => !ltx.has(m.tx || m.sig));
    check('manual-move log: every transaction it names is in the ledger', miss.length === 0, mv.length + ' logged, ' + miss.length + ' missing');
    const unq = mv.filter((m) => !(m.step === 'arc.transfer' && m.from && m.to) && !(m.step === 'consolidate' && m.wallet === 'trader')).length;
    const lunq = await q("SELECT COUNT(*) n FROM ledger WHERE source='arc-move' AND amount IS NULL AND direction='unknown'");
    check('manual-move rows without a recorded unit stay NULL / unknown', lunq.n === unq, lunq.n + ' of ' + unq);
    // shape: every row has a source key, a known confidence, a known direction; no unknown amount stored as 0 for sources that omit it
    const badConf = await q("SELECT COUNT(*) n FROM ledger WHERE confidence NOT IN ('chain-verified-at-payment','ledger-only','estimated') OR source_ref IS NULL OR source_ref = ''");
    check('every entry has a source key and a known confidence', badConf.n === 0, badConf.n + ' bad');
    const badDir = await q("SELECT COUNT(*) n FROM ledger WHERE direction NOT IN ('in','out','unknown')");
    check('direction is in / out / unknown', badDir.n === 0, badDir.n + ' bad');
    const usdEst = await q("SELECT COUNT(*) n FROM ledger WHERE usd_source LIKE 'estimated%' AND confidence = 'chain-verified-at-payment' AND source <> 'settlements'");
    check('estimated USD never labelled chain-verified outside x402 rows', usdEst.n === 0, usdEst.n + ' mislabelled');
    // privacy
    const P = require('/root/apex-faucet/lib/account/privacy.js');
    const rows = await db.all('SELECT counterparty, product, notes, source, source_ref, wallet_id FROM ledger');
    check('no personal data in the ledger (email, Stripe customer, card number, phone)', P.findPersonalData(rows) === null, rows.length + ' rows scanned');
    const plants = [{ notes: 'buyer someone@example.com' }, { counterparty: 'cus_ABCDEFGH1234' }, { notes: 'card 4242 4242 4242 4242' }, { product: 'call +34 612 345 678' }].map((x) => Object.assign({ source: 'plant', source_ref: 'p' }, x));
    check('planted: the privacy guard catches each of 4 planted personal-data strings', plants.every((p) => P.findPersonalData([p])), plants.filter((p) => P.findPersonalData([p])).length + '/4');
    check('ingest quarantines personal-data entries instead of refusing the batch (none in the real sources)', Array.isArray(second.quarantined) && second.quarantined.length === 0, JSON.stringify(second.quarantined));
    const leak = await q("SELECT COUNT(*) n FROM ledger WHERE counterparty LIKE '%@%' OR notes LIKE '%@%' OR product LIKE '%@%'");
    check('no @ anywhere in the text fields', leak.n === 0, leak.n + ' rows');
    await db.close();
  },
  async p4() {
    console.log('P4 reconciliation + outflow detection');
    const cp = require('child_process');
    const { open } = require('/root/apex-faucet/lib/account/db.js');
    const OUT = path.join(R.DIR, 'p4-test-out');
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const recon = (args, db) => {
      const r = cp.spawnSync('/usr/bin/node', ['/root/apex-faucet/tools/account-reconcile.js'].concat(args),
        { env: Object.assign({}, process.env, db ? { ACCOUNT_DB: db } : {}, { ACCOUNT_RECON_OUT: OUT }), encoding: 'utf8', timeout: 1200000 });
      let rep = null; const m = /"report": "([^"]+)"/.exec(r.stdout || ''); if (m) { try { rep = JSON.parse(fs.readFileSync(m[1], 'utf8')); } catch (e) {} }
      return { status: r.status, out: r.stdout || '', err: r.stderr || '', rep };
    };
    const copyDb = async (name) => { const c = path.join(OUT, name); await consistentCopy(c); return c; };
    const CCTP = '0x2afc06c81942d5a8ed7337049294ecfc286d458a5b8f01f0754e84c12960f7e9', GATEWAY = '0x2ca1b2d995ad9de0088b09ecc92c80fe3c897666d8d8f7cf768557453e40ee0c';
    const FAKE_USDC = 'arc:0xc6203d86f5efbed7f9512755f3e6132ee50d03d1';
    const cctpWin = ['--evm', 'arc', '--from', '2026-09-27T18:30:00Z', '--to', '2026-09-27T19:30:00Z', '--wallets', 'arc:0x0ba8d43e'];
    const gwWin = ['--evm', 'arc', '--from', '2026-09-25T04:00:00Z', '--to', '2026-09-25T05:00:00Z', '--wallets', 'arc:0x0ba8d43e,arc:0xd334ab51,arc:0x024b8233'];

    // 1. the two latest complete snapshots reconcile: nothing incomplete, every changed pair adds up exactly
    const db = open(); await db.init();
    const runs = await db.all("SELECT run_id FROM runs WHERE kind='snapshot' AND complete=1 ORDER BY run_id DESC LIMIT 2");
    await db.close();
    const live = recon(['--runs', runs[1].run_id + ',' + runs[0].run_id]);
    const st = live.rep && live.rep.summary.status;
    check('latest two snapshots reconcile: nothing incomplete, no unaccounted gap', !!st && st.incomplete === 0 && st.unaccounted === 0 && [0, 2].includes(live.status),
      live.rep ? 'runs ' + runs[1].run_id + '->' + runs[0].run_id + ': ' + JSON.stringify(st) + ', ' + live.rep.alerts.length + ' alert(s)' : 'exit ' + live.status + ' ' + live.err.slice(0, 200));
    check('trade venues are loaded (Arc PoolManager, X1 DEX programs)', !!live.rep && live.rep.summary.venues && live.rep.summary.venues.arc >= 1 && live.rep.summary.venues.svm >= 2, live.rep ? JSON.stringify(live.rep.summary.venues) : '');
    check('every alert names a transaction (or the exact pair that does not add up)', !!live.rep && live.rep.alerts.every((a) => a.tx && (a.tx.startsWith('delta:') || /^(0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/i.test(a.tx))),
      live.rep ? live.rep.alerts.map((a) => a.kind + ' ' + String(a.tx).slice(0, 14)).join(', ') || 'no alerts' : '');
    // 2. real history: the known manual moves are explained by their annotations, the fake token is not value
    const cw = recon(cctpWin);
    const cctpLeg = cw.rep && cw.rep.changed.flatMap((p) => p.legs).find((l) => String(l.tx).toLowerCase() === CCTP);
    check('backtest: the 09-27 CCTP 0.90 USDC is found on chain and explained by its annotation', !!cctpLeg && cctpLeg.kind === 'recorded', cctpLeg ? cctpLeg.kind : 'not found (exit ' + cw.status + ')');
    check('backtest: the dip trader net-of-gas rows agree with the chain (no amount mismatch)', !!cw.rep && !cw.rep.alerts.some((a) => a.kind === 'ledger-amount-mismatch'), cw.rep ? cw.rep.alerts.map((a) => a.kind).join(', ') || 'no alerts' : '');
    const gw = recon(gwWin);
    const gwLeg = gw.rep && gw.rep.changed.flatMap((p) => p.legs).find((l) => String(l.tx).toLowerCase() === GATEWAY);
    check('backtest: the 09-25 Circle Gateway deposit (0.30) is explained by its annotation', !!gwLeg && gwLeg.kind === 'recorded', gwLeg ? gwLeg.kind : 'not found');
    check('backtest: the self-paid x402 self-tests are seen on chain (no ledger-not-on-chain)', !!gw.rep && !gw.rep.alerts.some((a) => a.kind === 'ledger-not-on-chain'), gw.rep ? gw.rep.alerts.filter((a) => a.kind === 'ledger-not-on-chain').length + ' ghost rows' : '');
    const fk = [cw, gw].map((x) => x.rep && x.rep.changed.find((p) => p.asset_id === FAKE_USDC)).find(Boolean);
    check('backtest: logs are read only from contracts we value (the fake 18-decimal "USDC" is never even fetched)', !fk && !!gw.rep && gw.rep.summary.window.arc.logContracts > 0,
      fk ? 'fetched: ' + fk.status : 'not fetched; ' + (gw.rep ? gw.rep.summary.window.arc.logContracts + ' contracts asked' : ''));
    // a real sell (BAGFI, 2026-09-27 13:27 UTC): its token leaves through the PoolManager and USDC comes back -> trade
    const sw = recon(['--evm', 'arc', '--from', '2026-09-27T13:20:00Z', '--to', '2026-09-27T13:35:00Z', '--wallets', 'arc:0x0ba8d43e']);
    const sl = sw.rep ? sw.rep.changed.flatMap((p) => p.legs).find((l) => String(l.tx).toLowerCase() === '0x12d546713ad88b6b6056d61f6d8cb868ab520209761d8016436128be3547eb2f' && String(l.raw).startsWith('-') && l.kind !== 'fee') : null;
    check('backtest: a dip-trader sell\'s token leg is a trade (PoolManager log + USDC back), not an alarm', !!sl && sl.kind === 'trade' && sw.rep.alerts.length === 0, sl ? sl.kind + ', alerts ' + sw.rep.alerts.length : 'leg not found');
    // the 09-25 trader outflows the audit called untraced (0.60 + 1.00 + 0.40 + 0.30): three went to our own wallets
    const tw = recon(['--evm', 'arc', '--from', '2026-09-25T00:30:00Z', '--to', '2026-09-25T04:00:00Z', '--wallets', 'arc:0x0ba8d43e']);
    const tl = tw.rep ? tw.rep.changed.filter((p) => p.wallet_id === 'arc:0x0ba8d43e' && p.asset_id === 'arc:native').flatMap((p) => p.legs) : [];
    const internal = tl.filter((l) => l.kind === 'internal').map((l) => Number(-l.raw) / 1e18).sort();
    check('backtest: the 09-25 "untraced" trader outflows 0.60 / 1.00 / 0.40 went to our watchtower, operator and receive wallets', JSON.stringify(internal) === JSON.stringify([0.4, 0.6, 1]),
      'internal legs: ' + internal.join(', ') + '; alerts ' + (tw.rep ? tw.rep.alerts.length : '?'));
    // an Arc APEX faucet payment is explained only by the contract's own Claim event (same recipient, same amount)
    const fw = recon(['--evm', 'arc', '--from', '2026-09-25T00:00:00Z', '--to', '2026-09-25T00:20:00Z', '--wallets', 'arc:0x60075dc6']);
    const fl = fw.rep ? fw.rep.changed.flatMap((p) => p.legs).filter((l) => l.raw < 0n || String(l.raw).startsWith('-')) : [];
    check('backtest: Arc APEX faucet payouts are explained by its own Claim event, none alarmed', fl.length > 0 && fl.every((l) => l.kind === 'recorded-by-contract-event') && fw.rep.alerts.length === 0,
      fl.length + ' payout(s): ' + [...new Set(fl.map((l) => l.kind))].join(', ') + '; alerts ' + (fw.rep ? fw.rep.alerts.length : '?'));
    // classification rules (lib/account/classify.js), each with a planted case that must ALARM (Fable review 2 #2, #3, #7)
    {
      const K = require('/root/apex-faucet/lib/account/classify.js');
      const out1 = (c) => K.classifyOutflow(Object.assign({ valued: true }, c)).kind;
      const other = K.ledgerVerdict([{ wallet_id: 'arc:OTHER', asset_id: 'arc:native', amount: 1, direction: 'out', source: 'x' }], 'arc:ME', 'arc:native', -(10n ** 18n), 18);
      check('planted: a hash in the ledger only under ANOTHER wallet does not explain this wallet\'s outflow', other.verdict === 'other-wallet' && out1({ ledger: other }) === 'OUTFLOW-UNRECORDED', other.verdict + ' -> ' + out1({ ledger: other }));
      const unv = K.ledgerVerdict([{ wallet_id: 'arc:ME', asset_id: 'arc:native', amount: null, direction: 'out', source: 'x' }], 'arc:ME', 'arc:native', -5n, 18);
      check('planted: a ledger row whose amount cannot be checked does not explain an outflow', unv.verdict === 'unverifiable' && out1({ ledger: unv }) === 'OUTFLOW-UNRECORDED', unv.verdict + ' -> ' + out1({ ledger: unv }));
      const wrong = K.ledgerVerdict([{ wallet_id: 'arc:ME', asset_id: 'arc:t', amount_raw: '100', direction: 'in', source: 'x' }], 'arc:ME', 'arc:t', 99n, null);
      check('planted: raw-unit ledger row off by one unit -> amount differs', wrong.verdict === 'differs', wrong.verdict);
      // an X1 hash with lowercase i/o (alert 316) is a chain hash and must never be closed as 'not a chain reference'
      const h316 = '4WqpfjmYaGsRRjDsL9VYhwMay94hxEMRTZ63toJhRi6mQC1zSxKhjZZf2y4DYFcmrCtDtU9rqR8YM3CJTp2XCUKs';
      check('planted: an X1 hash containing lowercase i/o is a chain reference (alerts on it cannot close themselves)',
        K.isChainRef(h316) && K.isChainRef('0x7151debedc8b9af572740d8a757380668122a35e82bebfc4491807916e0d43d2') && !K.isChainRef('gateway:072e936f-c9fc-491c-8462-7dc712d885a8') && !K.isChainRef(h316.replace('o', 'O')),
        'x1 ' + K.isChainRef(h316) + ', gateway ' + K.isChainRef('gateway:x'));
      const valuedFn = (a) => a === 'arc:native' || a === 'arc:good';
      const venues = new Set(['0xpool']);
      const drain = [{ to: '0xme', asset: 'arc:junk' }];
      check('planted: a drain that hands us a JUNK token in the same tx is not a trade', !K.evmTradeEvidence(drain, '0xme', 'arc:native', valuedFn, [{ address: '0xpool' }], venues));
      check('planted: a valued token in the same tx but NO venue log is not a trade', !K.evmTradeEvidence([{ to: '0xme', asset: 'arc:good' }], '0xme', 'arc:native', valuedFn, [{ address: '0xelse' }], venues));
      check('a valued token in AND a venue log is a trade', K.evmTradeEvidence([{ to: '0xme', asset: 'arc:good' }], '0xme', 'arc:native', valuedFn, [{ address: '0xpool' }], venues));
      check('planted: SVM junk token in, even through a DEX program, is not a trade', !K.svmTradeEvidence([{ asset: 'x1:junk', raw: 5n }], 'x1:native', valuedFn, ['XDEX'], new Set(['XDEX'])));
      const own = new Map([['acctP', 'KNOWNPROG'], ['acctS', '11111111111111111111111111111111']]);
      const isOurs = (a) => a === 'OURWALLET';
      const known = new Set(['KNOWNPROG']);
      check('planted: lamports into a NEW token account owned by a stranger are not rent', !K.rentOk([{ newAccount: true, raw: 2039280n, tokenAccount: true, tokenOwner: 'STRANGER' }], 'ME', isOurs, own, known, 10000000n));
      check('rent: a new token account of ours is rent', K.rentOk([{ newAccount: true, raw: 2039280n, tokenAccount: true, tokenOwner: 'OURWALLET' }], 'ME', isOurs, own, known, 10000000n));
      check('planted: a new account owned by the System Program (a wallet) is not rent', !K.rentOk([{ newAccount: true, raw: 890880n, account: 'acctS' }], 'ME', isOurs, own, known, 10000000n));
      check('rent: a new account owned by a program we run is rent', K.rentOk([{ newAccount: true, raw: 1000000n, account: 'acctP' }], 'ME', isOurs, own, known, 10000000n));
      check('planted: a junk-token outflow is reported, never an alarm; a valued one alarms', K.classifyOutflow({ valued: false }).kind === 'unvalued-movement' && K.classifyOutflow({ valued: true }).kind === 'OUTFLOW-UNRECORDED'
        && K.classifyOutflow({ valued: false, burned: true }).kind === 'burn-unvalued' && K.classifyOutflow({ valued: true, burned: true }).kind === 'BURN-UNRECORDED');
    }
    // 3. planted faults, each on a COPY of account.db
    {   // a. a balance that fell with no transaction behind it
      const c = await copyDb('plant-a.db'); const d = open(c); await d.init();
      await d.run("UPDATE balances SET raw = CAST(CAST(raw AS INTEGER) - 500000000000000000 AS TEXT) WHERE run_id=? AND wallet_id='arc:0x024b8233' AND asset_id='arc:native'", [runs[0].run_id]); await d.close();
      const r = recon(['--runs', runs[1].run_id + ',' + runs[0].run_id, '--wallets', 'arc:0x024b8233'], c);
      check('planted: 0.5 USDC removed from the operator with no transaction -> unaccounted-delta alert', r.status === 2 && !!r.rep && r.rep.alerts.some((a) => a.kind === 'unaccounted-delta' && a.wallet_id === 'arc:0x024b8233'), 'exit ' + r.status + ' ' + (r.rep ? r.rep.alerts.map((a) => a.kind).join(',') : r.err.slice(0, 150)));
    }
    {   // b. the CCTP annotation deleted -> it is an unrecorded outflow again ("until annotated")
      const c = await copyDb('plant-b.db'); const d = open(c); await d.init();
      await d.run("DELETE FROM ledger WHERE lower(tx)=? AND source='annotations'", [CCTP]); await d.close();
      const r = recon(cctpWin, c);
      check('planted: CCTP annotation deleted -> unrecorded-outflow alert on that exact tx', !!r.rep && r.rep.alerts.some((a) => a.kind === 'unrecorded-outflow' && String(a.tx).toLowerCase() === CCTP), 'exit ' + r.status + ' ' + (r.rep ? r.rep.alerts.map((a) => a.kind + ':' + String(a.tx).slice(0, 10)).join(',') : ''));
    }
    {   // c. a failed read -> incomplete, never zero
      const c = await copyDb('plant-c.db'); const d = open(c); await d.init();
      await d.run("UPDATE balances SET ok=0, raw=NULL, amount=NULL, error='planted read failure' WHERE run_id=? AND wallet_id='x1:HYiepS7mNC' AND asset_id='x1:native'", [runs[0].run_id]); await d.close();
      const r = recon(['--runs', runs[1].run_id + ',' + runs[0].run_id, '--wallets', 'x1:HYiepS7mNC'], c);
      const d2 = open(c); await d2.init();
      const row = await d2.get("SELECT status, close_amt FROM recon WHERE wallet_id='x1:HYiepS7mNC' AND asset_id='x1:native' ORDER BY recon_id DESC LIMIT 1"); await d2.close();
      check('planted: a failed balance read -> pair incomplete, exit 3, close amount NULL (not 0)', r.status === 3 && !!row && row.status === 'incomplete' && row.close_amt === null, 'exit ' + r.status + ', ' + JSON.stringify(row));
    }
    {   // c2. a failed read while a VALUED balance fell -> drop-unverified (silence is not success); control: no drop, no alarm
      const plantFail = async (c, drop) => { const d = open(c); await d.init();
        const addr = (await d.get("SELECT address FROM balances WHERE wallet_id='x1:HYiepS7mNC' LIMIT 1")).address;
        await d.run("INSERT INTO balances (run_id, wallet_id, chain, address, asset_id, raw, decimals, amount, rpc_url, block_or_slot, read_at, ok, error) VALUES (?, 'x1:HYiepS7mNC', 'x1', ?, 'x1:tokens', NULL, NULL, NULL, NULL, NULL, ?, 0, 'planted token-list failure')", [runs[0].run_id, addr, new Date().toISOString()]);
        if (drop) await d.run("UPDATE balances SET raw = CAST(CAST(raw AS INTEGER) - 500000000 AS TEXT) WHERE run_id=? AND wallet_id='x1:HYiepS7mNC' AND asset_id='x1:native'", [runs[0].run_id]);
        await d.close(); };
      const c1 = await copyDb('plant-c2.db'); await plantFail(c1, true);
      const r1 = recon(['--runs', runs[1].run_id + ',' + runs[0].run_id, '--wallets', 'x1:HYiepS7mNC'], c1);
      check('planted: a failed read while 0.5 XNT left the faucet wallet -> drop-unverified alert, exit 3', r1.status === 3 && !!r1.rep && r1.rep.alerts.some((a) => a.kind === 'drop-unverified' && a.wallet_id === 'x1:HYiepS7mNC' && a.asset_id === 'x1:native'),
        'exit ' + r1.status + ' ' + (r1.rep ? r1.rep.alerts.map((a) => a.kind).join(',') : r1.err.slice(0, 120)));
      const c0 = await copyDb('plant-c3.db'); await plantFail(c0, false);
      const r0 = recon(['--runs', runs[1].run_id + ',' + runs[0].run_id, '--wallets', 'x1:HYiepS7mNC'], c0);
      check('control: the same failed read with no drop -> incomplete but no drop alarm', r0.status === 3 && !!r0.rep && !r0.rep.alerts.some((a) => a.kind === 'drop-unverified'), 'exit ' + r0.status + ' ' + (r0.rep ? r0.rep.alerts.map((a) => a.kind).join(',') || 'no alerts' : ''));
    }
    {   // d. a ledger row for a transaction that never happened
      const c = await copyDb('plant-d.db'); const d = open(c); await d.init();
      const fake = '0x' + 'ab'.repeat(32);
      await d.run("INSERT INTO ledger (ts_utc, chain, tx, wallet_id, direction, asset_id, amount, category, source, source_ref, confidence, ingested_at) VALUES ('2026-09-27T19:00:00.000Z','arc',?,'arc:0x0ba8d43e','out','arc:native',1.0,'manual','plant','plant:d','ledger-only',?)", [fake, new Date().toISOString()]); await d.close();
      const r = recon(cctpWin, c);
      check('planted: a ledger row whose tx is not on chain -> ledger-not-on-chain alert', !!r.rep && r.rep.alerts.some((a) => a.kind === 'ledger-not-on-chain' && a.tx === fake), 'exit ' + r.status + ' ' + (r.rep ? r.rep.alerts.map((a) => a.kind).join(',') : ''));
    }
    {   // e. the right hash with the wrong amount
      const c = await copyDb('plant-e.db'); const d = open(c); await d.init();
      await d.run("UPDATE ledger SET amount=0.09 WHERE lower(tx)=? AND source='annotations'", [CCTP]); await d.close();
      const r = recon(cctpWin, c);
      check('planted: CCTP annotation says 0.09 instead of 0.90 -> ledger-amount-mismatch alert', !!r.rep && r.rep.alerts.some((a) => a.kind === 'ledger-amount-mismatch' && String(a.tx).toLowerCase() === CCTP), 'exit ' + r.status + ' ' + (r.rep ? r.rep.alerts.map((a) => a.kind).join(',') : ''));
    }
    fs.rmSync(OUT, { recursive: true, force: true });
  },
  async p5() {
    console.log('P5 consumer summary (export + validator + readiness)');
    const cp = require('child_process');
    const { open } = require('/root/apex-faucet/lib/account/db.js');
    const OUT = path.join(R.DIR, 'p5-test-out');
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const VALIDATOR = '/usr/local/sbin/apex-account/validate-summary.js';
    const exp = (steps, db, name) => {
      const out = path.join(OUT, name + '.json');
      const r = cp.spawnSync('/usr/bin/node', ['/root/apex-faucet/tools/account-export.js', '--steps', JSON.stringify(steps), '--trigger', 'manual', '--cycle-start', new Date().toISOString(), '--out', out, '--history', path.join(OUT, name + '.ndjson')],
        { env: Object.assign({}, process.env, db ? { ACCOUNT_DB: db } : {}), encoding: 'utf8', timeout: 120000 });
      let s = null; try { s = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) {}
      const v = cp.spawnSync('/usr/bin/node', [VALIDATOR, 'check', out], { encoding: 'utf8' });
      return { status: r.status, s, valid: v.status === 0, vout: (v.stdout || '').trim(), err: (r.stderr || '').slice(0, 200) };
    };
    const ALL0 = { site: 0, extract: 0, snapshot: 0, verify: 0, ingest: 0, reconcile: 0 };
    const real = exp(ALL0, null, 'real');
    check('export of the real state is valid for the root validator', real.status === 0 && real.valid, real.vout + (real.err ? ' ' + real.err : ''));
    check('a complete export carries NAV numbers; an incomplete one carries none', !!real.s && (real.s.complete ? !!real.s.nav && typeof real.s.nav.liquid_usd === 'number' : real.s.nav === null),
      real.s ? 'complete ' + real.s.complete + ', status ' + real.s.status + ', liquid ' + (real.s.nav ? real.s.nav.liquid_usd : 'null') : '');
    const failedStep = exp(Object.assign({}, ALL0, { snapshot: 3 }), null, 'step3');
    check('planted: a snapshot step that exited 3 -> status incomplete, NAV withheld, still a valid summary', !!failedStep.s && failedStep.s.status === 'incomplete' && failedStep.s.nav === null && failedStep.valid,
      failedStep.s ? failedStep.s.status + ' / nav ' + JSON.stringify(failedStep.s.nav) + ' / ' + failedStep.vout : failedStep.err);
    const c = path.join(OUT, 'plant.db'); await consistentCopy(c);
    const d = open(c); await d.init(); await d.run("UPDATE runs SET complete=0 WHERE run_id=(SELECT MAX(run_id) FROM runs WHERE kind='snapshot')"); await d.close();
    const inc = exp(ALL0, c, 'incsnap');
    check('planted: latest snapshot incomplete -> NAV null, status incomplete, never a number', !!inc.s && inc.s.nav === null && inc.s.complete === false && inc.valid, inc.s ? inc.s.status + ' ' + inc.s.notes.join('; ').slice(0, 120) : inc.err);
    const vs = cp.spawnSync('/usr/bin/node', [VALIDATOR, 'selftest'], { encoding: 'utf8' });
    check('validator rejects each of 8 planted bad summaries (NAV on incomplete, negative value, stale, email, key-shaped hex ...)', vs.status === 0, (vs.stdout || '').trim().split('\n').pop());
    const { consecutiveCleanScheduled: cc } = require('/root/apex-faucet/lib/account/readiness.js');
    const T = (clean) => ({ trigger: 'timer', clean }), M = (clean) => ({ trigger: 'manual', clean });
    check('readiness counts only consecutive clean TIMER cycles', cc([T(true), T(true), T(true), T(true), T(true), M(true), T(true)]) === 6 && cc([T(true), T(true), T(true), T(true), T(true), T(true), T(false)]) === 0
      && cc([M(true), M(true), M(true), M(true), M(true), M(true), M(true)]) === 0 && cc([T(false), T(true), T(true)]) === 2);
    fs.rmSync(OUT, { recursive: true, force: true });
  },
};

(async () => {
  await require('/root/apex-faucet/lib/account/assert-sandboxed.js').assertSandboxed();   // refuses to run outside tools/account-run.sh
  const want = process.argv.slice(2);
  if (!want.length) { console.log('usage: account-exit-tests.js p1 [p2 ...]'); process.exit(2); }
  for (const p of want) { if (!PHASES[p]) { fail('unknown phase ' + p); continue; } await PHASES[p](); }
  console.log(failed ? 'EXIT TESTS FAILED: ' + failed : 'EXIT TESTS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('EXIT TESTS CRASHED: ' + (e && e.stack || e)); process.exit(1); });
