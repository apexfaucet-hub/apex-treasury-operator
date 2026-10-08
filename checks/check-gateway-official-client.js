#!/usr/bin/env node
'use strict';
// CIRCLE GATEWAY, PAID THE WAY CIRCLE'S OWN BUYERS PAY (2026-10-08). Circle-CLI agents (the Arc buyers) pay through Gateway
// (extra.name GatewayWalletBatched). Nothing had ever paid our Gateway option with Circle's own client. This calls
// GatewayClient.pay() from @circle-fin/x402-batching 3.5.0 (vendor/x402-official) with a brand-new EMPTY wallet, on Arc and on
// Base: nothing can be charged (no Gateway balance). Only a refusal about money passes; anything else means a funded Gateway
// buyer is refused too -> exit 1. --plant signs for one unit less than the price: no longer a money refusal, so it must FAIL.
const base = '/root/apex-faucet/vendor/x402-official/node_modules/';
const { GatewayClient } = require(base + '@circle-fin/x402-batching/dist/client/index.js');
const { generatePrivateKey } = require(base + 'viem/_cjs/accounts/index.js');
const plant = process.argv.includes('--plant');
const MONEY = /insufficient|balance|funds/i;
const realFetch = global.fetch;
let last = null;
global.fetch = async (u, o) => {
  const h = new Headers((o && o.headers) || {});
  const ps = h.get('payment-signature');
  if (ps) {
    const p = JSON.parse(Buffer.from(ps, 'base64').toString());
    last = { sent: p };
    if (plant && p.payload && p.payload.authorization) {
      p.payload.authorization.value = String(BigInt(p.payload.authorization.value) - 1n);
      h.set('payment-signature', Buffer.from(JSON.stringify(p)).toString('base64'));
      o = Object.assign({}, o, { headers: Object.fromEntries(h.entries()) });
    }
    const r = await realFetch(u, o);
    const pr = r.headers.get('payment-required');
    last.status = r.status; last.reason = pr ? (JSON.parse(Buffer.from(pr, 'base64').toString()).error || '') : '';
    return r;
  }
  return realFetch(u, o);
};
async function one(chain, label) {
  last = null;
  const gw = new GatewayClient({ chain, privateKey: generatePrivateKey() });
  let threw = '';
  try { await gw.pay('https://apexfaucet.xyz/api/x402/xnt-price', { headers: { 'user-agent': 'apex-check-gateway-official-client/1' } }); }
  catch (e) { threw = String(e.message || e).slice(0, 160); }
  const sent = last && last.sent;
  const isGw = !!(sent && sent.accepted && sent.accepted.extra && sent.accepted.extra.name === 'GatewayWalletBatched');
  const ok = isGw && last.status === 402 && MONEY.test(last.reason);
  console.log((ok ? 'OK  ' : 'FAIL') + '  ' + label + ' Gateway, Circle GatewayClient.pay(), empty wallet: '
    + (sent ? 'payment sent (' + (isGw ? 'GatewayWalletBatched' : 'not the Gateway option') + ', ' + sent.accepted.network + '), answer ' + last.status + ' ' + String(last.reason).slice(0, 150) : 'NO payment was sent (' + threw + ')')
    + (ok ? ' (refused only for lack of a Gateway balance)' : ' <- a funded Gateway buyer would be refused too'));
  return ok;
}
(async () => {
  const a = await one('arc', 'Arc');
  const b = await one('base', 'Base');
  process.exit(a && b ? 0 : 1);
})().catch((e) => { console.log('FAIL  check crashed: ' + e.message); process.exit(1); });
