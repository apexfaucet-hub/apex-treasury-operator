#!/usr/bin/env node
'use strict';
// ACCOUNT LAYER P3: one normalized ledger from the existing money records (2026-09-29). Read-only on every source.
// One entry per (wallet, tx, asset leg). Idempotent: UNIQUE(source, source_ref), so a re-run adds nothing.
// Every entry says where it came from (source, source_ref) and how sure it is (confidence):
//   chain-verified-at-payment  the app verified the transaction on chain when it accepted it (x402 settlements)
//   ledger-only                written by our own code when it sent the transaction; not re-read here
//   estimated                  a USD value derived from a price at the nearest time we have
// Personal data never enters: card buyers are 'card buyer', no email is ever stored (lib/account/privacy.js refuses the batch).
// The source is the truth and the ledger mirrors it: a changed source row UPDATES its ledger row (upsert on the same key),
// a row that vanishes from its source stays here and the P3 exit test reports the count mismatch.
// amount is NULL when the source did not record it (never 0 for "unknown"); it is in the unit of asset_id, so sums are
// only meaningful per asset_id. usd_at_time sits on EVERY leg of a trade (buy: USDC out at cost and token in at cost), so
// a USD total must take one leg per tx, e.g. only asset_id 'arc:native' legs for the dip trader.
// Run: sudo tools/account-run.sh node tools/account-ingest.js [--dry]
const fs = require('fs');
const path = require('path');
const R = require('/root/apex-faucet/lib/account/registry.js');
const { open, openReadOnly } = require('/root/apex-faucet/lib/account/db.js');

const ROOT = '/root/apex-faucet';
const DRY = process.argv.includes('--dry');
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
const APEX_X1 = 'Du6Z596DwGnfUcMSyRHSBQzNybiQKu8GESVfruEv9Jqr';
// Bonus tokens paid with a claim, mints copied from server.js's claim route (2026-09-29).
const BONUS = [['capy_amount', 'CAPY', 'AnvCcvnY4DLRW42EZBEAb1QeU6Pt9aab3r3D75GtgJUU'], ['drc_amount', 'DRC', 'GPPQhRmYzt1op59JAtNvsh1VdaueF8iXR5wjXH8xvTFG'],
  ['ibogains_amount', 'IBOGAINS', 'EtgeAvMmZgCWJm9aZqTqQKukxNfhHiU7aHZU37pzihvp'], ['ash_amount', 'ASH', '69MtdLn7YTLnaNN4qdS9Z1cJBsNfcHewfmihLBVH1KPw']];
// The faucet's APEX account 1Wwdp3mi... was handed to the Faucet Pot program in tx TUrFWXeBk2G4..., block time read on chain
// 2026-09-29: 2026-09-26T12:42:45Z. Same token account before and after; only its owner changed (faucet wallet -> program),
// so APEX claim legs are filed under the faucet wallet before that second and under the pot entry after it.
const POT_HANDOVER = Date.parse('2026-09-26T12:42:45Z');

(async () => {
  await require('/root/apex-faucet/lib/account/assert-sandboxed.js').assertSandboxed();   // refuses to run outside tools/account-run.sh
  const reg = R.load();
  const byRole = (chain, role) => reg.entries.find((e) => e.chain === chain && e.role === role);
  const W = {
    arcReceive: byRole('arc', 'receive'), baseReceive: byRole('base', 'receive'), solFaucet: byRole('solana', 'faucet'),
    x1Faucet: byRole('x1', 'faucet'), arcOperator: byRole('arc', 'operator'), baseOperator: byRole('base', 'operator'),
    arcTrader: byRole('arc', 'trader'), arcFaucet: reg.entries.find((e) => e.chain === 'arc' && /USDC faucet/.test(e.label)),
    pot: reg.entries.find((e) => e.chain === 'x1' && e.owner_class === 'program-locked' && e.address.startsWith('1Wwdp3mi')), x1Trader: byRole('x1', 'trader'), x1Founder: reg.entries.find((e) => e.chain === 'x1' && e.key_file_name === 'user-wallet.json'),
  };
  const idOf = (chain, address) => { const f = R.find(chain, address)[0]; return f ? f.id : null; };
  // XNT/USD history: our own treasury-nav readings (every 2 h since 2026-09-15) for USD-at-time of XNT rows.
  const xntHist = readLines(path.join(ROOT, 'data', 'treasury-nav.jsonl')).filter((r) => r.xntUsd > 0).map((r) => ({ t: Date.parse(r.at), usd: r.xntUsd, apexXnt: r.apexPriceXnt }));
  const nearestXnt = (t) => { let best = null; for (const h of xntHist) if (!best || Math.abs(h.t - t) < Math.abs(best.t - t)) best = h; return best && Math.abs(best.t - t) < 12 * 3600e3 ? best : null; };

  const entries = [];
  const E = (o) => entries.push(Object.assign({ amount_basis: 'transfer', amount_raw: null, block_time: null, tx: null, wallet_id: null, usd_at_time: null, usd_source: null, counterparty: null,
    counterparty_ours: null, strategy: null, product: null, notes: null }, o));
  const counts = {};
  const annotationsRefused = [];
  const bump = (s) => { counts[s] = (counts[s] || 0) + 1; };

  // 1. x402 settlements (data/settlements.ndjson): income to our receive wallet on that rail.
  for (const s of readLines(path.join(ROOT, 'data', 'settlements.ndjson'))) {
    bump('settlements');
    const chain = String(s.chain || '').toLowerCase();
    // Circle Gateway (batched nanopayments) settles off chain: its "tx" is 'gateway:<uuid>', a custodial ledger id, never a
    // chain hash, whatever chain the row names. It is filed under the gateway rail so nothing looks for it on chain.
    const viaGateway = /^gateway:/.test(String(s.tx || ''));
    const rail = viaGateway ? 'gateway' : chain.includes('base') ? 'base' : chain.includes('arc') || chain === 'eip155:5042' ? 'arc' : chain.includes('sol') ? 'solana' : chain.includes('x1') ? 'x1' : chain.includes('gateway') ? 'gateway' : chain;
    const wallet = rail === 'arc' ? W.arcReceive : rail === 'base' ? W.baseReceive : rail === 'solana' ? W.solFaucet : rail === 'x1' ? W.x1Faucet : null;
    const asset = rail === 'arc' ? 'arc:native' : rail === 'base' ? 'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' : rail === 'solana' ? 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : rail === 'x1' ? 'x1:native' : 'gateway:usdc';
    const t = Date.parse(s.paidAt || s.at);
    let usd = s.usd != null ? Number(s.usd) : null, usdSrc = s.usd != null ? 'settlements.usd' : null;
    if (usd == null && rail === 'x1' && s.amount > 0) { const h = nearestXnt(t); if (h) { usd = s.amount * h.usd; usdSrc = 'estimated: treasury-nav XNT/USD ' + new Date(h.t).toISOString(); } }
    const payerOurs = s.payer ? (rail !== 'gateway' && R.isOursPayer(rail === 'gateway' ? 'base' : rail, s.payer)) || !!s.ours : null;
    const ref = s.tx || ('noTx:' + s.at + ':' + s.payer + ':' + s.resource);
    E({ ts_utc: new Date(t).toISOString(), chain: rail, tx: s.tx || null, wallet_id: wallet ? wallet.id : null, direction: 'in', asset_id: asset, amount: (s.amount == null || s.amount === '' ? null : Number(s.amount)),
      usd_at_time: usd, usd_source: usdSrc, counterparty: s.payer || null, counterparty_ours: payerOurs ? 1 : 0,
      category: payerOurs ? 'internal' : 'revenue:x402', product: s.resource || null, source: 'settlements', source_ref: ref + ':in',
      confidence: s.source === 'reconstructed' ? 'ledger-only' : 'chain-verified-at-payment', notes: rail === 'gateway' ? 'custodial: Circle Gateway balance, not an on-chain transfer to us' : (s.status && s.status >= 400 ? 'delivery status ' + s.status : null) });
    if (payerOurs && s.payer) {
      const pw = idOf(rail, s.payer);
      if (pw) E({ ts_utc: new Date(t).toISOString(), chain: rail, tx: s.tx || null, wallet_id: pw, direction: 'out', asset_id: asset, amount: (s.amount == null || s.amount === '' ? null : Number(s.amount)), usd_at_time: usd, usd_source: usdSrc,
        counterparty: wallet ? wallet.address : null, counterparty_ours: 1, category: 'internal', product: s.resource || null, source: 'settlements', source_ref: ref + ':out', confidence: 'chain-verified-at-payment', notes: 'our own test payment' });
    }
  }
  // 2. refunds (data/refunds.ndjson): outflow from the wallet that refunded.
  for (const r of readLines(path.join(ROOT, 'data', 'refunds.ndjson'))) {
    bump('refunds');
    if (!r.refundOf && !r.tx) continue;
    const chain = String(r.chain || 'base').toLowerCase();
    // the wallet that sent the refund: r.from when the row names it (6 Oct: the 0.003 USDC Arc refund left the RECEIVE wallet,
    // read from the transaction), else the operator, as every refund before it
    const from = r.from ? { id: idOf(chain, r.from) } : (chain === 'base' ? W.baseOperator : W.arcOperator);
    if (r.noteFor) { E({ ts_utc: r.at, chain, tx: r.tx, wallet_id: from ? from.id : null, direction: 'out', asset_id: chain + ':native', amount: 0, category: 'gas', source: 'refunds', source_ref: r.tx + ':note', confidence: 'ledger-only', notes: 'zero-value note transaction (gas only)', counterparty: r.to }); continue; }
    E({ ts_utc: r.at, chain, tx: r.tx, wallet_id: from ? from.id : null, direction: 'out', asset_id: chain === 'base' ? 'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' : 'arc:native', amount: (r.usd == null || r.usd === '' ? null : Number(r.usd)),
      usd_at_time: Number(r.usd) || null, usd_source: 'refunds.usd', counterparty: r.to, counterparty_ours: 0, category: 'refund', source: 'refunds', source_ref: r.tx + ':out', confidence: 'ledger-only', notes: 'refund of ' + r.refundOf });
  }
  // 3. Arc dip trader (core/data/arc-dip-trader.jsonl): buys, sells, faucet share.
  for (const ev of readLines('/home/claudeuser/core/data/arc-dip-trader.jsonl')) {
    if (!['buy', 'sell', 'faucet.share'].includes(ev.ev)) continue;
    bump('dip-trader');
    const tw = W.arcTrader ? W.arcTrader.id : null;
    if (ev.ev === 'buy') {
      E({ ts_utc: ev.at, chain: 'arc', tx: ev.tx, wallet_id: tw, direction: 'out', asset_id: 'arc:native', amount: ev.costUsdc, amount_basis: 'net-of-gas', usd_at_time: ev.costUsdc, usd_source: 'par', category: 'trade:buy', strategy: 'arc-dip', product: ev.sym, source: 'dip-trader', source_ref: ev.tx + ':usdc-out', confidence: 'ledger-only',
        notes: 'costUsdc = the wallet USDC drop for the buy: swap + its gas + the gas of an approval sent just before, if any (core/arc/dip-trader.js)' });
      // the writer logs raw token units and no decimals (core/arc/dip-trader.js:224): keep them raw, never divide by a guess
      E({ ts_utc: ev.at, chain: 'arc', tx: ev.tx, wallet_id: tw, direction: 'in', asset_id: 'arc:' + String(ev.token).toLowerCase(), amount: null, amount_raw: ev.tokens != null ? String(ev.tokens) : null, usd_at_time: ev.costUsdc, usd_source: 'cost', category: 'trade:buy', strategy: 'arc-dip', product: ev.sym, source: 'dip-trader', source_ref: ev.tx + ':token-in', confidence: 'ledger-only' });
    } else if (ev.ev === 'sell') {
      E({ ts_utc: ev.at, chain: 'arc', tx: ev.tx, wallet_id: tw, direction: 'in', asset_id: 'arc:native', amount: ev.backUsdc, amount_basis: 'net-of-gas', usd_at_time: ev.backUsdc, usd_source: 'par', category: 'trade:sell', strategy: 'arc-dip', product: ev.sym, source: 'dip-trader', source_ref: ev.tx + ':usdc-in', confidence: 'ledger-only',
        notes: 'backUsdc = the wallet USDC rise for the sell: proceeds minus its gas; pnl ' + ev.pnlUsdc });
      E({ ts_utc: ev.at, chain: 'arc', tx: ev.tx, wallet_id: tw, direction: 'out', asset_id: 'arc:' + String(ev.token).toLowerCase(), amount: null, usd_at_time: ev.costUsdc, usd_source: 'cost', category: 'trade:sell', strategy: 'arc-dip', product: ev.sym, source: 'dip-trader', source_ref: ev.tx + ':token-out', confidence: 'ledger-only', notes: 'whole position sold; token amount not logged by the trader' });
    } else {
      E({ ts_utc: ev.at, chain: 'arc', tx: ev.tx, wallet_id: tw, direction: 'out', asset_id: 'arc:native', amount: ev.usdc, usd_at_time: ev.usdc, usd_source: 'par', counterparty: W.arcFaucet ? W.arcFaucet.address : null, counterparty_ours: 1, category: 'internal', strategy: 'arc-dip', product: 'faucet share', source: 'dip-trader', source_ref: ev.tx + ':out', confidence: 'ledger-only' });
      if (W.arcFaucet) E({ ts_utc: ev.at, chain: 'arc', tx: ev.tx, wallet_id: W.arcFaucet.id, direction: 'in', asset_id: 'arc:native', amount: ev.usdc, usd_at_time: ev.usdc, usd_source: 'par', counterparty: W.arcTrader ? W.arcTrader.address : null, counterparty_ours: 1, category: 'internal', product: 'faucet share', source: 'dip-trader', source_ref: ev.tx + ':in', confidence: 'ledger-only' });
    }
  }
  // 4. Arc faucet claims (data/arc-faucet-claims.jsonl): paid by the faucet contract to claimers.
  for (const c of readLines(path.join(ROOT, 'data', 'arc-faucet-claims.jsonl'))) {
    bump('arc-faucet-claims');
    if (!c.tx) continue;
    E({ ts_utc: c.at, chain: 'arc', tx: c.tx, wallet_id: W.arcFaucet ? W.arcFaucet.id : null, direction: 'out', asset_id: 'arc:native', amount: (c.amountUsdc == null || c.amountUsdc === '' ? null : Number(c.amountUsdc)), usd_at_time: (c.amountUsdc == null || c.amountUsdc === '' ? null : Number(c.amountUsdc)), usd_source: 'par',
      counterparty: c.to, counterparty_ours: R.isInternal('arc', c.to) ? 1 : 0, category: 'faucet:claim', source: 'arc-faucet-claims', source_ref: c.tx, confidence: 'ledger-only' });
  }
  // 5. X1 faucet claims (faucet.db claims): APEX (+ XNT) to claimers; from the faucet wallet before the pot handover, from the pot after.
  // the column-limited extract, never faucet.db itself (review A1); a stale or incomplete extract makes the run incomplete
  const EXT = require('/root/apex-faucet/lib/account/extract.js');
  const extract = await EXT.check();
  const fdb = EXT.open();
  try {
    const claims = await fdb.all('SELECT id, wallet_address, tx_hash, apex_tx_hash, amount, xnt_amount, capy_amount, drc_amount, ibogains_amount, ash_amount, claimed_at FROM claims ORDER BY id');
    for (const c of claims) {
      bump('x1-claims');
      const t = Date.parse(String(c.claimed_at).replace(' ', 'T') + 'Z');
      const from = t >= POT_HANDOVER ? W.pot : W.x1Faucet;
      const tx = (c.apex_tx_hash && c.apex_tx_hash.length > 60) ? c.apex_tx_hash : (c.tx_hash && c.tx_hash.length > 60 ? c.tx_hash : null);
      if (Number(c.amount) > 0) E({ ts_utc: new Date(t).toISOString(), chain: 'x1', tx, wallet_id: from ? from.id : null, direction: 'out', asset_id: 'x1:' + APEX_X1, amount: Number(c.amount),
        counterparty: c.wallet_address, counterparty_ours: R.isInternal('x1', c.wallet_address) ? 1 : 0, category: 'faucet:claim', source: 'x1-claims', source_ref: 'claim:' + c.id + ':apex', confidence: 'ledger-only' });
      if (Number(c.xnt_amount) > 0) { const h = nearestXnt(t); E({ ts_utc: new Date(t).toISOString(), chain: 'x1', tx: c.tx_hash && c.tx_hash.length > 60 ? c.tx_hash : null, wallet_id: W.x1Faucet ? W.x1Faucet.id : null, direction: 'out', asset_id: 'x1:native',
        amount: Number(c.xnt_amount), usd_at_time: h ? c.xnt_amount * h.usd : null, usd_source: h ? 'estimated: treasury-nav XNT/USD' : null, counterparty: c.wallet_address, counterparty_ours: R.isInternal('x1', c.wallet_address) ? 1 : 0,
        category: 'faucet:claim', source: 'x1-claims', source_ref: 'claim:' + c.id + ':xnt', confidence: 'ledger-only' }); }
      // Bonus tokens (server.js claim route): each is its own transfer from the faucet wallet; the claim row stores the amount, not the signature.
      for (const [col, sym, mint] of BONUS) if (Number(c[col]) > 0) E({ ts_utc: new Date(t).toISOString(), chain: 'x1', tx: null, wallet_id: W.x1Faucet ? W.x1Faucet.id : null, direction: 'out',
        asset_id: 'x1:' + mint, amount: Number(c[col]), counterparty: c.wallet_address, counterparty_ours: R.isInternal('x1', c.wallet_address) ? 1 : 0, category: 'faucet:claim', product: sym,
        source: 'x1-claims', source_ref: 'claim:' + c.id + ':' + sym.toLowerCase(), confidence: 'ledger-only', notes: 'bonus transfer signature not recorded by the claim code' });
    }
    for (const p of await fdb.all('SELECT p.id, p.wallet, p.amount, p.sig, p.created_at, l.mint, l.symbol FROM faucet_listing_payouts p LEFT JOIN faucet_listings l ON l.id = p.listing_id')) {
      bump('faucet_listing_payouts');
      E({ ts_utc: String(p.created_at).replace(' ', 'T') + 'Z', chain: 'x1', tx: p.sig || null, wallet_id: W.x1Faucet ? W.x1Faucet.id : null, direction: 'out', asset_id: p.mint ? 'x1:' + p.mint : 'unknown',
        amount: Number(p.amount), counterparty: p.wallet, counterparty_ours: R.isInternal('x1', p.wallet) ? 1 : 0, category: 'faucet:claim', product: 'partner ' + (p.symbol || '?'),
        source: 'faucet_listing_payouts', source_ref: 'lp:' + p.id, confidence: 'ledger-only', notes: 'paid from the partner deposit held by the faucet wallet' });
    }
    for (const p of await fdb.all('SELECT id, referred_wallet, referrer_wallet, amount, tx_hash, paid_at FROM referral_payouts')) {
      bump('referral_payouts');
      E({ ts_utc: String(p.paid_at).replace(' ', 'T') + 'Z', chain: 'x1', tx: p.tx_hash || null, wallet_id: W.x1Faucet ? W.x1Faucet.id : null, direction: 'out', asset_id: 'x1:' + APEX_X1,
        amount: Number(p.amount), counterparty: p.referrer_wallet, counterparty_ours: R.isInternal('x1', p.referrer_wallet) ? 1 : 0, category: 'faucet:claim', product: 'referral',
        source: 'referral_payouts', source_ref: 'ref:' + p.id, confidence: 'ledger-only', notes: 'unit assumed APEX: no referral has ever been paid, re-check the writer before the first one' });
    }
    // 6. card sales: houses and height (no emails: the buyer is 'card buyer').
    for (const o of await fdb.all('SELECT id, via, usd, xnt, apex, created_at FROM city_ownership')) {
      bump('city_ownership');
      if (o.via === 'card') E({ ts_utc: String(o.created_at).replace(' ', 'T') + 'Z', chain: 'offchain', tx: null, wallet_id: 'offchain:stripe', direction: 'in', asset_id: 'offchain:usd', amount: (o.usd == null || o.usd === '' ? null : Number(o.usd)), usd_at_time: (o.usd == null || o.usd === '' ? null : Number(o.usd)), usd_source: 'stripe amount',
        counterparty: 'card buyer', counterparty_ours: 0, category: 'revenue:card', product: 'house', source: 'city_ownership', source_ref: 'own:' + o.id, confidence: 'ledger-only', notes: 'Stripe balance not reconciled in v1' });
    }
    for (const l of await fdb.all('SELECT id, usd, xnt, signature_kind, created_at FROM city_level_purchases')) {
      bump('city_level_purchases');
      if (Number(l.usd) > 0 && l.signature_kind === 'stripe-live') E({ ts_utc: String(l.created_at).replace(' ', 'T') + 'Z', chain: 'offchain', wallet_id: 'offchain:stripe', direction: 'in', asset_id: 'offchain:usd', amount: Number(l.usd), usd_at_time: Number(l.usd), usd_source: 'stripe amount',
        counterparty: 'card buyer', counterparty_ours: 0, category: 'revenue:card', product: 'height', source: 'city_level_purchases', source_ref: 'lvl:' + l.id, confidence: 'ledger-only' });
    }
    // 7. sponsors: paid in XNT (X1) or USDC (Solana) to the faucet wallet.
    for (const s of await fdb.all('SELECT id, tx_signature, amount, payment_token, wallet_address, created_at FROM sponsors')) {
      bump('sponsors');
      if (!s.tx_signature || !(Number(s.amount) > 0)) continue;
      const usdc = /usdc/i.test(String(s.payment_token));
      const chain = usdc ? 'solana' : 'x1';
      const ours = R.isOursPayer(chain, s.wallet_address);
      E({ ts_utc: String(s.created_at).replace(' ', 'T') + 'Z', chain, tx: s.tx_signature, wallet_id: usdc ? (W.solFaucet && W.solFaucet.id) : (W.x1Faucet && W.x1Faucet.id), direction: 'in',
        asset_id: usdc ? 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : 'x1:native', amount: Number(s.amount), counterparty: s.wallet_address, counterparty_ours: ours ? 1 : 0,
        category: ours ? 'internal' : 'revenue:direct', product: 'sponsor', source: 'sponsors', source_ref: 'sp:' + s.id, confidence: 'chain-verified-at-payment' });
    }
  } finally { await fdb.close(); }
  // 8. manual moves logged by our own tools (core/data/arc-move.jsonl), where the wallet is known.
  for (const m of readLines('/home/claudeuser/core/data/arc-move.jsonl')) {
    const tx = m.tx || m.sig; if (!tx) continue;
    bump('arc-move');
    const base = { ts_utc: m.at, tx, source: 'arc-move', confidence: 'ledger-only', notes: m.step + (m.why ? ': ' + String(m.why).slice(0, 120) : '') };
    if (m.step === 'arc.transfer' && m.from && m.to) {
      E(Object.assign({}, base, { chain: 'arc', wallet_id: idOf('arc', m.from), direction: 'out', asset_id: 'arc:native', amount: m.usdc, usd_at_time: m.usdc, usd_source: 'par', counterparty: m.to, counterparty_ours: R.isInternal('arc', m.to) ? 1 : 0, category: R.isInternal('arc', m.to) ? 'internal' : 'manual', source_ref: tx + ':out' }));
      E(Object.assign({}, base, { chain: 'arc', wallet_id: idOf('arc', m.to), direction: 'in', asset_id: 'arc:native', amount: m.usdc, usd_at_time: m.usdc, usd_source: 'par', counterparty: m.from, counterparty_ours: 1, category: 'internal', source_ref: tx + ':in' }));
    } else if (m.step === 'consolidate' && m.wallet === 'trader') {
      E(Object.assign({}, base, { chain: 'x1', wallet_id: W.x1Trader && W.x1Trader.id, direction: 'out', asset_id: 'x1:native', amount: m.toFounder, counterparty: W.x1Founder && W.x1Founder.address, counterparty_ours: 1, category: 'internal', source_ref: tx + ':out' }));
      E(Object.assign({}, base, { chain: 'x1', wallet_id: W.x1Founder && W.x1Founder.id, direction: 'in', asset_id: 'x1:native', amount: m.toFounder, counterparty: W.x1Trader && W.x1Trader.address, counterparty_ours: 1, category: 'internal', source_ref: tx + ':in' }));
    } else {
      E(Object.assign({}, base, { chain: /^0x/.test(tx) ? 'arc' : 'x1', wallet_id: null, direction: 'unknown', asset_id: 'unknown', amount: null, category: 'manual', source_ref: tx + ':' + m.step,
        notes: m.step + ': wallet, direction and unit not recorded by the tool; the tx hash explains the move, the amount comes from the chain' }));
    }
  }
  // 10. agent gas grants (data/community-agents.json, written by server.js /api/agents verify): XNT from the X1 faucet wallet
  // to each newly verified agent. AGENT_GAS_GRANT_XNT = 0.01 in server.js (read 2026-09-29); the amount is the constant at
  // ingest, and the reconciler compares it with the chain for every hash. probe:true agents are our own door-prover,
  // which generates a fresh key per run and never keeps it: that XNT is spent for good (a probe cost, not a transfer).
  let agents = { agents: [], archived: [] };
  try { agents = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'community-agents.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const a of [].concat(agents.agents || [], agents.archived || [])) {
    if (!a.gasGrantSig) continue;
    bump('agent-gas-grants');
    const t = a.gasGrantedAt ? new Date(a.gasGrantedAt).toISOString() : null;
    const h = t ? nearestXnt(Date.parse(t)) : null;
    E({ ts_utc: t, chain: 'x1', tx: a.gasGrantSig, wallet_id: W.x1Faucet ? W.x1Faucet.id : null, direction: 'out', asset_id: 'x1:native', amount: 0.01,
      usd_at_time: h ? 0.01 * h.usd : null, usd_source: h ? 'estimated: treasury-nav XNT/USD' : null, counterparty: a.wallet, counterparty_ours: 0,
      category: a.probe ? 'cost:probe' : 'grant:agent-gas', product: a.probe ? 'door-prover' : 'agent gas grant', source: 'agent-gas-grants', source_ref: a.gasGrantSig,
      confidence: 'ledger-only', notes: a.probe ? 'our own door-prover; its key is generated per run and not kept, so this XNT is spent for good' : null });
  }
  // 9. annotations: manual moves recorded by Claude sessions (data/protected/account/annotations.ndjson). Only with a full tx hash.
  // 2026-10-06 (Fable review, gap 1): fee rows and rows that share a key are refused (lib/account/annotation-filter.js).
  const AF = require('/root/apex-faucet/lib/account/annotation-filter.js').filterAnnotations(readLines(path.join(R.DIR, 'annotations.ndjson')));
  annotationsRefused.push(...AF.refused);
  for (const a of AF.accepted) {
    bump('annotations');
    E({ ts_utc: a.at, chain: a.chain, tx: a.tx, wallet_id: idOf(a.chain, a.wallet), direction: a.direction || 'out', asset_id: a.asset_id || (a.chain + ':native'), amount: Number(a.amount), usd_at_time: a.usd != null ? Number(a.usd) : null,
      usd_source: a.usd != null ? 'annotation' : null, counterparty: a.to || null, counterparty_ours: a.to ? (R.isInternal(a.chain, a.to) ? 1 : 0) : null, category: a.category || 'manual', source: 'annotations', source_ref: a.tx + ':' + (a.leg || 'out'), confidence: 'ledger-only', notes: String(a.reason || '').slice(0, 200) });
  }

  // 11. the shared ledger (lib/ledger-log.js, 2026-09-29): rows a SENDER wrote for a transaction it built, sent and saw
  // confirm (claim token-account rent, bounty escrow, rental wages and shares, commodity account rent). One file per
  // sender under data/ledger/; files starting with '_' are that sender's error log, never ledger.
  const LDIR = path.join(ROOT, 'data', 'ledger');
  let lfiles = [];
  try { lfiles = fs.readdirSync(LDIR).filter((f) => /^[a-z0-9][a-z0-9-]*\.ndjson$/.test(f)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const unreadableLedger = [];
  for (const f of lfiles) {
    const src = 'ledger:' + f.replace(/\.ndjson$/, '');
    let rows;
    try { rows = readLines(path.join(LDIR, f)); }
    catch (e) { unreadableLedger.push(f + ' (' + (e.code || e.message) + ')'); console.error('[ingest] LEDGER FILE UNREADABLE: ' + f + ' ' + (e.code || e.message)); continue; }   // M5
    for (const r of rows) {
      bump(src);
      if (r.failed || !r.tx || !/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/.test(r.tx) || !(Number(r.amount) > 0)) continue;
      const t = Date.parse(r.at);
      const h = r.asset_id === 'x1:native' ? nearestXnt(t) : null;
      E({ ts_utc: new Date(t).toISOString(), chain: r.chain, tx: r.tx, wallet_id: idOf(r.chain, r.wallet), direction: r.direction === 'in' ? 'in' : 'out',
        asset_id: r.asset_id, amount: Number(r.amount), amount_basis: 'transfer', usd_at_time: h ? Number(r.amount) * h.usd : null,
        usd_source: h ? 'estimated: treasury-nav XNT/USD' : null, counterparty: r.counterparty || null,
        counterparty_ours: r.counterparty ? (R.isInternal(r.chain, r.counterparty) ? 1 : 0) : null, category: r.category || 'transfer',
        product: r.product || null, source: src, source_ref: r.tx + ':' + (r.leg != null ? r.leg : 0), confidence: 'ledger-only', notes: r.notes || null });
    }
  }

  // Privacy guard: no email-like string may enter the ledger.
  // Privacy (Fable review v2 #11c): an entry carrying personal-looking text is QUARANTINED (not stored, its text never
  // logged) instead of refusing the whole batch, which let one stranger-typed field stop the ledger for good.
  const PRIV = require('/root/apex-faucet/lib/account/privacy.js');
  const quarantined = [];
  for (let i = entries.length - 1; i >= 0; i--) { const hit = PRIV.findPersonalData([entries[i]]); if (hit) { quarantined.push({ source: hit.source, source_ref: hit.source_ref, kind: hit.kind }); entries.splice(i, 1); } }

  const db = open(); await db.init();
  const runId = (await db.run('INSERT INTO runs (kind, started_at, method_version) VALUES (?,?,?)', ['ingest', new Date().toISOString(), 1])).lastID;
  let added = 0, updated = 0, superseded = 0;
  const MUT = ['ts_utc', 'block_time', 'chain', 'tx', 'wallet_id', 'direction', 'asset_id', 'amount', 'amount_raw', 'amount_basis', 'usd_at_time', 'usd_source', 'counterparty', 'counterparty_ours', 'category', 'strategy', 'product', 'confidence', 'notes'];
  if (!DRY) {
    const before = (await db.get('SELECT COUNT(*) n FROM ledger')).n;
    await db.run('BEGIN');
    for (const e of entries) {
      const r = await db.run(`INSERT INTO ledger (ts_utc, block_time, chain, tx, wallet_id, direction, asset_id, amount, amount_raw, amount_basis, usd_at_time, usd_source, counterparty, counterparty_ours,
        category, strategy, product, source, source_ref, confidence, notes, ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source, source_ref) DO UPDATE SET ${MUT.map((c) => c + '=excluded.' + c).join(', ')}, ingested_at=excluded.ingested_at
        WHERE ${MUT.map((c) => 'ledger.' + c + ' IS NOT excluded.' + c).join(' OR ')}`,
        [e.ts_utc, e.block_time, e.chain, e.tx, e.wallet_id, e.direction, e.asset_id, e.amount == null || !Number.isFinite(Number(e.amount)) ? null : Number(e.amount), e.amount_raw, e.amount_basis, e.usd_at_time, e.usd_source, e.counterparty, e.counterparty_ours,
          e.category, e.strategy, e.product, e.source, e.source_ref, e.confidence, e.notes, new Date().toISOString()]);
      updated += r.changes;
    }
    // Rows a source no longer produces (the source row changed shape, e.g. a settlement re-filed under the gateway rail) are
    // kept for audit but marked superseded, so they can never explain a transaction again.
    const built = new Set(entries.map((e) => e.source + '|' + e.source_ref));
    const srcs = [...new Set(entries.map((e) => e.source))];
    for (const r of await db.all('SELECT entry_id, source, source_ref FROM ledger WHERE category <> ? AND source IN (' + srcs.map(() => '?').join(',') + ')', ['superseded', ...srcs])) {
      if (!built.has(r.source + '|' + r.source_ref)) { await db.run("UPDATE ledger SET category='superseded', notes=? WHERE entry_id=?", ['superseded ' + new Date().toISOString().slice(0, 10) + ': no longer produced from its source; kept for audit, never used to explain a transaction', r.entry_id]); superseded++; }
    }
    await db.run('COMMIT');
    added = (await db.get('SELECT COUNT(*) n FROM ledger')).n - before;
    updated -= added;   // changes() counts inserts and real updates alike; identical rows count 0
  }
  const total = (await db.get('SELECT COUNT(*) n FROM ledger')).n;
  if (annotationsRefused.length) console.error('[ingest] ANNOTATIONS REFUSED: ' + annotationsRefused.join(', '));
  if (quarantined.length) console.error('[ingest] QUARANTINED by the privacy guard (text not shown): ' + quarantined.map((q) => q.source + ' ' + q.source_ref + ' (' + q.kind + ')').join(', '));
  const summary = { runId, unreadableLedger, annotationsRefused, sourceRows: counts, entriesBuilt: entries.length, added, updated, superseded, quarantined, ledgerTotal: total, dry: DRY,
    extract: { ok: extract.ok, ageMin: extract.ageMin == null ? null : +extract.ageMin.toFixed(1), generatedAt: extract.generatedAt, problems: extract.problems } };
  await db.run('UPDATE runs SET finished_at=?, complete=?, summary_json=? WHERE run_id=?', [new Date().toISOString(), extract.ok ? 1 : 0, JSON.stringify(summary), runId]);
  await db.close();
  console.log(JSON.stringify(summary, null, 1));
  if (unreadableLedger.length) { console.error('INGEST INCOMPLETE: unreadable ledger files (every other row was stored): ' + unreadableLedger.join(', ')); process.exit(3); }   // M5
  if (!extract.ok) { console.error('INGEST INCOMPLETE: ' + extract.problems.join('; ')); process.exit(3); }
})().catch((e) => { console.error('INGEST FAILED: ' + (e && e.stack || e)); process.exit(1); });
