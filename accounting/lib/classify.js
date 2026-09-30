'use strict';
// ACCOUNT LAYER: how one movement of value is sorted (2026-09-29, rewritten after the second Fable review). PURE: no I/O,
// so every rule is tested with planted cases in tools/account-exit-tests.js (p4).
//
// The review found four ways a real outflow could pass unalarmed; each rule below closes one:
//   - a hash in the ledger explains a leg only if the ledger has it for THIS wallet and THIS asset, with an amount that
//     can be compared and agrees (a hash filed under another wallet, or an amount that cannot be checked, explains nothing)
//   - 'trade' needs a valued asset arriving AND a real venue in the same transaction (DEX program / pool manager log);
//     "some other token arrived" is not a trade (a drain plus one unit of a junk token was a "trade")
//   - 'rent' only for NEW accounts that are token accounts of ours, or accounts owned by a program we run
//   - alarms are raised only for assets we value; junk tokens and city commodities are reported, never alarmed
const ALARM_KINDS = new Set(['OUTFLOW-UNRECORDED', 'BURN-UNRECORDED', 'RECORDED-AMOUNT-DIFFERS']);

// Verdict of the ledger on one leg. rowsForTx: every non-superseded ledger row carrying this hash.
//   match | differs | unverifiable (row exists, amount cannot be compared) | other-wallet | none
// o.feeRaw: SVM network fee this wallet paid in the tx (a 'transfer' row never carries it)
// o.gasRaw: EVM gas this wallet paid for this tx; o.spareGas: gas of this wallet's own sent txs that moved no token
// (approvals), each usable once: a 'net-of-gas' row may include at most ONE of them, matched exactly.
function ledgerVerdict(rowsForTx, walletId, asset, chainRaw, decimals, o) {
  o = o || {};
  if (!rowsForTx || !rowsForTx.length) return { verdict: 'none' };
  const rows = rowsForTx.filter((r) => r.wallet_id === walletId && r.asset_id === asset);
  if (!rows.length) return { verdict: 'other-wallet' };
  const sources = [...new Set(rows.map((r) => r.source))];
  const sign = (r) => (r.direction === 'in' ? 1n : r.direction === 'out' ? -1n : 0n);
  if (rows.every((r) => r.amount_raw != null)) {   // exact raw units from the writer: compare exactly
    const led = rows.reduce((t, r) => t + sign(r) * BigInt(r.amount_raw), 0n);
    return led === chainRaw ? { verdict: 'match' } : { verdict: 'differs', ledger: led.toString(), chain: chainRaw.toString(), basis: 'raw', sources };
  }
  if (decimals == null || rows.some((r) => r.amount == null)) return { verdict: 'unverifiable', sources };
  const led = rows.reduce((t, r) => t + Number(sign(r)) * r.amount, 0);
  const ui = (raw) => Number(raw) / 10 ** decimals;
  if (rows.every((r) => r.amount_basis === 'net-of-gas')) {
    const net = ui(chainRaw - (o.gasRaw || 0n)), tol = 1.5e-6;   // the trader rounds to 6 decimals
    if (Math.abs(led - net) <= tol) return { verdict: 'match' };
    for (const sg of (o.spareGas || [])) if (!sg.used && Math.abs(led - (net - ui(sg.gas))) <= tol) { sg.used = true; return { verdict: 'match', approval: sg.h }; }
    return { verdict: 'differs', ledger: led, chain: net, basis: 'net-of-gas', sources };
  }
  const onChain = ui(chainRaw + (o.feeRaw || 0n));
  return Math.abs(led - onChain) > Math.max(1e-9, Math.abs(onChain) * 1e-6) ? { verdict: 'differs', ledger: led, chain: onChain, basis: 'transfer', sources } : { verdict: 'match' };
}

// One OUTFLOW leg (raw < 0). c = { valued, ledger: verdict object, contractEvent, feeOnly, allCounterpartiesOurs,
// tradeEvidence, rentOk, amountMatch, burned }. Order matters: the first rule that holds decides.
function classifyOutflow(c) {
  const v = c.ledger ? c.ledger.verdict : 'none';
  if (v === 'match') return { kind: 'recorded' };
  if (v === 'differs') return { kind: 'RECORDED-AMOUNT-DIFFERS', diff: c.ledger };
  if (c.contractEvent) return { kind: 'recorded-by-contract-event' };
  if (c.feeOnly) return { kind: 'fee' };
  if (c.allCounterpartiesOurs) return { kind: 'internal' };
  if (c.tradeEvidence) return { kind: 'trade' };
  if (c.rentOk) return { kind: 'rent' };
  if (c.amountMatch) return { kind: 'recorded-by-amount' };
  const note = v === 'unverifiable' ? 'the ledger has this hash for this wallet but its amount cannot be checked'
    : v === 'other-wallet' ? 'the hash is in the ledger only under another wallet or asset' : undefined;
  if (c.burned) return { kind: c.valued ? 'BURN-UNRECORDED' : 'burn-unvalued', note };
  return { kind: c.valued ? 'OUTFLOW-UNRECORDED' : 'unvalued-movement', note };
}

// One INFLOW leg (raw > 0): recorded when the ledger agrees; a disagreeing amount is an alarm (revenue booked wrong).
function classifyInflow(c) {
  const v = c.ledger ? c.ledger.verdict : 'none';
  if (v === 'match') return { kind: 'recorded' };
  if (v === 'differs') return { kind: 'RECORDED-AMOUNT-DIFFERS', diff: c.ledger };
  if (c.allCounterpartiesOurs) return { kind: 'internal' };
  return { kind: c.valued ? 'inflow-unrecorded' : 'unvalued-movement', note: v === 'unverifiable' ? 'logged, amount not checkable' : undefined };
}

// Rent: every account that gained lamports is NEW, rent-sized, and either a token account owned by this wallet or by
// another wallet of ours, or an account owned by a program in `knownPrograms`. owners: account -> owner program (read
// by the caller; null = no longer exists = cannot be proven rent).
function rentOk(gainers, wallet, isOurs, owners, knownPrograms, rentMax) {
  if (!gainers.length) return false;
  for (const g of gainers) {
    if (!g.newAccount || g.raw > rentMax) return false;
    if (g.tokenAccount) { if (!(g.tokenOwner && (g.tokenOwner === wallet || isOurs(g.tokenOwner)))) return false; continue; }
    const o = owners.get(g.account);
    if (!o || !knownPrograms.has(o)) return false;
  }
  return true;
}

// Trade evidence on SVM: another VALUED asset arrived in this wallet in the same tx AND the tx invoked a venue program.
function svmTradeEvidence(effects, asset, valued, programs, venues) {
  return effects.some((x) => x.asset !== asset && x.raw > 0n && valued(x.asset)) && (programs || []).some((pg) => venues.has(pg));
}
// Trade evidence on EVM: another VALUED asset came to this wallet in the same tx AND the receipt has a log from a venue.
function evmTradeEvidence(txMoves, wallet, asset, valued, receiptLogs, venues) {
  return (receiptLogs || []).some((l) => venues.has(l.address)) && txMoves.some((x) => x.to === wallet && x.asset !== asset && valued(x.asset));
}

// Is this reference a real chain transaction hash? EVM: 0x + 64 hex (any case). SVM: base58, which is case-SENSITIVE
// (lowercase i and o valid, uppercase I and O, lowercase l and 0 not). An alert on a non-chain reference (a Circle Gateway
// settlement id) is a method error; an alert on a real hash must stay open until a later run EXPLAINS it (2026-09-29: a
// case-insensitive class here let ~95% of X1/Solana alerts close themselves).
function isChainRef(t) {
  const s = String(t || '');
  return /^0x[0-9a-fA-F]{64}$/.test(s) || /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s) || /^(delta|drop):/.test(s);
}

module.exports = { ALARM_KINDS, ledgerVerdict, classifyOutflow, classifyInflow, rentOk, svmTradeEvidence, evmTradeEvidence, isChainRef };
