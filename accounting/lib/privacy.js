'use strict';
// ACCOUNT LAYER privacy guard (2026-09-29). The ledger holds wallets and amounts, never a person: no email, no phone
// number, no card detail, no Stripe customer id. Ingest refuses the whole batch if any entry carries one.
const PATTERNS = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['stripe customer', /\bcus_[A-Za-z0-9]{8,}/],
  ['card number', /\b(?:\d[ -]?){13,19}\b(?![0-9a-fA-Fx])/],
  ['phone', /\+\d{1,3}[ .-]?\d{2,4}[ .-]?\d{3,4}[ .-]?\d{3,4}\b/],
];
function findPersonalData(entries) {
  for (const e of entries) {
    // Amounts, times and hashes are numeric by nature: scan only the text fields a person could reach.
    const text = [e.counterparty, e.product, e.notes, e.source_ref, e.wallet_id].filter((x) => x != null).join(' | ');
    for (const [kind, re] of PATTERNS) if (re.test(text)) return { kind, source: e.source, source_ref: e.source_ref };
  }
  return null;
}
function assertNoPersonalData(entries) {
  const hit = findPersonalData(entries);
  if (hit) throw new Error('refusing to ingest: ' + hit.kind + '-like text in entry ' + hit.source + ' ' + hit.source_ref);
}
module.exports = { findPersonalData, assertNoPersonalData, PATTERNS };
