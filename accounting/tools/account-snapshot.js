#!/usr/bin/env node
'use strict';
// ACCOUNT LAYER P2: snapshot (2026-09-29). Read-only. Every registry balance on X1, Solana, Arc and Base; prices from
// pools read in the same run; the Arc trader's positions checked against the chain; our Arc v4 LP positions with their
// owners checked on chain; then spot and liquid value per holding and one NAV split by owner class and chain.
// A failed read is stored as a failed row and makes the run incomplete. An incomplete run is never compared with another.
// Run in the account sandbox: sudo tools/account-run.sh node tools/account-snapshot.js
const fs = require('fs');
const R = require('/root/apex-faucet/lib/account/registry.js');
const { open } = require('/root/apex-faucet/lib/account/db.js');
const svm = require('/root/apex-faucet/lib/account/chains/svm.js');
const evm = require('/root/apex-faucet/lib/account/chains/evm.js');
const P = require('/root/apex-faucet/lib/account/prices.js');
const { parseAbi, keccak256, encodeAbiParameters } = require('/root/apex-faucet/node_modules/viem');

// 2 (2026-09-29, after the Fable review): LP positions must hash to the APEX pool; Arc APEX is flagged self-priced and its
// liquid value is a sale quote into OUTSIDE liquidity only; X1 APEX liquid is one joint sale of everything we hold (incl.
// LP-underlying APEX), not per-class quotes that each assume they sell first; a stale trader mark gives no liquid value.
const METHOD_VERSION = 2;
// Selling token1 for token0 in a v4 pool, using only liquidity L inside the CURRENT tick-spacing range: the liquidity beyond
// that boundary is not read, so this is a lower bound on what the sale returns, never an upper one. Raw units in and out.
function v4SellToken1LowerBound(L, sqrtPX96, tick, tickSpacing, feePpm, qRaw) {
  if (!(L > 0n) || !(qRaw > 0)) return 0;
  const sp = Number(sqrtPX96) / 2 ** 96;
  const spUpper = Math.pow(1.0001, ((Math.floor(tick / tickSpacing) + 1) * tickSpacing) / 2);
  const spNew = Math.min(sp + (qRaw * (1 - feePpm / 1e6)) / Number(L), spUpper);
  return Number(L) * (1 / sp - 1 / spNew);
}
const TRADER_STATE = '/home/claudeuser/core/data/arc-dip-trader.json';
const now = () => new Date().toISOString();
const ui = P.ui;

(async () => {
  await require('/root/apex-faucet/lib/account/assert-sandboxed.js').assertSandboxed();   // refuses to run outside tools/account-run.sh
  const reg = R.load();
  const db = open(); await db.init();
  const started = now();
  const runId = (await db.run('INSERT INTO runs (kind, started_at, method_version) VALUES (?,?,?)', ['snapshot', started, METHOD_VERSION])).lastID;
  const errors = [];
  const err = (what, e) => { const m = what + ': ' + String(e && e.message || e).slice(0, 200); errors.push(m); return m; };
  const priceRows = [];
  const balRows = [];

  // ── 1. prices, read now, from pools ──
  let x1p = null, arcBlock = null, baseBlock = null, arcApex = null, ethUsd = null, arcTime = null, baseTime = null;
  try { x1p = await P.x1Prices(); priceRows.push(...x1p.records); } catch (e) { err('x1 prices', e); }
  try { arcBlock = (await evm.blockNumber('arc')).block; arcTime = await evm.blockTime('arc', arcBlock); } catch (e) { err('arc block', e); }
  try { baseBlock = (await evm.blockNumber('base')).block; baseTime = await evm.blockTime('base', baseBlock); } catch (e) { err('base block', e); }
  if (arcBlock != null) { try { arcApex = await P.arcApexPrice(arcBlock); priceRows.push(arcApex); } catch (e) { err('arc APEX price', e); } }
  if (baseBlock != null) { try { ethUsd = await P.baseEthUsd(baseBlock); priceRows.push(ethUsd); } catch (e) { err('base ETH price', e); } }
  priceRows.push({ asset_id: 'arc:native', method: 'par', usd: 1, source: 'par (native USDC)', source_detail: {}, flags: [] });
  priceRows.push({ asset_id: 'base:' + P.BASE.USDC.toLowerCase(), method: 'par', usd: 1, source: 'par (USDC)', source_detail: {}, flags: [] });
  priceRows.push({ asset_id: 'solana:' + P.SOL.USDC, method: 'par', usd: 1, source: 'par (USDC)', source_detail: {}, flags: [] });

  // ── 2. balances ──
  const addBal = (e, asset_id, r, extra) => balRows.push(Object.assign({ wallet_id: e.id, chain: e.chain, address: e.address, asset_id, raw: r.raw,
    decimals: r.decimals, amount: ui(r.raw, r.decimals), rpc_url: r.url, block_or_slot: String(r.slot != null ? r.slot : r.block), ok: 1, error: null }, extra || {}));
  const failBal = (e, asset_id, e2) => balRows.push({ wallet_id: e.id, chain: e.chain, address: e.address, asset_id, raw: null, decimals: null, amount: null,
    rpc_url: null, block_or_slot: null, ok: 0, error: err(e.chain + ' ' + e.id + ' ' + asset_id, e2) });
  for (const e of reg.entries.filter((x) => x.active !== false && (x.chain === 'x1' || x.chain === 'solana'))) {
    if (e.kind === 'token-account') {
      try { const t = await svm.tokenAccount(e.chain, e.address); addBal(e, e.chain + ':' + t.mint, t); } catch (x) { failBal(e, e.chain + ':token-account', x); }
      continue;
    }
    try { addBal(e, e.chain + ':native', await svm.nativeBalance(e.chain, e.address)); } catch (x) { failBal(e, e.chain + ':native', x); }
    try { for (const t of await svm.tokenBalances(e.chain, e.address)) addBal(e, e.chain + ':' + t.mint, t); } catch (x) { failBal(e, e.chain + ':tokens', x); }
  }
  // One more pass for SVM reads that failed (usually a 429 from the shared X1 budget). A retried read that succeeds is a
  // real chain answer and replaces the failure; one that fails again stays a failure and the run stays incomplete.
  for (const f of balRows.filter((b) => !b.ok && (b.chain === 'x1' || b.chain === 'solana'))) {
    const e = reg.entries.find((x) => x.id === f.wallet_id);
    try {
      let got = [];
      if (f.asset_id.endsWith(':native')) got = [[f.chain + ':native', await svm.nativeBalance(e.chain, e.address)]];
      else if (f.asset_id.endsWith(':tokens')) got = (await svm.tokenBalances(e.chain, e.address)).map((t) => [f.chain + ':' + t.mint, t]);
      else if (f.asset_id.endsWith(':token-account')) { const t = await svm.tokenAccount(e.chain, e.address); got = [[f.chain + ':' + t.mint, t]]; }
      balRows.splice(balRows.indexOf(f), 1);
      for (const [aid, r] of got) addBal(e, aid, r, { retried: 1 });
      const i = errors.indexOf(f.error); if (i >= 0) errors.splice(i, 1);
    } catch (x) { /* still failing: the failure row and the error stay */ }
  }
  // Arc trader positions: the tokens to read for the trader wallet.
  let trader = null; try { trader = JSON.parse(fs.readFileSync(TRADER_STATE, 'utf8')); } catch (e) { err('arc trader state', e); }
  const traderPos = trader ? Object.values(trader.positions || {}) : [];
  for (const e of reg.entries.filter((x) => x.active !== false && (x.chain === 'arc' || x.chain === 'base') && x.kind !== 'lp-position')) {
    const block = e.chain === 'arc' ? arcBlock : baseBlock;
    if (block == null) { failBal(e, e.chain + ':native', new Error('no pinned block')); continue; }
    try { const r = await evm.nativeBalance(e.chain, e.address, block); addBal(e, e.chain + ':native', Object.assign(r, { block })); } catch (x) { failBal(e, e.chain + ':native', x); }
    const tokens = e.chain === 'arc' ? [[P.ARC.APEX, 9], [P.ARC.EURC, 6]] : [[P.BASE.USDC, 6]];
    if (e.chain === 'arc' && e.role === 'trader') for (const p of traderPos) tokens.push([p.token, p.u && p.u.dec != null ? p.u.dec : 18]);
    for (const [tok, dec] of tokens) {
      try { const r = await evm.erc20Balance(e.chain, tok, e.address, block); if (r.raw !== '0') addBal(e, e.chain + ':' + tok.toLowerCase(), { raw: r.raw, decimals: dec, url: r.url, block }); }
      catch (x) { failBal(e, e.chain + ':' + tok.toLowerCase(), x); }
    }
  }

  // ── 3. Arc v4 LP positions (ours and the founder's), owner checked on chain ──
  const lpRows = [];
  let poolLiquidity = null, apexPoolKey = null, apexSlot = null;
  const STATE_ABI = parseAbi(['function getLiquidity(bytes32 poolId) view returns (uint128)']);
  if (arcBlock != null) {
    try { poolLiquidity = (await evm.read('arc', P.ARC.STATE_VIEW, STATE_ABI, 'getLiquidity', [P.ARC.APEX_POOL], arcBlock)).value; } catch (e) { err('arc pool liquidity', e); }
    for (const e of reg.entries.filter((x) => x.kind === 'lp-position' && x.chain === 'arc')) {
      try {
        const pos = await evm.v4Position('arc', e.address, e.position_id, arcBlock);
        // identity: the position must be in the APEX pool (Fable review 6b), or its amounts mean something else
        const k = pos.poolKey;
        const pid = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
          [k.currency0, k.currency1, Number(k.fee), Number(k.tickSpacing), k.hooks]));
        if (pid.toLowerCase() !== P.ARC.APEX_POOL.toLowerCase()) throw new Error('position #' + e.position_id + ' is in pool ' + pid + ', not the APEX pool');
        apexPoolKey = k;
        const slot = await evm.v4Slot0('arc', P.ARC.STATE_VIEW, P.ARC.APEX_POOL, arcBlock);
        apexSlot = slot;
        const am = evm.positionAmounts(pos.liquidity, slot.sqrtPriceX96, pos.tickLower, pos.tickUpper);
        const usdc = am.raw0 / 1e18, apex = am.raw1 / 1e9;
        const expected = (String(e.notes).match(/0x[0-9a-fA-F]{40}/) || [])[0];
        const inRange = slot.tick >= pos.tickLower && slot.tick < pos.tickUpper;
        lpRows.push({ e, owner: pos.owner, ownerMatches: expected ? pos.owner.toLowerCase() === expected.toLowerCase() : null, liquidity: pos.liquidity, inRange, usdc, apex });
      } catch (x) { lpRows.push({ e, error: err('arc lp #' + e.position_id, x) }); }
    }
  }
  // Only liquidity that is NOT ours can buy our Arc APEX from us: our own LP buying our own APEX is not a sale.
  const oursInRange = lpRows.filter((l) => !l.error && l.inRange).reduce((s, l) => s + l.liquidity, 0n);
  const outsideShare = poolLiquidity && poolLiquidity > 0n ? Math.max(0, Number(poolLiquidity - oursInRange) / Number(poolLiquidity)) : 0;
  const outsideL = poolLiquidity != null && poolLiquidity > oursInRange ? poolLiquidity - oursInRange : 0n;
  if (arcApex) {
    if (outsideShare < 0.5) arcApex.flags.push('self-priced: ' + (outsideShare * 100).toFixed(1) + '% of in-range liquidity is not ours');
    if (x1p && x1p.apexUsd > 0) { const r = arcApex.usd / x1p.apexUsd; if (r > 1.5 || r < 1 / 1.5) arcApex.flags.push('diverges from X1: ' + r.toFixed(1) + 'x the X1 price'); }
  }

  // ── 4. valuation per holding ──
  const price = new Map(priceRows.map((p) => [p.asset_id, p]));
  const otherX1Mints = [...new Set(balRows.filter((b) => b.ok && b.chain === 'x1' && b.asset_id !== 'x1:native').map((b) => b.asset_id.slice(3)))]
    .filter((m) => ![P.X1.WXNT, P.X1.APEX, P.X1.USDCX].includes(m) && !(x1p && x1p.lp[m]));
  let screener = new Map(); try { screener = await P.screenerPools(otherX1Mints); } catch (e) { err('screener pools', e); }
  const vals = [], unpriced = [];
  const entryOf = new Map(reg.entries.map((e) => [e.id, e]));
  for (const b of balRows.filter((x) => x.ok)) {
    const e = entryOf.get(b.wallet_id); const oc = e.owner_class;
    if (oc === 'external') continue;
    const v = { wallet_id: b.wallet_id, owner_class: oc, chain: b.chain, asset_id: b.asset_id, amount: b.amount, spot_usd: null, liquid_usd: null, method: null, flags: [] };
    const mint = b.asset_id.split(':')[1];
    if (b.chain === 'x1') {
      if (!x1p) { v.method = 'unpriced'; v.flags.push('x1 prices failed'); }
      else if (b.asset_id === 'x1:native' || mint === P.X1.WXNT) { v.spot_usd = v.liquid_usd = b.amount * x1p.xntUsd; v.method = 'spot'; }
      else if (mint === P.X1.USDCX) { v.spot_usd = v.liquid_usd = b.amount; v.method = 'par'; v.flags.push('bridged'); }
      else if (mint === P.X1.APEX) { v.spot_usd = b.amount * x1p.apexUsd; v.method = 'spot+cp-by-class'; }
      else if (x1p.lp[mint]) {
        const lp = x1p.lp[mint], share = b.amount / lp.supply;
        v.spot_usd = share * lp.xnt * x1p.xntUsd + share * lp.apex * x1p.apexUsd;
        v.liquid_usd = share * lp.xnt * x1p.xntUsd + P.cpSell(share * lp.apex, x1p.apexPool.apex, x1p.apexPool.xnt, 0.003) * x1p.xntUsd;
        v.method = 'lp-underlying'; v.flags.push(lp.name);
      } else if (screener.has(mint)) {
        const s = screener.get(mint);
        // Spot x amount is meaningless for a thin token we hold a large share of (the first run showed $3.27M "spot" for
        // tokens that sell for ~$8). Both totals use the sale quote; the naive spot is kept only as a labelled note.
        const naive = b.amount * (s.x / s.y) * x1p.xntUsd;
        v.liquid_usd = P.cpSell(b.amount, s.y, s.x, s.fee) * x1p.xntUsd;
        v.spot_usd = v.liquid_usd;
        v.method = 'indexed-pool sale quote'; v.flags.push('screener.db reserves (not chain-read), updated ' + s.updated, 'naive spot $' + naive.toPrecision(4) + ' not counted');
      } else { v.method = 'unpriced'; unpriced.push({ chain: 'x1', mint, amount: b.amount, wallet: b.wallet_id }); }
    } else if (b.chain === 'solana') {
      if (mint === P.SOL.USDC) { v.spot_usd = v.liquid_usd = b.amount; v.method = 'par'; }
      else { v.method = 'unpriced'; unpriced.push({ chain: 'solana', asset: b.asset_id, amount: b.amount, wallet: b.wallet_id, note: b.asset_id === 'solana:native' ? 'SOL gas, not priced in v1' : '' }); }
    } else if (b.chain === 'arc') {
      if (b.asset_id === 'arc:native') { v.spot_usd = v.liquid_usd = b.amount; v.method = 'par'; }
      else if (mint === P.ARC.APEX.toLowerCase()) {
        if (arcApex) { v.spot_usd = b.amount * arcApex.usd; v.liquid_usd = null; v.method = 'spot (self-priced) + joint sale into outside liquidity'; v.selfPriced = true; v.flags.push('outside share ' + (outsideShare * 100).toFixed(1) + '%'); }
        else { v.method = 'unpriced'; unpriced.push({ chain: 'arc', asset: 'APEX', amount: b.amount, wallet: b.wallet_id }); }
      } else if (mint === P.ARC.EURC) { v.method = 'unpriced'; unpriced.push({ chain: 'arc', asset: 'EURC', amount: b.amount, wallet: b.wallet_id, note: 'EURC not priced in v1' }); }
      else { v.method = 'position'; }   // trader tokens: valued in the positions step
    } else if (b.chain === 'base') {
      if (b.asset_id === 'base:native') { if (ethUsd) { v.spot_usd = v.liquid_usd = b.amount * ethUsd.usd; v.method = 'spot'; } else { v.method = 'unpriced'; unpriced.push({ chain: 'base', asset: 'ETH', amount: b.amount }); } }
      else if (mint === P.BASE.USDC.toLowerCase()) { v.spot_usd = v.liquid_usd = b.amount; v.method = 'par'; }
      else { v.method = 'unpriced'; unpriced.push({ chain: 'base', asset: b.asset_id, amount: b.amount }); }
    }
    vals.push(v);
  }
  // X1 APEX liquid value: ONE joint sale of every APEX we hold (wallets + LP-underlying) into the XDEX pool, after our own
  // XDEX LP has been withdrawn from it; each holding gets its share of that one sale. Per-class quotes each assumed they sold
  // first into the full pool, which overstated the total (Fable review 6c).
  if (x1p) {
    // The faucet pot's APEX is locked in its program (it can only pay claims): it cannot be sold, so it is not in the sale
    // and its liquid value is 0 by construction (a fact, not an unknown).
    for (const v of vals.filter((x) => x.chain === 'x1' && x.asset_id === 'x1:' + P.X1.APEX && x.owner_class === 'program-locked')) { v.liquid_usd = 0; v.flags.push('program-locked: cannot be sold'); }
    const walletRows = vals.filter((v) => v.chain === 'x1' && v.asset_id === 'x1:' + P.X1.APEX && v.owner_class !== 'program-locked');
    const lpRows1 = vals.filter((v) => v.chain === 'x1' && v.method === 'lp-underlying');
    const xdexLpMint = Object.keys(x1p.lp).find((m) => /XDEX/.test(x1p.lp[m].name));
    const ourXdexLp = lpRows1.filter((v) => v.asset_id === 'x1:' + xdexLpMint).reduce((t, v) => t + v.amount, 0);
    const sOurs = xdexLpMint && x1p.lp[xdexLpMint].supply > 0 ? Math.min(1, ourXdexLp / x1p.lp[xdexLpMint].supply) : 0;
    const lpApex = (v) => { const lp = x1p.lp[v.asset_id.slice(3)]; return v.amount / lp.supply * lp.apex; };
    const total = walletRows.reduce((t, v) => t + v.amount, 0) + lpRows1.reduce((t, v) => t + lpApex(v), 0);
    const apexR = x1p.apexPool.apex * (1 - sOurs), xntR = x1p.apexPool.xnt * (1 - sOurs);
    const jointUsd = total > 0 ? P.cpSell(total, apexR, xntR, 0.003) * x1p.xntUsd : 0;
    const flag = 'liquid = share of ONE sale of all ' + Math.round(total) + ' APEX we hold into XDEX (after our ' + (sOurs * 100).toFixed(1) + '% XDEX LP is withdrawn)';
    for (const v of walletRows) { v.liquid_usd = total ? jointUsd * (v.amount / total) : 0; v.flags.push(flag); }
    for (const v of lpRows1) { const lp = x1p.lp[v.asset_id.slice(3)]; const share = v.amount / lp.supply; v.liquid_usd = share * lp.xnt * x1p.xntUsd + (total ? jointUsd * (lpApex(v) / total) : 0); v.flags.push(flag); }
  }

  // ── 5. positions: Arc dip trader (state vs chain) and LP ──
  const posRows = [];
  const traderEntry = reg.entries.find((x) => x.chain === 'arc' && x.role === 'trader');
  for (const p of traderPos) {
    const aid = 'arc:' + String(p.token).toLowerCase();
    const bal = balRows.find((b) => traderEntry && b.wallet_id === traderEntry.id && b.asset_id === aid);
    const qtyChain = bal && bal.ok ? bal.raw : (bal ? null : '0');
    let own = null, ownErr = null;
    try {
      const s = await evm.v4Slot0('arc', P.ARC.STATE_VIEW, p.pool, arcBlock);
      // Arc pools pair against either NATIVE USDC (currency 0x000..., 18 decimals) or the ERC-20 view 0x3600... (6 decimals).
      // Assuming 6 for all of them valued four positions 10^12 too high in the first run (2026-09-29).
      const usdcDec = /^0x0{40}$/i.test(String(p.u && p.u.usdc)) ? 18 : 6;
      const per = P.v4UsdPerToken(s.sqrtPriceX96, !!(p.u && p.u.usdcIs0), usdcDec, p.u && p.u.dec != null ? p.u.dec : 18);
      own = ui(p.tokens, p.u && p.u.dec != null ? p.u.dec : 18) * per;
    } catch (e) { ownErr = err('arc position price ' + p.sym, e); }
    const markAge = p.markAt ? (Date.now() - Date.parse(p.markAt)) / 1000 : null;
    const fresh = markAge != null && markAge < 3 * 3600;
    const liquid = own == null ? null : (fresh ? Math.min(own, p.markUsdc) : null);   // no fresh sale quote -> unknown, never spot
    posRows.push({ strategy: 'arc-dip', chain: 'arc', wallet_id: traderEntry ? traderEntry.id : '?', asset_id: aid, symbol: p.sym, qty_state: String(p.tokens), qty_chain: qtyChain,
      cost_usd: p.costUsdc, mark_usd: p.markUsdc, mark_source: 'arc-dip-trader state (its simulated sell)', mark_at: p.markAt || null, own_spot_usd: own, liquid_usd: liquid,
      mismatch: qtyChain == null ? 1 : (BigInt(qtyChain) !== BigInt(String(p.tokens)) ? 1 : 0),
      detail: JSON.stringify({ pool: p.pool, markAgeS: markAge != null ? Math.round(markAge) : null, liquidRule: fresh ? 'min(own pool spot, trader mark)' : 'UNKNOWN: trader mark older than 3 h and no sale quote of our own', error: ownErr }) });
  }
  for (const l of lpRows) {
    if (l.error) continue;
    const apexUsd = arcApex ? arcApex.usd : null;
    const spot = apexUsd == null ? null : l.usdc + l.apex * apexUsd;
    vals.push({ wallet_id: l.e.id, owner_class: l.e.owner_class, chain: 'arc', asset_id: 'arc:lp-' + l.e.position_id, amount: 1, spot_usd: spot, liquid_usd: null, lpUsdc: l.usdc, lpApex: l.apex, selfPricedApexUsd: apexUsd == null ? 0 : l.apex * apexUsd,
      method: 'v4-liquidity-math', flags: ['usdc ' + l.usdc.toFixed(4) + ', apex ' + Math.round(l.apex), l.inRange ? 'in range' : 'OUT OF RANGE', 'uncollected fees not counted'] });
  }
  // Arc APEX liquid: ONE joint sale of all Arc APEX we hold (wallets + LP-underlying) into the pool liquidity that is NOT ours,
  // inside the current tick-spacing range only (a lower bound). With 0% outside liquidity it is 0, and says so.
  {
    const apexRows = vals.filter((v) => v.chain === 'arc' && v.selfPriced), lpRowsA = vals.filter((v) => v.chain === 'arc' && v.lpApex != null);
    const total = apexRows.reduce((t, v) => t + v.amount, 0) + lpRowsA.reduce((t, v) => t + v.lpApex, 0);
    let jointUsd = null;
    if (arcApex && apexPoolKey && apexSlot) jointUsd = v4SellToken1LowerBound(outsideL, apexSlot.sqrtPriceX96, Number(apexSlot.tick), Number(apexPoolKey.tickSpacing), Number(apexPoolKey.fee), total * 1e9) / 1e18;
    const flag = jointUsd == null ? 'no sale quote (pool key or price unread)' : 'liquid = share of ONE sale of all ' + Math.round(total) + ' Arc APEX into outside liquidity, current range only (lower bound): $' + jointUsd.toFixed(4);
    for (const v of apexRows) { v.liquid_usd = jointUsd == null ? null : (total ? jointUsd * v.amount / total : 0); v.flags.push(flag); }
    for (const v of lpRowsA) { v.liquid_usd = jointUsd == null ? null : v.lpUsdc + (total ? jointUsd * v.lpApex / total : 0); v.flags.push(flag); }
  }
  for (const pr of posRows) vals.push({ wallet_id: pr.wallet_id, owner_class: 'project', chain: 'arc', asset_id: pr.asset_id, amount: Number(pr.qty_state), spot_usd: pr.own_spot_usd,
    liquid_usd: pr.liquid_usd, method: 'position (arc-dip)', flags: [pr.symbol].concat(pr.mismatch ? ['QTY MISMATCH state vs chain'] : []) });

  // ── 6. NAV ──
  const failedBal = balRows.filter((b) => !b.ok).length;
  const lpBad = lpRows.filter((l) => l.error || l.ownerMatches === false).length;
  const posBad = posRows.filter((p) => p.mismatch).length;
  const complete = errors.length === 0 && failedBal === 0 && lpBad === 0 && posBad === 0 ? 1 : 0;
  const sum = (arr, k) => arr.reduce((s, v) => s + (v[k] || 0), 0);
  const group = (key) => { const g = {}; for (const v of vals) { const k = v[key]; g[k] = g[k] || { spot_usd: 0, liquid_usd: 0 }; g[k].spot_usd += v.spot_usd || 0; g[k].liquid_usd += v.liquid_usd || 0; } for (const k in g) { g[k].spot_usd = +g[k].spot_usd.toFixed(2); g[k].liquid_usd = +g[k].liquid_usd.toFixed(2); } return g; };
  const selfPricedUsd = vals.reduce((t, v) => t + (v.selfPriced ? (v.spot_usd || 0) : 0) + (v.selfPricedApexUsd || 0), 0);
  const liquidUnknown = vals.filter((v) => v.liquid_usd == null && v.spot_usd != null).length;
  const coverage = [
    'EVM tokens read from a fixed list (native, APEX, EURC, USDC, trader positions); other ERC-20s are not enumerated',
    'Circle Gateway balances are not counted (the Arc trader deposited 0.30 USDC on 2026-09-25, tx 0x2ca1b2d9...)',
    'uncollected Uniswap v4 LP fees are not counted', 'SOL on Solana and EURC on Arc are listed as unpriced',
    'Arc APEX spot is self-priced ($' + selfPricedUsd.toFixed(2) + ' of spot); spot without it: $' + (sum(vals, 'spot_usd') - selfPricedUsd).toFixed(2),
  ].concat(liquidUnknown ? [liquidUnknown + ' holding(s) have a spot value but NO liquid value (unknown, not zero)'] : []);
  const nav = { at: now(), spot_usd: +sum(vals, 'spot_usd').toFixed(2), liquid_usd: +sum(vals, 'liquid_usd').toFixed(2), by_chain: group('chain'), by_owner_class: group('owner_class'),
    spot_ex_self_priced_usd: +(sum(vals, 'spot_usd') - selfPricedUsd).toFixed(2), coverage,
    positions_usd: +(sum(posRows, 'own_spot_usd') + lpRows.filter((l) => !l.error).reduce((s, l) => s + l.usdc + (arcApex ? l.apex * arcApex.usd : 0), 0)).toFixed(2),
    unpriced, complete, incomplete_reasons: errors.concat(lpRows.filter((l) => l.ownerMatches === false).map((l) => 'LP #' + l.e.position_id + ' owner is ' + l.owner + ', not as registered'))
      .concat(posRows.filter((p) => p.mismatch).map((p) => 'position ' + p.symbol + ' state ' + p.qty_state + ' vs chain ' + p.qty_chain)) };

  // ── 7. write ──
  await db.run('BEGIN');
  for (const p of priceRows) await db.run('INSERT INTO prices (run_id, asset_id, method, usd, source, source_detail, observed_at, age_s, flags, ok, error) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [runId, p.asset_id, p.method, p.usd, p.source, JSON.stringify(p.source_detail || {}), now(), 0, JSON.stringify(p.flags || []), 1, null]);
  for (const b of balRows) await db.run('INSERT INTO balances (run_id, wallet_id, chain, address, asset_id, raw, decimals, amount, rpc_url, block_or_slot, read_at, ok, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [runId, b.wallet_id, b.chain, b.address, b.asset_id, b.raw, b.decimals, b.amount, b.rpc_url, b.block_or_slot, now(), b.ok, b.error]);
  for (const v of vals) await db.run('INSERT INTO valuations (run_id, wallet_id, owner_class, chain, asset_id, amount, spot_usd, liquid_usd, method, flags) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [runId, v.wallet_id, v.owner_class, v.chain, v.asset_id, v.amount, v.spot_usd, v.liquid_usd, v.method, JSON.stringify(v.flags)]);
  for (const p of posRows) await db.run('INSERT INTO positions (run_id, strategy, chain, wallet_id, asset_id, symbol, qty_state, qty_chain, cost_usd, mark_usd, mark_source, mark_at, own_spot_usd, liquid_usd, mismatch, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [runId, p.strategy, p.chain, p.wallet_id, p.asset_id, p.symbol, p.qty_state, p.qty_chain, p.cost_usd, p.mark_usd, p.mark_source, p.mark_at, p.own_spot_usd, p.liquid_usd, p.mismatch, p.detail]);
  for (const l of lpRows) await db.run('INSERT INTO lp_positions (run_id, chain, venue, position_id, wallet_id, owner_class, owner_on_chain, owner_matches, amount0, amount1, value_usd, source, ok, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [runId, 'arc', 'uniswap-v4 APEX/USDC', l.e.position_id, l.e.id, l.e.owner_class, l.owner || null, l.ownerMatches == null ? null : (l.ownerMatches ? 1 : 0), l.usdc != null ? l.usdc : null, l.apex != null ? l.apex : null,
      l.error || !arcApex ? null : l.usdc + l.apex * arcApex.usd, 'posm ' + P.ARC.POSM + ' @ block ' + (arcBlock != null ? arcBlock.toString() : '?'), l.error ? 0 : 1, l.error || null]);
  await db.run('INSERT INTO nav (run_id, at, spot_usd, liquid_usd, by_chain, by_owner_class, positions_usd, unpriced, complete, incomplete_reasons, spot_ex_self_priced_usd, coverage) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [runId, nav.at, nav.spot_usd, nav.liquid_usd, JSON.stringify(nav.by_chain), JSON.stringify(nav.by_owner_class), nav.positions_usd, JSON.stringify(nav.unpriced), nav.complete, JSON.stringify(nav.incomplete_reasons), nav.spot_ex_self_priced_usd, JSON.stringify(nav.coverage)]);
  const summary = { runId, arcBlock: arcBlock != null ? arcBlock.toString() : null, arcTime, baseBlock: baseBlock != null ? baseBlock.toString() : null, baseTime,
    xntUsd: x1p && x1p.xntUsd, apexUsdX1: x1p && x1p.apexUsd, apexUsdArc: arcApex && arcApex.usd, ethUsd: ethUsd && ethUsd.usd, outsideShareArcApex: outsideShare,
    balances: balRows.length, failedReads: failedBal, positions: posRows.length, positionMismatches: posBad, lp: lpRows.length, lpProblems: lpBad, unpriced: unpriced.length, nav: { spot: nav.spot_usd, spotExSelfPriced: nav.spot_ex_self_priced_usd, liquid: nav.liquid_usd, coverage: nav.coverage, byOwner: nav.by_owner_class, byChain: nav.by_chain }, complete };
  await db.run('UPDATE runs SET finished_at=?, complete=?, errors_json=?, summary_json=? WHERE run_id=?', [now(), complete, JSON.stringify(errors), JSON.stringify(summary), runId]);
  await db.run('COMMIT');
  await db.close();
  console.log(JSON.stringify(summary, null, 1));
  if (errors.length) console.log('ERRORS:\n  ' + errors.slice(0, 20).join('\n  '));
  process.exit(complete ? 0 : 3);   // 3 = finished but incomplete (never a silent success)
})().catch((e) => { console.error('SNAPSHOT CRASHED: ' + (e && e.stack || e)); process.exit(1); });
