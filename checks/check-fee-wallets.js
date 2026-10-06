#!/usr/bin/env node
'use strict';
// NIGHTWATCH: DO THE WALLETS THAT PAY OUR FEES STILL HOLD ENOUGH? (2026-10-06)
// Two fee wallets ran dry while nobody could look: the X1 FLUX treasury (fee payer of the hourly ledger anchor) fell under
// the rent floor on 1 Oct and the anchor failed every hour for five days; the Arc settlement operator ran out of gas on
// 4 Oct and direct Arc payments from outside wallets were refused. This fails EARLY, days before either stops working.
// Addresses come from key files (never typed). Exit 1 = a wallet is under its floor or could not be read.
// Usage: node tools/check-fee-wallets.js [--min-flux XNT] [--min-arc USDC]   (raise a floor to watch it fail)
const fs = require('fs');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const MIN_FLUX_XNT = arg('--min-flux', 0.1);    // anchor ~0.0012 XNT a day, but FLUX also pays the city economy (7-35 tx a day at 0.002) and city memos: 0.1 is a few days of warning
const MIN_JUG_XNT = arg('--min-jug', 0.35);   // jar mints stop at 0.3 (the arena-withdrawal reserve); warn just above it
const MIN_BSC_BNB = arg('--min-bsc', 0.0003);   // ~65 BNB settlements of warning (2026-10-06)
const MIN_ARC_USDC = arg('--min-arc', 0.25);    // 6 Oct: under the refill floor (0.4), so this alert means the refill did not work. ~0.0017-0.0018 USDC per tx (settlements, relayed faucet claims, meals, setLimits); measured 0.46/day on 6 Oct: 0.4 is about a day of warning
const post = async (url, method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 120)); return j.result;
};
const firstOk = async (urls, method, params) => { let last; for (const u of urls) { try { return await post(u, method, params); } catch (e) { last = e; } } throw last; };
(async () => {
  const bad = [];
  try {
    const { Keypair } = require('/root/apex-faucet/node_modules/@solana/web3.js');
    const a = JSON.parse(fs.readFileSync('/home/claudeuser/ghost-agent/wallets/ghost-2.json', 'utf8'));
    const flux = Keypair.fromSecretKey(Uint8Array.from(Array.isArray(a) ? a : a.secretKey)).publicKey.toBase58();
    const r = await firstOk(['https://rpc.mainnet.x1.xyz'], 'getBalance', [flux]);
    const xnt = r.value / 1e9;
    (xnt < MIN_FLUX_XNT ? bad : []).push('FLUX ' + flux.slice(0, 8) + '… holds ' + xnt.toFixed(6) + ' XNT, floor ' + MIN_FLUX_XNT + ' (ledger anchor fee payer)');
    console.log('  ' + (xnt < MIN_FLUX_XNT ? 'LOW ' : 'OK  ') + ' X1  FLUX ' + flux.slice(0, 8) + '…  ' + xnt.toFixed(6) + ' XNT (floor ' + MIN_FLUX_XNT + ')');
  } catch (e) { bad.push('FLUX balance could not be read: ' + String(e.message).slice(0, 100)); console.log('  FAIL X1  FLUX unreadable'); }
  // The jug (arena-wallet.json) pays every arena withdrawal and, since 6 Oct, the city-economy jar mints, which stop at 0.3 XNT.
  try {
    const { Keypair } = require('/root/apex-faucet/node_modules/@solana/web3.js');
    const jug = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('/root/apex-faucet/arena-wallet.json', 'utf8')))).publicKey.toBase58();
    const r = await firstOk(['https://rpc.mainnet.x1.xyz'], 'getBalance', [jug]);
    const xnt = r.value / 1e9;
    (xnt < MIN_JUG_XNT ? bad : []).push('JUG ' + jug.slice(0, 8) + '… holds ' + xnt.toFixed(6) + ' XNT, floor ' + MIN_JUG_XNT + ' (pays arena withdrawals and jar mints)');
    console.log('  ' + (xnt < MIN_JUG_XNT ? 'LOW ' : 'OK  ') + ' X1  JUG ' + jug.slice(0, 8) + '…  ' + xnt.toFixed(6) + ' XNT (floor ' + MIN_JUG_XNT + ')');
  } catch (e) { bad.push('JUG balance could not be read: ' + String(e.message).slice(0, 100)); console.log('  FAIL X1  JUG unreadable'); }
  try {
    const { privateKeyToAccount } = require('/root/apex-faucet/node_modules/viem/accounts');
    const op = privateKeyToAccount(JSON.parse(fs.readFileSync('/root/apex-faucet/keys/arc-operator.json', 'utf8')).privateKey).address;
    const hex = await firstOk(['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io', 'https://rpc.beamrpc.com'], 'eth_getBalance', [op, 'latest']);
    const usdc = Number(BigInt(hex)) / 1e18;
    (usdc < MIN_ARC_USDC ? bad : []).push('Arc operator ' + op.slice(0, 10) + '… holds ' + usdc.toFixed(6) + ' USDC gas, floor ' + MIN_ARC_USDC + ' (settles direct Arc payments)');
    console.log('  ' + (usdc < MIN_ARC_USDC ? 'LOW ' : 'OK  ') + ' Arc operator ' + op.slice(0, 10) + '…  ' + usdc.toFixed(6) + ' USDC (floor ' + MIN_ARC_USDC + ')');
  } catch (e) { bad.push('Arc operator balance could not be read: ' + String(e.message).slice(0, 100)); console.log('  FAIL Arc operator unreadable'); }
  // BNB Chain (2026-10-06): the same operator address pays the gas of BNB settlements (bsc-facilitator.js), ~0.0000046 BNB each.
  try {
    const { privateKeyToAccount } = require('/root/apex-faucet/node_modules/viem/accounts');
    const op = privateKeyToAccount(JSON.parse(fs.readFileSync('/root/apex-faucet/keys/arc-operator.json', 'utf8')).privateKey).address;
    const hex = await firstOk(['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc.publicnode.com'], 'eth_getBalance', [op, 'latest']);
    const bnb = Number(BigInt(hex)) / 1e18;
    (bnb < MIN_BSC_BNB ? bad : []).push('BNB operator ' + op.slice(0, 10) + '… holds ' + bnb.toFixed(7) + ' BNB gas, floor ' + MIN_BSC_BNB + ' (settles BNB payments)');
    console.log('  ' + (bnb < MIN_BSC_BNB ? 'LOW ' : 'OK  ') + ' BNB operator ' + op.slice(0, 10) + '…  ' + bnb.toFixed(7) + ' BNB (floor ' + MIN_BSC_BNB + ')');
  } catch (e) { bad.push('BNB operator balance could not be read: ' + String(e.message).slice(0, 100)); console.log('  FAIL BNB operator unreadable'); }
  if (bad.length) { console.log('\n' + bad.length + ' fee wallet(s) need a top-up:\n  - ' + bad.join('\n  - ')); process.exit(1); }
  console.log('\nfee wallets above their floors.');
})();
