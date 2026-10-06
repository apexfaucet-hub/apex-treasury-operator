'use strict';
// ACCOUNT LAYER: which annotation rows the ingest may use (2026-10-06, Fable review gap 1). Pure: no I/O.
// Two annotation rows that build the same source_ref used to overwrite each other through ON CONFLICT (a gas row replaced a
// 1.0 USDC value row). So: (a) an annotation never carries a fee, because the reconciler adds fees from receipts; a fee row
// is refused. (b) When two rows build the same key, ALL of them are refused, so the transaction surfaces as unrecorded
// instead of being explained by whichever row came last. Tested by tests/annotation-filter.test.js.
const TX = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/;
const FEE = /^(cost:gas|cost:fee|gas|fee)(:|$)/;   // whole word only: cost:gas-topup is not a fee (Fable review)
const keyOf = (a) => a.tx + ':' + (a.leg || 'out');

function filterAnnotations(rows) {
  const accepted = [];
  const refused = [];
  const seen = {};
  for (const a of rows) if (a && a.tx) seen[keyOf(a)] = (seen[keyOf(a)] || 0) + 1;
  for (const a of rows) {
    if (!a || !a.tx || !TX.test(a.tx)) continue;   // no full hash: ignored, as before
    if (FEE.test(String(a.category || ''))) { refused.push(keyOf(a) + ' (a fee row: the reconciler owns fees)'); continue; }
    if (seen[keyOf(a)] > 1) { refused.push(keyOf(a) + ' (' + seen[keyOf(a)] + ' rows build this key; give each a distinct leg)'); continue; }
    accepted.push(a);
  }
  return { accepted, refused, keyOf };
}
module.exports = { filterAnnotations, keyOf };
