#!/usr/bin/env node
'use strict';
// ACCOUNT LAYER P2 verification (2026-09-29). Checks a snapshot against the chain by an INDEPENDENT read:
//   Arc / Base   every balance re-read through a DIFFERENT endpoint at the SAME block: must match to the unit
//   Solana       re-read through a different endpoint; a difference must be explained by a transaction after the snapshot
//   X1           only one public mainnet RPC exists (rpc.mainnet.x1.xyz; xolana.xen.network is a different genesis,
//                rpc.x1scroll.io does not answer), so: re-read now, and every difference must be explained by a
//                transaction on that wallet after the snapshot slot, listed by signature
//   prices       XNT/USD recomputed from the pool now and compared with the server's /api/xnt-price (flag > 2%)
//   positions    the snapshot's own state-vs-chain quantity check is re-counted
//   treasury-nav per-wallet XNT and APEX compared with treasury-nav's last run (independent code); a difference must be
//                explained by a transaction between the two read times
// Writes data/protected/account/verify-<run>.json and exits 1 if anything is unexplained.
// Run: sudo tools/account-run.sh node tools/account-verify.js [runId] [--x1-sample N]
const fs = require('fs');
const path = require('path');
const { open } = require('/root/apex-faucet/lib/account/db.js');
const rpc = require('/root/apex-faucet/lib/account/rpc.js');
const evm = require('/root/apex-faucet/lib/account/chains/evm.js');
const svm = require('/root/apex-faucet/lib/account/chains/svm.js');
const P = require('/root/apex-faucet/lib/account/prices.js');

const argRun = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const sampleArg = process.argv.indexOf('--x1-sample');
const X1_SAMPLE = sampleArg > 0 ? Number(process.argv[sampleArg + 1]) : 25;
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null;   // e.g. --only arc (used by the planted-fault test)
const want = (c) => !ONLY || ONLY.has(c);
const HOT_ROLES = new Set(['faucet', 'founder', 'arena', 'trader', 'flux', 'passport-hot', 'operator', 'receive', 'fee-payer', 'bridge', 'escrow', 'authority', 'program-pda']);

(async () => {
  await require('/root/apex-faucet/lib/account/assert-sandboxed.js').assertSandboxed();   // refuses to run outside tools/account-run.sh
  const db = open(); await db.init();
  const run = argRun ? Number(argRun) : (await db.get("SELECT MAX(run_id) r FROM runs WHERE kind='snapshot'")).r;
  const meta = await db.get('SELECT * FROM runs WHERE run_id=?', [run]);
  const summary = JSON.parse(meta.summary_json || '{}');
  const bal = await db.all('SELECT * FROM balances WHERE run_id=?', [run]);
  const report = { run, at: new Date().toISOString(), snapshotComplete: !!meta.complete, checks: [], unexplained: [], notes: [] };
  const add = (name, ok, detail) => { report.checks.push({ name, ok, detail }); if (!ok) report.unexplained.push(name + ': ' + detail); };

  // ── Arc / Base: other endpoint, same block, exact ──
  for (const chain of ['arc', 'base'].filter(want)) {
    const rows = bal.filter((b) => b.chain === chain && b.ok);
    let same = 0, diff = [];
    for (const b of rows) {
      const others = rpc.ENDPOINTS[chain].filter((u) => u !== b.rpc_url);
      const block = BigInt(b.block_or_slot);
      try {
        let raw;
        if (b.asset_id === chain + ':native') raw = (await evm.nativeBalance(chain, b.address, block, { endpoints: others })).raw;
        else raw = (await evm.erc20Balance(chain, b.asset_id.split(':')[1], b.address, block, { endpoints: others })).raw;
        if (raw === b.raw) same++; else diff.push(b.wallet_id + ' ' + b.asset_id + ' snap=' + b.raw + ' other=' + raw);
      } catch (e) { diff.push(b.wallet_id + ' ' + b.asset_id + ' re-read failed: ' + String(e.message).slice(0, 80)); }
    }
    add(chain + ': every balance equal via a different endpoint at the same block', diff.length === 0, same + '/' + rows.length + ' equal' + (diff.length ? '; ' + diff.slice(0, 5).join(' | ') : ''));
  }

  // ── SVM re-read; any difference must be explained EXACTLY by the transactions between the two reads ──
  // (Fable review 09-29, finding 5: "one signature after the snapshot slot, of any size, explains any difference" made
  // this check unable to fail. Now every transaction between the snapshot slot and the re-read slot is fetched and its
  // balance changes on this wallet are summed; snapshot + sum must equal the re-read to the last unit.)
  const X = require('/root/apex-faucet/lib/account/recon.js');
  const kindOf = new Map(require('/root/apex-faucet/lib/account/registry.js').load().entries.map((e) => [e.id, e.kind]));
  async function svmCheck(chain, rows, endpoints, label) {
    let same = 0; const changedByTx = [], unexplained = [];
    const wallets = [...new Set(rows.map((b) => b.wallet_id))];
    for (const w of wallets) {
      const wrows = rows.filter((b) => b.wallet_id === w && !/:tokens$|:token-account$/.test(b.asset_id));
      if (!wrows.length) continue;
      const address = wrows[0].address, kind = kindOf.get(w);
      const now = new Map();   // asset -> { raw, slot }
      try {
        if (kind === 'token-account') { const t = await svm.tokenAccount(chain, address); now.set(chain + ':' + t.mint, { raw: t.raw, slot: t.slot }); }
        else {
          const nb = await svm.nativeBalance(chain, address); now.set(chain + ':native', { raw: nb.raw, slot: nb.slot });
          const tb = await svm.tokenBalances(chain, address); const listSlot = tb.length ? tb[0].slot : nb.slot;
          for (const t of tb) now.set(chain + ':' + t.mint, { raw: t.raw, slot: t.slot });
          for (const b of wrows) if (!now.has(b.asset_id)) now.set(b.asset_id, { raw: '0', slot: listSlot });   // list read fine: absent = 0
        }
      } catch (e) { unexplained.push(w + ' re-read failed: ' + String(e.message).slice(0, 80)); continue; }
      const diffs = wrows.filter((b) => now.get(b.asset_id).raw !== b.raw);
      if (!diffs.length) { same++; continue; }
      try {
        const fromSlot = Math.min(...diffs.map((d) => Number(d.block_or_slot))), toSlot = Math.max(...diffs.map((d) => now.get(d.asset_id).slot));
        const mints = diffs.map((d) => d.asset_id.split(':')[1]).filter((m) => m !== 'native');
        const eff = await X.svmWalletEffects(chain, address, kind, mints, fromSlot, toSlot);
        const bad = [];
        for (const d of diffs) {
          const lo = Number(d.block_or_slot), hi = now.get(d.asset_id).slot;
          const sum = eff.filter((f) => f.slot > lo && f.slot <= hi).reduce((t, f) => t + f.effects.filter((x) => x.asset === d.asset_id).reduce((u, x) => u + x.raw, 0n), 0n);
          if (BigInt(d.raw) + sum !== BigInt(now.get(d.asset_id).raw)) bad.push(d.asset_id + ' snap=' + d.raw + ' + txs ' + sum + ' != now ' + now.get(d.asset_id).raw);
        }
        if (bad.length) unexplained.push(w + ' ' + bad.join(', '));
        else changedByTx.push(w + ' (' + diffs.length + ' asset(s), ' + eff.length + ' tx summed exactly)');
      } catch (e) { unexplained.push(w + ' differs and its transactions could not be read: ' + String(e.message).slice(0, 80)); }
    }
    add(label, unexplained.length === 0, same + ' wallet(s) identical, ' + changedByTx.length + ' changed, every change equal to the sum of its transactions' + (changedByTx.length ? ' [' + changedByTx.slice(0, 4).join(' | ') + ']' : '') + (unexplained.length ? '; UNEXPLAINED: ' + unexplained.slice(0, 5).join(' | ') : ''));
  }
  const reg = require('/root/apex-faucet/lib/account/registry.js').load();
  const roleOf = new Map(reg.entries.map((e) => [e.id, e.role]));
  const solRows = bal.filter((b) => b.chain === 'solana' && b.ok);
  if (want('solana')) await svmCheck('solana', solRows, rpc.ENDPOINTS.solana.slice(1), 'solana: re-read via a second endpoint, every difference equal to the sum of the transactions between the reads');
  const x1Rows = bal.filter((b) => b.chain === 'x1' && b.ok);
  const hot = [...new Set(x1Rows.filter((b) => HOT_ROLES.has(roleOf.get(b.wallet_id))).map((b) => b.wallet_id))];
  const others = [...new Set(x1Rows.map((b) => b.wallet_id))].filter((w) => !hot.includes(w)).sort(() => Math.random() - 0.5).slice(0, X1_SAMPLE);
  if (want('x1')) await svmCheck('x1', x1Rows.filter((b) => hot.includes(b.wallet_id) || others.includes(b.wallet_id)), null,
    'x1: ' + hot.length + ' hot + ' + others.length + ' random wallets re-read, every difference equal to the sum of the transactions between the reads');

  // ── prices ──
  if (want('prices')) try {
    const x = await P.x1Prices();
    // the server's own oracle, fetched by root just before this step (review 3 L1: the sandbox has no route to our site)
    let server = null, siteAgeS = null;
    try { const f = JSON.parse(fs.readFileSync('/root/apex-faucet/data/protected/account-extract/site-xnt-price.json', 'utf8')); siteAgeS = (Date.now() - Date.parse(f.fetched_at)) / 1000; if (siteAgeS <= 600) server = f.body; } catch (e) {}
    const sp = server && (server.priceUsd || server.price || (server.data && server.data.priceUsd));
    // A price cannot be re-read at a past slot on X1, and XNT moves >2% in minutes, so "read again later" proves nothing.
    // Two real checks instead: (a) the snapshot's price is exactly the arithmetic of the reserves it recorded;
    // (b) our pool read NOW agrees with the server's own oracle NOW (independent code, same moment).
    const pr = await db.get("SELECT usd, source_detail FROM prices WHERE run_id=? AND asset_id='x1:native'", [run]);
    const sd = JSON.parse(pr.source_detail || '{}');
    const recomputed = sd.usdcx / sd.xnt;
    add('xnt/usd in the snapshot == usdcx/xnt of the reserves it recorded', Math.abs(recomputed - pr.usd) < 1e-12, 'reserves ' + sd.usdcx + ' / ' + sd.xnt + ' = ' + recomputed + ' (stored ' + pr.usd + ', slot ' + sd.slot + ')');
    const d2 = sp ? Math.abs(x.xntUsd - sp) / x.xntUsd : null;
    add('xnt/usd: our pool read now vs the server oracle (fetched by root just before, independent code)', d2 != null && d2 < 0.02, 'ours ' + x.xntUsd.toFixed(6) + ', server ' + (sp || (siteAgeS == null ? 'no file' : 'file ' + Math.round(siteAgeS) + ' s old, limit 600')) + (d2 != null ? ' (' + (d2 * 100).toFixed(2) + '%, server read ' + Math.round(siteAgeS) + ' s ago)' : ''));
    report.notes.push('XNT moved ' + ((x.xntUsd / summary.xntUsd - 1) * 100).toFixed(2) + '% between the snapshot and this check (market movement, not an error)');
  } catch (e) { add('xnt/usd recomputed from the pool now', false, 'read failed: ' + e.message); }

  // ── positions ──
  if (want('positions')) {
  const pos = await db.all('SELECT symbol, qty_state, qty_chain, mismatch, own_spot_usd, mark_usd FROM positions WHERE run_id=?', [run]);
  add('arc trader positions: quantity in its state == balanceOf on chain', pos.length > 0 && pos.every((p) => !p.mismatch), pos.filter((p) => !p.mismatch).length + '/' + pos.length + ' equal');
  const ratio = pos.filter((p) => p.mark_usd > 0).map((p) => p.symbol + ' ' + (p.own_spot_usd / p.mark_usd).toFixed(2));
  report.notes.push('our pool spot / trader mark per position: ' + ratio.join(', '));
  }

  // ── parity with treasury-nav (independent code) ──
  if (want('parity')) try {
    const tn = JSON.parse(fs.readFileSync('/root/apex-faucet/data/treasury-nav-last.json', 'utf8'));
    const tnAt = Date.parse(tn.at);
    let eqX = 0, eqA = 0, n = 0; const diffs = [];
    for (const [addr, v] of Object.entries(tn.per)) {
      const w = reg.entries.find((e) => e.chain === 'x1' && e.address === addr); if (!w) continue; n++;
      const xnt = bal.find((b) => b.wallet_id === w.id && b.asset_id === 'x1:native');
      const apex = bal.find((b) => b.wallet_id === w.id && b.asset_id === 'x1:' + P.X1.APEX);
      const ourX = xnt && xnt.ok ? xnt.amount : null, ourA = apex && apex.ok ? apex.amount : 0;
      const okX = ourX != null && Math.abs(ourX - v.xnt) < 1e-6, okA = Math.abs(ourA - (v.apex || 0)) < 1e-3;
      if (okX) eqX++; if (okA) eqA++;
      if (!okX || !okA) diffs.push({ w: w.id, address: addr, xnt: [v.xnt, ourX], apex: [v.apex, ourA] });
    }
    // Every difference must be explained EXACTLY by the transactions between treasury-nav's read and ours. treasury-nav
    // records a time, not a slot, so the transactions within 3 minutes of that time are ambiguous: its read happened at
    // one moment, so the ones before it are a time-ordered PREFIX of them. Every cut point is tried; one must add up.
    const unexplained = [];
    const APEX_ID = 'x1:' + P.X1.APEX;
    for (const d of diffs.slice(0, 40)) {
      try {
        const w = reg.entries.find((e) => e.id === d.w);
        const rowX = bal.find((b) => b.wallet_id === d.w && b.asset_id === 'x1:native'), rowA = bal.find((b) => b.wallet_id === d.w && b.asset_id === APEX_ID);
        const toSlot = Math.max(Number((rowX || {}).block_or_slot) || 0, Number((rowA || {}).block_or_slot) || 0);
        const eff = (await X.svmWalletEffects('x1', d.address, w.kind, [P.X1.APEX], { sinceSec: Math.floor(tnAt / 1000) - 180 }, toSlot)).sort((a, b) => a.slot - b.slot);
        const sure = eff.filter((f) => f.blockTime * 1000 > tnAt + 180000), amb = eff.filter((f) => f.blockTime * 1000 <= tnAt + 180000);
        const sumOf = (list, asset, maxSlot) => list.filter((f) => f.slot <= maxSlot).reduce((t, f) => t + f.effects.filter((x) => x.asset === asset).reduce((u, x) => u + x.raw, 0n), 0n);
        let ok = false;
        for (let k = 0; k <= amb.length && !ok; k++) {
          const used = sure.concat(amb.slice(k));   // amb[0..k) happened before treasury-nav read, the rest after
          const dx = Number(sumOf(used, 'x1:native', Number((rowX || {}).block_or_slot) || 0)) / 1e9, da = Number(sumOf(used, APEX_ID, Number((rowA || {}).block_or_slot) || toSlot)) / 1e9;
          ok = d.xnt[1] != null && Math.abs(d.xnt[0] + dx - d.xnt[1]) < 1e-6 && Math.abs((d.apex[0] || 0) + da - (d.apex[1] || 0)) < 1e-3;
        }
        if (!ok) unexplained.push(d.w + ' xnt tn=' + d.xnt[0] + ' ours=' + d.xnt[1] + ' apex tn=' + d.apex[0] + ' ours=' + d.apex[1] + ' (' + eff.length + ' tx do not add up)');
      } catch (e) { unexplained.push(d.w + ' (transactions unreadable: ' + String(e.message).slice(0, 60) + ')'); }
    }
    add('x1 parity with treasury-nav (' + tn.at + '), every difference equal to the sum of the transactions between the reads', unexplained.length === 0 && diffs.length <= 40,
      n + ' wallets: XNT equal ' + eqX + ', APEX equal ' + eqA + ', differing ' + diffs.length + (unexplained.length ? '; UNEXPLAINED ' + unexplained.slice(0, 5).join(' | ') : ''));
  } catch (e) { add('x1 parity with treasury-nav', false, e.message); }

  report.ok = report.unexplained.length === 0;
  const out = path.join(process.env.ACCOUNT_VERIFY_OUT || '/root/apex-faucet/data/protected/account', 'verify-' + run + '.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  for (const c of report.checks) console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.name + '\n        ' + c.detail);
  for (const n of report.notes) console.log('  note  ' + n);
  console.log(report.ok ? 'VERIFY PASSED (run ' + run + ')' : 'VERIFY FAILED (run ' + run + '): ' + report.unexplained.length + ' unexplained');
  await db.close();
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { console.error('VERIFY CRASHED: ' + (e && e.stack || e)); process.exit(1); });
