'use strict';
// HAND TOOLS ASK THE SEND GATE (2026-10-07). The hand-run money scripts (buyback, APEX sale and LP on Arc, CCTP Arc -> Base,
// the Solana -> Arc relay) used to carry their limits in their own code, or none: cctp-arc-to-base.js would burn any amount
// to any recipient typed on the command line. Now each asks lib/arc-send-gate.js before it signs, under its own sender name
// in /etc/apex/send-gate.json (enforce, own wallets, own destinations, own caps), and records what it sent with
// lib/ledger-log-evm.js so the account layer sees a recorded outflow instead of raising an alert.
//   const H = require('/root/apex-faucet/lib/hand-gate.js');
//   const req = { source: 'arc-hand-buyback', chain: 'arc', chainId: 5042, from, to, usdc: 2, tokens: { [APEX]: 0 }, purpose: '...' };
//   H.mustAllow(req);                 // refused => prints the reasons and exits 4; nothing is signed
//   ...sign...; if it did not happen: H.release(req, 'why');
//   await H.record(hash, { source, chain: 'arc', wallets: [from], expect: { usdc: 2 }, category: 'trade:buyback' });
// Fails closed: if the gate module cannot load or throws, the tool exits without signing. Token amounts in req.tokens are
// WHOLE tokens (the policy's token caps are written in whole tokens too).
function gate() { return require('/root/apex-faucet/lib/arc-send-gate.js'); }
function mustAllow(req) {
  let d;
  try { d = gate().check(req); } catch (e) { d = { allow: false, reasons: ['send gate unavailable: ' + e.message] }; }
  if (!d || !d.allow) {
    console.error('SEND GATE REFUSED ' + req.source + ' (' + req.usdc + ' USDC -> ' + req.to + '): ' + ((d && d.reasons) || []).join('; ') + '. Nothing was signed.');
    process.exit(4);
  }
  return d;
}
function release(req, why) { try { gate().release(req, why); } catch (e) { console.error('[hand-gate] release not written: ' + e.message); } }
async function record(hash, meta) {
  try { const f = await require('/root/apex-faucet/lib/ledger-log-evm.js').recordSentEvm(hash, meta); console.log('recorded', meta.source, hash, Array.isArray(f) ? f.length + ' leg(s)' : 'see data/ledger/_errors-' + meta.source + '.ndjson'); return f; }
  catch (e) { console.error('[hand-gate] recorder failed (the account layer will alarm on this send): ' + e.message); return null; }
}
module.exports = { mustAllow, release, record };
