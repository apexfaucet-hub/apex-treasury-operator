#!/usr/bin/env node
'use strict';
// ACCOUNT LAYER P4: reconciliation and outflow detection (2026-09-29). REPORT-ONLY: writes recon rows, alerts and a
// JSON report under data/protected/account/; sends nothing anywhere and changes nothing outside that directory.
//
// For every (wallet, asset) between two complete snapshots:
//   chain delta = close balance - open balance (raw units, exact)
//   then the chain is asked what moved (SVM: every signature in the slot window; EVM: every Transfer log incl. Arc's
//   native system log, plus the gas of every transaction the wallet sent). Each movement is sorted:
//     recorded            the ledger holds that hash FOR THIS WALLET AND ASSET with an amount that agrees with the chain
//     recorded-by-contract-event  a contract of ours paid it and wrote its own event for that recipient and amount
//     recorded-by-amount  a ledger row without a hash, same wallet / asset / amount / counterparty, within 15 min
//     fee | rent | internal | trade            ours, unrecorded, and not value leaving us (reported, not alarmed)
//     unvalued-movement | burn-unvalued        a token we do not value (junk airdrop, city commodity): reported only
//     inflow-unrecorded   value arrived that no ledger explains (reported)
//     OUTFLOW-UNRECORDED / BURN-UNRECORDED     value we value left, nothing records why          -> alert
//     RECORDED-AMOUNT-DIFFERS                  the ledger has the hash with a different amount   -> alert
//   The rules live in lib/account/classify.js (pure, tested with planted cases).
//   and the movements must add up to the chain delta. If they do not, the gap is an alert of its own
//   ('unaccounted-delta'): a balance changed and no transaction we can see explains it.
// A failed read on either side makes that pair INCOMPLETE. It is never read as zero.
//
// Usage (inside the sandbox):
//   account-reconcile.js                       two latest complete snapshots
//   account-reconcile.js --runs 3 14
//   account-reconcile.js --evm arc --from 2026-09-25T00:00:00Z --to 2026-09-28T00:00:00Z [--wallets arc:0x0ba8d43e,...]
//        historical window on an EVM chain: balances read at the two blocks (archive reads agree on 4 endpoints)
// Exit: 0 reconciled, no alert; 2 alerts; 3 incomplete; 1 crashed.
const fs = require('fs');
const path = require('path');
const R = require('/root/apex-faucet/lib/account/registry.js');
const { open } = require('/root/apex-faucet/lib/account/db.js');
const X = require('/root/apex-faucet/lib/account/recon.js');
const evm = require('/root/apex-faucet/lib/account/chains/evm.js');
const C = require('/root/apex-faucet/lib/account/classify.js');
const P = require('/root/apex-faucet/lib/account/prices.js');
const METHOD_VERSION = 3;   // 3 (09-30, Fable recorder review L5): case-sensitive isChainRef retraction, clean re-runs close delta:/drop: alerts
const _mv2note = 2;   // 2 (09-29, Fable review v2): classify.js rules, valued-only alarms, venue-backed trades

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const OUT_DIR = process.env.ACCOUNT_RECON_OUT || R.DIR;
const AMOUNT_MATCH_WINDOW_MS = 15 * 60e3;
const RENT_MAX = { x1: 10000000n, solana: 10000000n };   // rent-sized: <= 0.01 native
// ERC-20 balance at a block. No code at that block = the contract did not exist yet = it held nothing (a chain fact).
// Code present but balanceOf fails = the token cannot be read: thrown with unreadableToken so the pair says so.
async function tokenBalanceAt(chain, token, holder, block) {
  try { return BigInt((await evm.erc20Balance(chain, token, holder, block)).raw); }
  catch (e) {
    const code = (await require('/root/apex-faucet/lib/account/rpc.js').call(chain, 'eth_getCode', [token, X.hex(block)])).result;
    if (!code || code === '0x') return 0n;
    if (!/revert|invalid opcode|out of gas|returned nothing/i.test(String(e.message))) throw e;   // transport failure: incomplete, never "unreadable"
    const err = new Error('balanceOf reverts on a live contract (' + String(e.message).slice(0, 60) + ')'); err.unreadableToken = true; throw err;
  }
}
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
// Contracts of ours that write their OWN record of every payment they make. An outflow from one of them is explained
// only if the same transaction carries that contract's event naming the same recipient and the exact same amount.
// (09-29: the Arc APEX faucet pays 300 APEX via pay(to) and emits Claim(to indexed, amount, potAfter); nothing off chain
// records those claims.) ABI copied from data/arc-apex.json (faucet.abi).
const { keccak256, toHex } = require('/root/apex-faucet/node_modules/viem');
const CONTRACT_RECORDS = {
  'arc:0x60075dc6f5f286fcf3579ff4b1500f328b8268f8': { topic0: keccak256(toHex('Claim(address,uint256,uint256)')), toTopic: 1, amountWord: 0, category: 'faucet:claim', name: 'Arc APEX faucet Claim event' },
};
// keyed by chain:full-address (registry ids are shortened, 09-29: keying by id made the rule never fire)
const contractRecorded = (chain, receipt, contractAddr, to, raw) => {
  const rule = CONTRACT_RECORDS[chain + ':' + contractAddr]; if (!rule || !receipt) return null;
  const hit = receipt.logs.find((l) => l.address === contractAddr && l.topics[0] === rule.topic0 && X.unpad(l.topics[rule.toTopic] || '0x') === to
    && BigInt('0x' + (l.data.slice(2 + 64 * rule.amountWord, 2 + 64 * (rule.amountWord + 1)) || '0')) === raw);
  return hit ? rule : null;
};
// Programs we run or trade through: a new account one of them owns is rent, and a tx invoking one of the DEX programs is
// venue evidence for a trade. IDs copied from lib/account/prices.js (XDEX, APEX AMM) and lib/faucet-pot.js (pot program).
const KNOWN_PROGRAMS = new Set([P.X1.XDEX_PROGRAM, P.X1.AMM_PROGRAM, 'J1CJDQYdJk56Cu4rEja9mqHipPzekKHtDP57e6jMgZr8']);
const SVM_VENUES = new Set([P.X1.XDEX_PROGRAM, P.X1.AMM_PROGRAM]);
const ownerCache = new Map();

(async () => {
  await require('/root/apex-faucet/lib/account/assert-sandboxed.js').assertSandboxed();   // refuses to run outside tools/account-run.sh
  const reg = R.load();
  const byId = new Map(reg.entries.map((e) => [e.id, e]));
  const ours = (chain, addr) => !!addr && R.isInternal(chain, addr);
  const db = open(); await db.init();
  // HORIZON GUARD (2026-10-06, post-mortem reconcile-rerun-horizon): a hand re-run over a window older than the Arc providers'
  // history (Blockdaemon ~70 h, beamrpc 1,000-block logs) cannot find every transaction, so it turns honest books into false
  // alerts (three were made that way on 6 Oct). Refuse BEFORE any write: exit 3, nothing stored.
  const HORIZON_H = 60;
  {
    const rr = arg('--runs'), from = arg('--from');
    let openAt = null;
    if (rr) { const a = Number(String(rr).split(/[ ,]/)[0]); const r0 = await db.get('SELECT started_at FROM runs WHERE run_id=?', [a]); openAt = r0 && r0.started_at; if (!String(rr).includes(',')) { console.error('REFUSED: --runs takes OPEN,CLOSE as one argument (e.g. --runs 314,317)'); process.exit(3); } }
    else if (from) openAt = from;
    if (openAt && Date.now() - Date.parse(openAt) > HORIZON_H * 3600000) { console.error('REFUSED: the window opens ' + openAt + ', older than ' + HORIZON_H + ' h: past the providers\' history, a re-run would invent alerts. Nothing written.'); process.exit(3); }
  }
  const runId = (await db.run('INSERT INTO runs (kind, started_at, method_version) VALUES (?,?,?)', ['reconcile', new Date().toISOString(), METHOD_VERSION])).lastID;
  const errors = [];
  const pairs = [];   // { wallet_id, chain, asset_id, open, close, decimals, status, legs:[], gap, detail }
  let window;

  // ── ledger lookups ──
  const ledgerTx = new Map();
  for (const r of await db.all('SELECT entry_id, tx, wallet_id, asset_id, amount, amount_raw, amount_basis, category, direction, source FROM ledger WHERE tx IS NOT NULL AND category <> \'superseded\'')) {
    const k = String(r.tx).toLowerCase(); if (!ledgerTx.has(k)) ledgerTx.set(k, []); ledgerTx.get(k).push(r);
  }
  const noHash = await db.all("SELECT entry_id, ts_utc, wallet_id, asset_id, amount, counterparty, direction FROM ledger WHERE tx IS NULL AND amount IS NOT NULL AND category <> 'superseded'");
  const usedNoHash = new Set();
  const verdict = (tx, walletId, asset, chainRaw, decimals, o) => C.ledgerVerdict(ledgerTx.get(String(tx).toLowerCase()), walletId, asset, chainRaw, decimals, o);
  const matchByAmount = (walletId, asset, rawAbs, decimals, counterparty, atMs, direction) => {
    const amt = Number(rawAbs) / 10 ** decimals;
    const hit = noHash.find((r) => !usedNoHash.has(r.entry_id) && r.wallet_id === walletId && r.asset_id === asset && r.direction === direction
      && Math.abs(r.amount - amt) <= Math.max(1e-9, amt * 1e-9) && (!counterparty || !r.counterparty || r.counterparty === counterparty)
      && Math.abs(Date.parse(r.ts_utc) - atMs) <= AMOUNT_MATCH_WINDOW_MS);
    if (hit) usedNoHash.add(hit.entry_id);
    return hit || null;
  };

  // ── pick the two sides ──
  const evmMode = arg('--evm');
  let openRun = null, closeRun = null;
  const bal = new Map();   // `${wallet_id}|${asset_id}` -> { open, close }  (raw BigInt, or {failed})
  const put = (w, a, side, v) => { const k = w + '|' + a; if (!bal.has(k)) bal.set(k, {}); bal.get(k)[side] = v; };

  if (!evmMode) {
    const runs = await db.all("SELECT run_id, started_at FROM runs WHERE kind='snapshot' AND complete=1 ORDER BY run_id DESC LIMIT 2");
    const rr = arg('--runs');
    if (rr) { const [a, b] = rr.split(/[ ,]/).map(Number); openRun = a; closeRun = b; } else { if (runs.length < 2) throw new Error('need two complete snapshots'); openRun = runs[1].run_id; closeRun = runs[0].run_id; }
    for (const [side, r] of [['open', openRun], ['close', closeRun]]) {
      for (const b of await db.all('SELECT * FROM balances WHERE run_id=?', [r])) {
        if (!b.ok) { put(b.wallet_id, b.asset_id, side, { failed: b.error || 'read failed' }); continue; }
        put(b.wallet_id, b.asset_id, side, { raw: BigInt(b.raw), decimals: b.decimals, at: b.block_or_slot, read_at: b.read_at });
      }
    }
    const t = await db.all('SELECT run_id, started_at, finished_at FROM runs WHERE run_id IN (?,?)', [openRun, closeRun]);
    window = { mode: 'snapshots', openRun, closeRun, open: (t.find((x) => x.run_id === openRun) || {}).started_at, close: (t.find((x) => x.run_id === closeRun) || {}).finished_at };
  } else {
    window = { mode: 'evm-history', chain: evmMode, open: arg('--from'), close: arg('--to') };
  }

  // ── what we VALUE: alarms are raised only for these ──
  const valuedSet = new Set([P.X1.APEX, P.X1.WXNT, P.X1.USDCX].map((m) => 'x1:' + m).concat(['arc:' + P.ARC.APEX.toLowerCase(), 'arc:' + P.ARC.EURC.toLowerCase(),
    'base:' + P.BASE.USDC.toLowerCase(), 'solana:' + P.SOL.USDC]));
  for (const r of await db.all("SELECT DISTINCT asset_id FROM ledger WHERE source='dip-trader' AND asset_id <> 'arc:native'")) valuedSet.add(r.asset_id);
  if (closeRun) for (const r of await db.all('SELECT DISTINCT asset_id FROM valuations WHERE run_id=? AND (spot_usd > 0 OR liquid_usd > 0)', [closeRun])) valuedSet.add(r.asset_id);
  const valued = (asset) => /:native$/.test(asset) || valuedSet.has(asset);
  // Arc venue: the v4 PoolManager (address from data/arc-apex.json poolManager); a swap there logs from it
  let evmVenues = { arc: new Set(), base: new Set() };
  // (09-29: read from the top level at first, where it is not, so no Arc sell ever had venue evidence: 42 false alarms)
  try {
    const ax = JSON.parse(fs.readFileSync('/root/apex-faucet/data/arc-apex.json', 'utf8'));
    const pm = ax.pool && ax.pool.poolManager;
    if (/^0x[0-9a-fA-F]{40}$/.test(String(pm))) evmVenues.arc.add(String(pm).toLowerCase()); else errors.push('arc venue: data/arc-apex.json pool.poolManager missing - trades cannot be recognised');
  } catch (e) { errors.push('arc venue: ' + e.message); }

  // Which side is "missing = zero": only when that wallet's token LIST read succeeded in that run (SVM), never otherwise.
  const listFailed = (w, side) => { const k = bal.get(w + '|' + (byId.get(w) || {}).chain + ':tokens'); return !!(k && k[side] && k[side].failed); };

  // ═════ SVM (x1, solana) ═════
  for (const chain of evmMode ? [] : ['x1', 'solana']) {
    const wantSvm = arg('--wallets') ? arg('--wallets').split(',') : null;
    const entries = reg.entries.filter((e) => e.chain === chain && (e.kind === 'wallet' || e.kind === 'token-account') && (!wantSvm || wantSvm.includes(e.id)));
    for (const e of entries) {
      const keys = [...bal.keys()].filter((k) => k.startsWith(e.id + '|') && !k.endsWith(':tokens'));
      const rows = keys.map((k) => ({ asset: k.split('|')[1], ...bal.get(k) }));
      const failed = rows.filter((r) => (r.open && r.open.failed) || (r.close && r.close.failed));
      // The anchor row (native balance, or the token account itself) must exist on BOTH sides: without it the wallet
      // was not read in that run, and a missing token cannot be taken as zero.
      const anchor = rows.find((r) => r.asset === chain + ':native') || (e.kind === 'token-account' ? rows[0] : null);
      const lf = listFailed(e.id, 'open') || listFailed(e.id, 'close') || !anchor || !anchor.open || !anchor.close || !!anchor.open.failed || !!anchor.close.failed;
      // side values: missing on a side whose list read succeeded = 0
      const val = (r, side) => (r[side] && !r[side].failed ? r[side].raw : (r[side] ? null : (lf ? null : 0n)));
      const changed = rows.filter((r) => { const a = val(r, 'open'), b = val(r, 'close'); return a == null || b == null || a !== b; });
      if (!changed.length && !failed.length && !lf) { for (const r of rows) pairs.push({ wallet_id: e.id, chain, asset_id: r.asset, open: val(r, 'open'), close: val(r, 'close'), decimals: (r.close || r.open).decimals, status: 'match', legs: [] }); continue; }
      // window in slots for this wallet: its own read slots in each run
      const slots = (side) => rows.map((r) => r[side] && !r[side].failed ? Number(r[side].at) : null).filter((x) => x);
      const fromSlot = Math.min(...slots('open')), toSlot = Math.max(...slots('close'));
      let effects = null, drillError = null;
      if (failed.length || lf) drillError = 'a balance read failed (or the wallet was not read) in one of the runs';
      else {
        try {
          const sigs = await X.svmSignatures(chain, e.address, fromSlot, toSlot);
          // token accounts: incoming token transfers do not list the owner, so ask each changed token account too
          if (e.kind === 'wallet') {
            const PK = require('/root/apex-faucet/node_modules/@solana/web3.js').PublicKey;
            const { getAssociatedTokenAddressSync } = require('/root/apex-faucet/node_modules/@solana/spl-token');
            for (const r of changed.filter((x) => !x.asset.endsWith(':native'))) {
              const mint = r.asset.split(':')[1];
              for (const prog of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
                const ata = getAssociatedTokenAddressSync(new PK(mint), new PK(e.address), true, new PK(prog)).toBase58();
                for (const s of await X.svmSignatures(chain, ata, fromSlot, toSlot)) if (!sigs.some((x) => x.signature === s.signature)) sigs.push(s);
              }
            }
          }
          effects = [];
          for (const s of sigs) effects.push(X.svmEffects(chain, await X.svmTx(chain, s.signature), e.address, e.kind === 'token-account'));
        } catch (x) { drillError = x.message; }
      }
      for (const r of rows) {
        const o = val(r, 'open'), c = val(r, 'close'), dec = (r.close && r.close.decimals) || (r.open && r.open.decimals) || 0;
        const p = { wallet_id: e.id, chain, asset_id: r.asset, open: o, close: c, decimals: dec, legs: [] };
        pairs.push(p);
        if (o == null || c == null || drillError) { p.status = 'incomplete'; p.detail = drillError || 'balance missing on one side'; continue; }
        // this pair's own window: the slots its two balances were read at (the anchor's slot for a side with no row)
        const po = Number((r.open || anchor.open).at), pc = Number((r.close || anchor.close).at);
        const inWin = effects.filter((f) => f.slot > po && f.slot <= pc);
        p.slots = [po, pc];
        if (o === c && !inWin.some((f) => f.effects.some((x) => x.asset === r.asset))) { p.status = 'match'; continue; }
        let sum = 0n;
        for (const f of inWin) for (const ef of f.effects.filter((x) => x.asset === r.asset)) {
          sum += ef.raw;
          const leg = { tx: f.sig, slot: f.slot, at: f.blockTime ? new Date(f.blockTime * 1000).toISOString() : null, raw: ef.raw, failedTx: !!f.err };
          const isNative = r.asset.endsWith(':native');
          const lv = verdict(f.sig, e.id, r.asset, ef.raw, dec, { feeRaw: isNative ? ef.feePaid : 0n });
          const g = ef.gainers || [];
          const cps = isNative ? g.map((x) => x.tokenOwner || x.account) : g.map((x) => x.holder);
          leg.counterparty = cps.slice(0, 3);
          const allOurs = g.length > 0 && (isNative ? g.every((x) => ours(chain, x.account) || (x.tokenOwner && (x.tokenOwner === e.address || ours(chain, x.tokenOwner)))) : g.every((x) => ours(chain, x.holder)));
          let res;
          if (ef.raw > 0n) {
            const losers = (ef.losers || []).map((x) => x.holder);
            res = C.classifyInflow({ valued: valued(r.asset), ledger: lv, allCounterpartiesOurs: !isNative && losers.length > 0 && losers.every((h) => ours(chain, h)) });
          } else {
            const beyondFee = isNative ? -ef.raw - (ef.feePaid || 0n) : 0n;
            let rent = false;
            if (isNative && beyondFee > 0n && g.length) {
              for (const x of g) if (!x.tokenAccount && !ownerCache.has(x.account)) ownerCache.set(x.account, await X.svmOwner(chain, x.account));
              rent = C.rentOk(g, e.address, (a2) => ours(chain, a2), ownerCache, KNOWN_PROGRAMS, RENT_MAX[chain]);
            }
            const trade = C.svmTradeEvidence(f.effects, r.asset, valued, f.programs, SVM_VENUES);
            const amt = isNative ? beyondFee : -ef.raw;
            res = C.classifyOutflow({ valued: valued(r.asset), ledger: lv, feeOnly: isNative && beyondFee <= 0n, allCounterpartiesOurs: allOurs, tradeEvidence: trade, rentOk: rent,
              amountMatch: !!matchByAmount(e.id, r.asset, amt, isNative ? 9 : dec, cps[0], (f.blockTime || 0) * 1000, 'out'),
              burned: !isNative && !g.length && ef.supplyDelta < 0n });
            if (isNative) leg.feeRaw = ef.feePaid || 0n;
          }
          leg.kind = res.kind; if (res.note) leg.note = res.note; if (res.diff) leg.ledgerVsChain = res.diff;
          p.legs.push(leg);
        }
        p.gap = (c - o) - sum;
        p.status = p.gap !== 0n ? 'unaccounted' : p.legs.some((l) => C.ALARM_KINDS.has(l.kind)) ? 'alert' : 'reconciled';
      }
    }
  }

  // ═════ EVM (arc, base) ═════
  for (const chain of evmMode ? [evmMode] : ['arc', 'base']) {
    const want = arg('--wallets') ? arg('--wallets').split(',') : null;
    const entries = reg.entries.filter((e) => e.chain === chain && (e.kind === 'wallet' || e.kind === 'contract') && (!want || want.includes(e.id)));
    if (!entries.length) continue;
    let fromBlock, toBlock;
    try {
      if (evmMode) { fromBlock = await X.evmBlockAtTime(chain, window.open); toBlock = await X.evmBlockAtTime(chain, window.close); }
      else {
        const bl = (side) => [...bal.entries()].filter(([k, v]) => byId.get(k.split('|')[0]) && byId.get(k.split('|')[0]).chain === chain && v[side] && !v[side].failed).map(([, v]) => BigInt(v[side].at));
        fromBlock = bl('open')[0]; toBlock = bl('close')[0];
        if (fromBlock == null || toBlock == null) throw new Error('no pinned block for ' + chain + ' in one of the runs');
      }
    } catch (x) { errors.push(chain + ' window: ' + x.message); for (const e of entries) pairs.push({ wallet_id: e.id, chain, asset_id: chain + ':native', status: 'incomplete', detail: x.message, legs: [] }); continue; }
    window[chain] = { fromBlock: fromBlock.toString(), toBlock: toBlock.toString() };
    let moves, receipts, drillError = null;
    try {
      // only real contract addresses (valued ids also include LP positions such as 'arc:lp-64259', which are not contracts)
      const contracts = [...valuedSet].filter((x) => x.startsWith(chain + ':')).map((x) => x.split(':')[1]).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x)).concat(chain === 'arc' ? [X.ARC_NATIVE_LOG] : []);
      const got = await X.evmMovements(chain, entries.map((e) => e.address), fromBlock, toBlock, contracts);
      window[chain].logContracts = contracts.length;
      moves = got.moves; window[chain].nftTransfers = got.nfts.length;
      receipts = await X.evmReceipts(chain, [...new Set(moves.map((m) => m.tx))]);
    } catch (x) { drillError = x.message; errors.push(chain + ' logs: ' + x.message); }
    for (const e of entries) {
      const a = e.address.toLowerCase();
      const mine = drillError ? [] : moves.filter((m) => m.from === a || m.to === a);
      const assets = new Set([chain + ':native', ...mine.map((m) => m.asset)]);
      for (const k of bal.keys()) if (k.startsWith(e.id + '|')) assets.add(k.split('|')[1]);
      let nonceOpen = null, nonceClose = null;
      if (e.kind === 'wallet' && !drillError) { try { nonceOpen = await X.evmNonce(chain, e.address, fromBlock); nonceClose = await X.evmNonce(chain, e.address, toBlock); } catch (x) { drillError = drillError || 'nonce: ' + x.message; } }
      let sentTxs = drillError ? [] : [...receipts.entries()].filter(([, r]) => r.from === a).map(([h, r]) => ({ h, gas: r.gas }));
      let sendSearch = null;
      if (e.kind === 'wallet' && !drillError && nonceOpen != null && Number(nonceClose - nonceOpen) > sentTxs.length) {
        try {
          const known = [];
          for (const t of sentTxs) { const k = await X.evmTxNonce(chain, t.h); known.push({ nonce: k.nonce, block: k.block }); }
          const extra = await X.evmFindSent(chain, e.address, fromBlock, toBlock, Number(nonceOpen), Number(nonceClose), known, 400);
          const rc = await X.evmReceipts(chain, extra.map((x) => x.hash));
          for (const x of extra) sentTxs.push({ h: x.hash, gas: rc.get(x.hash).gas, noLog: true });
          sendSearch = 'found ' + extra.length + ' sent tx without a Transfer log by nonce';
        } catch (x) { sendSearch = 'nonce search failed: ' + x.message; }
      }
      const spareGas = sentTxs.filter((t) => t.noLog).map((t) => ({ h: t.h, gas: t.gas, used: null }));
      for (const asset of assets) {
        const p = { wallet_id: e.id, chain, asset_id: asset, legs: [] };
        pairs.push(p);
        // balances: snapshot rows when this asset was snapshotted, else read at the two blocks (archive)
        const s = bal.get(e.id + '|' + asset);
        try {
          if (!evmMode && s && ((s.open && s.open.failed) || (s.close && s.close.failed))) {
            throw new Error('snapshot read failed: ' + ((s.open && s.open.failed) || s.close.failed));   // a failed read is never replaced by a guess
          } else if (!evmMode && s && s.open && s.close) {
            p.open = s.open.raw; p.close = s.close.raw; p.decimals = s.close.decimals;
          } else if (!evmMode && s && asset === chain + ':native' && (s.open || s.close)) {
            // one side was never read (the wallet was registered between the two snapshots): EVM state at a past block is
            // exact (archive reads agree on four endpoints), so that side is read at the snapshot's own block
            p.open = s.open ? s.open.raw : BigInt((await evm.nativeBalance(chain, e.address, fromBlock)).raw);
            p.close = s.close ? s.close.raw : BigInt((await evm.nativeBalance(chain, e.address, toBlock)).raw);
            p.decimals = 18; p.detail = 'not in the ' + (s.open ? 'closing' : 'opening') + ' snapshot: read at block ' + (s.open ? toBlock : fromBlock);
          } else if (asset === chain + ':native') {
            p.open = BigInt((await evm.nativeBalance(chain, e.address, fromBlock)).raw); p.close = BigInt((await evm.nativeBalance(chain, e.address, toBlock)).raw); p.decimals = 18;
          } else {
            const tok = asset.split(':')[1];
            p.open = await tokenBalanceAt(chain, tok, e.address, fromBlock); p.close = await tokenBalanceAt(chain, tok, e.address, toBlock);
            p.decimals = null;
          }
        } catch (x) {
          if (x.unreadableToken) {
            // A live contract whose balanceOf reverts, yet emits Transfer logs naming our wallet: the address-poisoning pattern
            // (e.g. a fake "USDC" with 18 decimals). Its logs are not value; they are listed, never alarmed, never valued.
            p.status = 'unreadable-token'; p.detail = x.message;
            p.legs = mine.filter((m) => m.asset === asset).map((m) => ({ tx: m.tx, raw: (m.to === a ? m.raw : 0n) - (m.from === a ? m.raw : 0n), kind: 'unreadable-token' }));
            continue;
          }
          p.status = 'incomplete'; p.detail = x.message; continue;
        }
        if (drillError) { p.status = 'incomplete'; p.detail = drillError; continue; }
        let sum = 0n;
        for (const m of mine.filter((x) => x.asset === asset)) {
          const d = (m.to === a ? m.raw : 0n) - (m.from === a ? m.raw : 0n);
          if (d === 0n) { if (m.from === a && m.to === a) p.legs.push({ tx: m.tx, block: m.block.toString(), raw: 0n, kind: 'self' }); continue; }
          sum += d;
          const other = m.to === a ? m.from : m.to;
          const txAll = mine.filter((x) => x.tx === m.tx);
          const leg = { tx: m.tx, block: m.block.toString(), raw: d, counterparty: [other] };
          const dec = asset === chain + ':native' ? 18 : (p.decimals != null ? p.decimals : null);
          const own = sentTxs.find((t) => t.h.toLowerCase() === m.tx.toLowerCase());
          const lv = verdict(m.tx, e.id, asset, d, dec, asset === chain + ':native' ? { gasRaw: own ? own.gas : 0n, spareGas } : {});
          let res;
          if (d > 0n) res = C.classifyInflow({ valued: valued(asset), ledger: lv, allCounterpartiesOurs: ours(chain, other) });
          else {
            const rc = receipts.get(m.tx);
            res = C.classifyOutflow({ valued: valued(asset), ledger: lv, contractEvent: !!contractRecorded(chain, rc, a, other, -d),
              allCounterpartiesOurs: ours(chain, other), tradeEvidence: C.evmTradeEvidence(txAll, a, asset, valued, rc && rc.logs, evmVenues[chain] || new Set()),
              burned: other === '0x0000000000000000000000000000000000000000' });
            if (res.kind === 'recorded-by-contract-event') leg.note = CONTRACT_RECORDS[chain + ':' + a].name;
          }
          leg.kind = res.kind; if (res.note) leg.note = res.note; if (res.diff) leg.ledgerVsChain = res.diff;
          p.legs.push(leg);
        }
        if (asset === chain + ':native') {
          for (const t of sentTxs) { sum -= t.gas; p.legs.push({ tx: t.h, raw: -t.gas, kind: 'fee', gas: true }); }   // gas of this wallet's own sent txs
          if (nonceOpen != null) {
            const undiscovered = Number(nonceClose - nonceOpen) - sentTxs.length;
            p.sent = { nonceDelta: Number(nonceClose - nonceOpen), found: sentTxs.length, notFound: undiscovered, search: sendSearch };
            if (undiscovered > 0) p.unlocated = undiscovered;   // their gas is unknown: the pair cannot be closed
          }
        }
        p.gap = (p.close - p.open) - sum;
        // Never zero a gap by estimate (Fable review v2 #16): sent txs that could not be located leave the pair incomplete.
        if (p.unlocated) { p.status = 'incomplete'; p.detail = p.unlocated + ' sent tx not located (' + sendSearch + '); gap ' + p.gap; continue; }
        p.status = p.gap !== 0n ? 'unaccounted' : p.legs.some((l) => C.ALARM_KINDS.has(l.kind)) ? 'alert' : (p.open === p.close && !p.legs.length ? 'match' : 'reconciled');
      }
    }
  }

  // ── ledger rows inside the window that the chain never showed (a claimed payment that did not happen) ──
  const drilledTx = new Set(pairs.flatMap((p) => p.legs.map((l) => String(l.tx || '').toLowerCase())));
  const drilledWallets = new Set(pairs.filter((p) => p.status !== 'incomplete' && p.status !== 'match').map((p) => p.wallet_id));
  const slack = 5 * 60e3, wo = Date.parse(window.open), wc = Date.parse(window.close);
  const ghostRows = (await db.all("SELECT entry_id, ts_utc, wallet_id, tx, asset_id, amount, source FROM ledger WHERE tx IS NOT NULL AND wallet_id IS NOT NULL AND category <> 'superseded'"))
    .filter((r) => /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/.test(String(r.tx)) && drilledWallets.has(r.wallet_id) && Date.parse(r.ts_utc) > wo + slack && Date.parse(r.ts_utc) < wc - slack && !drilledTx.has(String(r.tx).toLowerCase())
      && pairs.some((p) => p.wallet_id === r.wallet_id && p.asset_id === r.asset_id));

  // ── prices for alert values (close run; Arc/Base USDC at par) ──
  const priceOf = new Map();
  if (closeRun) for (const p of await db.all('SELECT asset_id, usd FROM prices WHERE run_id=?', [closeRun])) priceOf.set(p.asset_id, p.usd);
  priceOf.set('arc:native', 1);
  const usdOf = (p, raw) => { const u = priceOf.get(p.asset_id); return u != null && p.decimals != null ? Number(raw) / 10 ** p.decimals * u : null; };

  // ── write recon rows and alerts ──
  const alerts = [];
  const alertKey = new Set();
  for (const p of pairs) {
    const ALARM = new Set(['OUTFLOW-UNRECORDED', 'BURN-UNRECORDED']);
    const explained = p.legs.filter((l) => !ALARM.has(l.kind)).reduce((t, l) => t + l.raw, 0n);
    // A pair we could not verify still alarms when a VALUED balance fell (Fable review v2 #4): silence is not success.
    if ((p.status === 'incomplete' || p.status === 'unreadable-token') && p.open != null && p.close != null && p.close < p.open && valued(p.asset_id)
      && !(p.asset_id.endsWith(':native') && RENT_MAX[p.chain] != null && p.open - p.close <= RENT_MAX[p.chain])) {
      alerts.push({ kind: 'drop-unverified', wallet_id: p.wallet_id, chain: p.chain, tx: 'drop:' + p.wallet_id + ':' + p.asset_id + ':' + (window.openRun || window.open) + '-' + (window.closeRun || window.close),
        asset_id: p.asset_id, raw: String(p.close - p.open), amount: p.decimals != null ? Number(p.close - p.open) / 10 ** p.decimals : null, usd: usdOf(p, p.close - p.open), note: 'a valued balance fell and the transactions could not be read: ' + String(p.detail || '').slice(0, 160) });
    }
    for (const l of p.legs.filter((x) => x.kind === 'RECORDED-AMOUNT-DIFFERS')) {
      const a = { kind: 'ledger-amount-mismatch', wallet_id: p.wallet_id, chain: p.chain, tx: l.tx, asset_id: p.asset_id, ledger: l.ledgerVsChain.ledger, chainAmount: l.ledgerVsChain.chain, sources: l.ledgerVsChain.sources, note: 'the ledger has this hash with a different amount than the chain moved' };
      if (!alertKey.has(a.kind + a.tx + p.asset_id)) { alertKey.add(a.kind + a.tx + p.asset_id); alerts.push(a); }
    }
    const unexplained = p.legs.filter((l) => ALARM.has(l.kind)).reduce((t, l) => t + l.raw, 0n) + (p.gap || 0n);
    await db.run('INSERT INTO recon (run_id, period_start, period_end, wallet_id, chain, asset_id, open_amt, close_amt, chain_delta, explained_delta, fee_estimate, unexplained, unexplained_usd, status, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [runId, window.open, window.close, p.wallet_id, p.chain, p.asset_id, p.open == null ? null : String(p.open), p.close == null ? null : String(p.close),
        p.open == null || p.close == null ? null : String(p.close - p.open), String(explained), p.legs.filter((l) => l.gas || l.kind === 'fee').reduce((t, l) => t + l.raw, 0n).toString(),
        String(unexplained), unexplained === 0n ? 0 : usdOf(p, unexplained), p.status,
        JSON.stringify({ decimals: p.decimals, gap: p.gap != null ? String(p.gap) : null, sent: p.sent || null, detail: p.detail || null, legs: p.legs.length })]);
    for (const l of p.legs.filter((x) => ALARM.has(x.kind))) {
      const a = { kind: l.kind === 'BURN-UNRECORDED' ? 'unrecorded-burn' : 'unrecorded-outflow', wallet_id: p.wallet_id, chain: p.chain, tx: l.tx, asset_id: p.asset_id, raw: String(l.raw), amount: p.decimals != null ? Number(l.raw) / 10 ** p.decimals : null, usd: usdOf(p, l.raw), to: l.counterparty };
      if (!alertKey.has(a.kind + a.tx)) { alertKey.add(a.kind + a.tx); alerts.push(a); }
    }
    if (p.gap && p.gap !== 0n) alerts.push({ kind: 'unaccounted-delta', wallet_id: p.wallet_id, chain: p.chain, tx: 'delta:' + p.wallet_id + ':' + p.asset_id + ':' + (window.openRun || window.open) + '-' + (window.closeRun || window.close),
      asset_id: p.asset_id, raw: String(p.gap), amount: p.decimals != null ? Number(p.gap) / 10 ** p.decimals : null, usd: usdOf(p, p.gap), note: 'the balance changed by more (or less) than every transaction the chain shows for this wallet' });
  }
  for (const g of ghostRows) alerts.push({ kind: 'ledger-not-on-chain', wallet_id: g.wallet_id, chain: g.wallet_id.split(':')[0], tx: g.tx, asset_id: g.asset_id, amount: g.amount, note: 'ledger row from ' + g.source + ' inside the window, not seen on chain for this wallet' });
  for (const a of alerts) await db.run('INSERT OR IGNORE INTO alerts (at, kind, wallet_id, chain, tx, amount_usd, detail, run_id, method_version) VALUES (?,?,?,?,?,?,?,?,?)', [new Date().toISOString(), a.kind, a.wallet_id, a.chain, a.tx, a.usd, JSON.stringify(a), runId, METHOD_VERSION]);
  // An older alert whose transaction this run explains is marked superseded, never deleted (Fable review v2 #14).
  const explainedTx = new Set(pairs.flatMap((p) => p.legs.filter((l) => l.tx && !C.ALARM_KINDS.has(l.kind)).map((l) => String(l.tx).toLowerCase())));
  const alarmedTx = new Set(alerts.map((a) => String(a.tx).toLowerCase()));
  // M4 (Fable recorder review): a 'delta:' or 'drop:' alert is keyed by (wallet, asset, window). A later run over the SAME
  // window that finds that pair clean closes it; without this such an alert could never close, honestly or otherwise.
  const winKey = (window.openRun || window.open) + '-' + (window.closeRun || window.close);
  const cleanWindowKeys = new Set();
  for (const p of pairs) {
    const k = p.wallet_id + ':' + p.asset_id + ':' + winKey;
    if (p.status !== 'incomplete' && p.status !== 'unreadable-token' && !(p.gap && p.gap !== 0n)) { cleanWindowKeys.add(('delta:' + k).toLowerCase()); cleanWindowKeys.add(('drop:' + k).toLowerCase()); }
  }
  let retracted = 0;
  for (const o of await db.all('SELECT alert_id, tx FROM alerts WHERE superseded_by IS NULL AND (run_id IS NULL OR run_id <> ?)', [runId])) {
    const t = String(o.tx).toLowerCase();
    // a 'ledger-not-on-chain' alert on an id that is not a chain hash (a Circle Gateway settlement id) was a method error
    // Base58 is case-SENSITIVE: lowercase i and o are valid, uppercase I and O are not. The old class [1-9a-hj-np-z] with /i
    // dropped both, so ~95% of X1/Solana hashes read as "not a chain hash" and their alerts closed themselves in the next
    // run, explained or not (found 2026-09-29 by the money-movers inventory; alerts 310, 313, 314 closed that way).
    const notChain = !C.isChainRef(o.tx) && !/^(delta|drop):/i.test(String(o.tx));
    if ((explainedTx.has(t) && !alarmedTx.has(t)) || (cleanWindowKeys.has(t) && !alarmedTx.has(t)) || notChain) { await db.run('UPDATE alerts SET superseded_by=? WHERE alert_id=?', [runId, o.alert_id]); retracted++; }
  }

  const count = (f) => pairs.filter(f).length;
  const legKinds = {};
  for (const p of pairs) for (const l of p.legs) { const k = l.kind + (l.estimated ? ' (estimated)' : ''); legKinds[k] = (legKinds[k] || 0) + 1; }
  const incomplete = pairs.filter((p) => p.status === 'incomplete');
  const summary = {
    runId, window, pairs: pairs.length,
    status: { match: count((p) => p.status === 'match'), reconciled: count((p) => p.status === 'reconciled'), alert: count((p) => p.status === 'alert'), unaccounted: count((p) => p.status === 'unaccounted'), incomplete: incomplete.length, unreadableToken: count((p) => p.status === 'unreadable-token') },
    movements: legKinds, alerts: alerts.length, olderAlertsNowExplained: retracted, errors, methodVersion: METHOD_VERSION, valuedAssets: valuedSet.size,
    venues: { arc: evmVenues.arc.size, svm: SVM_VENUES.size },
    // revenue side: value that ARRIVED and that no ledger row explains (a payment with no settlement row, a refund, a gift)
    unrecordedInflows: pairs.flatMap((p) => p.legs.filter((l) => l.kind === 'inflow-unrecorded').map((l) => ({ wallet_id: p.wallet_id, asset_id: p.asset_id,
      amount: p.decimals != null ? Number(l.raw) / 10 ** p.decimals : null, raw: String(l.raw), from: (l.counterparty || [])[0] || null, tx: l.tx }))).slice(0, 50),
  };
  const ser = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const report = { summary, alerts: ser(alerts), incomplete: ser(incomplete.map((p) => ({ wallet_id: p.wallet_id, asset_id: p.asset_id, detail: p.detail }))),
    changed: ser(pairs.filter((p) => p.status !== 'match').map((p) => ({ wallet_id: p.wallet_id, label: (byId.get(p.wallet_id) || {}).label, asset_id: p.asset_id, decimals: p.decimals, open: p.open, close: p.close, status: p.status, gap: p.gap, sent: p.sent, legs: p.legs }))) };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'recon-' + runId + '.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 1));
  await db.run('UPDATE runs SET finished_at=?, complete=?, summary_json=?, errors_json=? WHERE run_id=?', [new Date().toISOString(), incomplete.length || errors.length ? 0 : 1, JSON.stringify(summary), JSON.stringify(errors), runId]);
  await db.close();
  console.log(JSON.stringify(Object.assign({ report: file }, ser(summary)), null, 1));
  for (const a of alerts) console.log('ALERT ' + a.kind + ' ' + a.wallet_id + ' ' + a.asset_id + ' ' + (a.amount != null ? a.amount : a.raw) + (a.usd != null ? ' ($' + a.usd.toFixed(4) + ')' : '') + ' ' + a.tx);
  process.exit(incomplete.length || errors.length ? 3 : alerts.length ? 2 : 0);
})().catch((e) => { console.error('RECONCILE FAILED: ' + (e && e.stack || e)); process.exit(1); });
