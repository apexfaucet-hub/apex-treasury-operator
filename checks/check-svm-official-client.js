#!/usr/bin/env node
'use strict';
// SOLANA RAIL, PAID THE WAY A REAL BUYER PAYS (2026-10-08). For at least 9 days every standard x402 Solana payment was refused with
// network_mismatch (normNet lowercased the base58 CAIP-2 id, and the verifier was handed 'solana' instead of the CAIP-2 id), while
// the nightly pay-rails check said "fee payer funded" and stayed green. This pays one call with Coinbase's official client
// (@x402/svm 2.28.0, pinned in vendor/x402-official) from a brand-new EMPTY wallet: nothing can be charged. The only acceptable
// refusal is the one about money (the empty wallet has no USDC account / no funds); any other reason means a funded buyer would
// be refused too -> exit 1. --plant expects the wrong network on purpose (sends to a CAIP-2 id we do not accept): must FAIL.
const base = '/root/apex-faucet/vendor/x402-official/node_modules/';
const { x402Client, wrapFetchWithPayment } = require(base + '@x402/fetch/dist/cjs/index.js');
const { registerExactSvmScheme } = require(base + '@x402/svm/dist/cjs/exact/client/index.js');
const kit = require(base + '@solana/kit');
const plant = process.argv.includes('--plant');
const MONEY = /source_account_missing|insufficient|no_funds|balance|simulation/i;
(async () => {
  const signer = await kit.generateKeyPairSigner();
  const client = new x402Client();
  registerExactSvmScheme(client, { signer, networks: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] });
  let sent = null;
  const spy = async (u, o) => {
    if (u && typeof u === 'object' && u.headers && typeof u.headers.get === 'function') {
      const ps = u.headers.get('payment-signature');
      if (ps) {
        sent = JSON.parse(Buffer.from(ps, 'base64').toString());
        if (plant) { sent.accepted.network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'; const h = new Headers(u.headers); h.set('payment-signature', Buffer.from(JSON.stringify(sent)).toString('base64')); return fetch(new Request(u, { headers: h })); }
      }
    }
    return fetch(u, o);
  };
  const f = wrapFetchWithPayment(spy, client);
  let status = 0, reason = '';
  try {
    const r = await f('https://apexfaucet.xyz/api/x402/xnt-price', { headers: { 'user-agent': 'apex-check-svm-official-client/1' } });
    status = r.status;
    const pr = r.headers.get('payment-required'); if (pr) reason = JSON.parse(Buffer.from(pr, 'base64').toString()).error || '';
  } catch (e) { reason = 'client threw: ' + String(e.message || e).slice(0, 160); }
  const ok = !!sent && status === 402 && MONEY.test(reason);
  console.log((ok ? 'OK  ' : 'FAIL') + '  Solana rail, official @x402/svm client, empty wallet ' + signer.address.slice(0, 8) + '...: '
    + (sent ? 'payment sent (v' + sent.x402Version + ', ' + sent.accepted.network.slice(0, 14) + '...)' : 'NO payment was built') + ', answer ' + status + ' ' + reason
    + (ok ? ' (refused only for lack of funds: a funded buyer gets through)' : ' <- a funded buyer would be refused too'));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log('FAIL  check crashed: ' + e.message); process.exit(1); });
