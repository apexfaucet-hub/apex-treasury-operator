#!/usr/bin/env node
'use strict';
// EVM RAILS, PAID THE WAY A REAL BUYER PAYS (2026-10-08). Same lesson as Solana that day (every standard Solana payment had been
// refused for 9+ days while every check was green): a rail is proven by a STANDARD client. This pays one call with Coinbase's
// official @x402/evm 2.28.0 client (2.27.0 does not know Arc USDC and refuses to pay there) (vendor/x402-official) from a brand-new EMPTY wallet, once on Base and once on Arc: nothing
// can be charged. The only acceptable refusal is one about money; any other reason means a funded buyer is refused too -> exit 1.
// --plant signs for the wrong amount (one unit less): the refusal is no longer about money, so it must FAIL.
const base = '/root/apex-faucet/vendor/x402-official/node_modules/';
const { x402Client, wrapFetchWithPayment } = require(base + '@x402/fetch/dist/cjs/index.js');
const { registerExactEvmScheme } = require(base + '@x402/evm/dist/cjs/exact/client/index.js');
const { privateKeyToAccount, generatePrivateKey } = require(base + 'viem/_cjs/accounts/index.js');
const plant = process.argv.includes('--plant');
const MONEY = /insufficient|balance|exceeds|funds/i;
async function one(network, label) {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account, networks: [network] });
  let sent = null;
  const spy = async (u, o) => {
    if (u && typeof u === 'object' && u.headers && typeof u.headers.get === 'function') {
      const ps = u.headers.get('payment-signature');
      if (ps) {
        sent = JSON.parse(Buffer.from(ps, 'base64').toString());
        if (plant && sent.payload && sent.payload.authorization) {
          sent.payload.authorization.value = String(BigInt(sent.payload.authorization.value) - 1n);
          const h = new Headers(u.headers); h.set('payment-signature', Buffer.from(JSON.stringify(sent)).toString('base64')); return fetch(new Request(u, { headers: h }));
        }
      }
    }
    return fetch(u, o);
  };
  const f = wrapFetchWithPayment(spy, client);
  let status = 0, reason = '';
  try {
    const r = await f('https://apexfaucet.xyz/api/x402/xnt-price', { headers: { 'user-agent': 'apex-check-evm-official-client/1' } });
    status = r.status;
    const pr = r.headers.get('payment-required'); if (pr) reason = JSON.parse(Buffer.from(pr, 'base64').toString()).error || '';
    if (!reason) { try { const j = await r.json(); reason = String((j.x402 && j.x402.errorReason) || j.error || ''); } catch (e) {} }
  } catch (e) { reason = 'client threw: ' + String(e.message || e).slice(0, 160); }
  const ok = !!sent && status === 402 && MONEY.test(reason);
  console.log((ok ? 'OK  ' : 'FAIL') + '  ' + label + ' rail, official @x402/evm client, empty wallet ' + account.address.slice(0, 10) + '...: '
    + (sent ? 'payment sent (v' + sent.x402Version + ', ' + ((sent.accepted && sent.accepted.network) || sent.network) + ')' : 'NO payment was built') + ', answer ' + status + ' ' + String(reason).slice(0, 140)
    + (ok ? ' (refused only for lack of funds)' : ' <- a funded buyer would be refused too'));
  return ok;
}
(async () => {
  const a = await one('eip155:8453', 'Base');
  const b = await one('eip155:5042', 'Arc');
  process.exit(a && b ? 0 : 1);
})().catch((e) => { console.log('FAIL  check crashed: ' + e.message); process.exit(1); });
