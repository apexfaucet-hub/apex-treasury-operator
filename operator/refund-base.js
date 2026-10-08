#!/usr/bin/env node
'use strict';
// REFUND A PAID CALL ON BASE (2026-10-07). When we charged for something we did not deliver (a 400 after settling, a 502 while
// restarting), the payer gets the full amount back. Until now refunds were sent by hand and written into data/refunds.ndjson
// afterwards. This tool does it the same way every time:
//   - the payment is READ FROM THE CHAIN (Base USDC Transfer to one of our receive wallets, receipt status success): payer and
//     amount come from the log, never from a message or from memory (CLAUDE.md §2, §4b);
//   - refused if data/refunds.ndjson already has a refund of that payment, or the amount is above 0.05 USDC (a bigger refund is
//     a decision for a human-readable reason, not this tool);
//   - the payer is screened first (lib/sanctions.js OFAC SDN list + USDC isBlacklisted on chain; no current list = refused);
//   - the send asks the send gate (sender base-refund in /etc/apex/send-gate.json);
//   - the record IS the refund line in data/refunds.ndjson (tools/account-ingest.js reads it as ledger source 'refunds', and
//     lib/settlements.js nets it from revenue). It is not also written through lib/ledger-log-evm.js: two rows for one
//     transaction would make the books see a recorded amount twice the chain's.
// Usage: sudo node tools/refund-base.js --payment <0x tx hash> --reason "<what went wrong, 20+ chars>" [--live]
const fs = require('fs');
const v = require('/root/apex-faucet/node_modules/viem');
const { base } = require('/root/apex-faucet/node_modules/viem/chains');
const { privateKeyToAccount } = require('/root/apex-faucet/node_modules/viem/accounts');
const H = require('/root/apex-faucet/lib/hand-gate.js');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const LIVE = process.argv.includes('--live');
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RECEIVE = new Set(['0xd334ab5151c624cada654854e2879903dc4217ed']);   // our x402 payTo on Base (wallet-registry base:0xd334ab51)
const REFUNDS = '/root/apex-faucet/data/refunds.ndjson';
const KEY = '/root/apex-faucet/keys/arc-operator.json';                    // the operator on Base: "gas for refunds" in the registry
const MAX = 0.05;
(async () => {
  const pay = String(arg('--payment') || '').toLowerCase(); const reason = String(arg('--reason') || '');
  if (!/^0x[0-9a-f]{64}$/.test(pay) || reason.length < 20) { console.error('usage: --payment <0x tx hash> --reason "<20+ chars>" [--live]'); process.exit(2); }
  const done = fs.existsSync(REFUNDS) ? fs.readFileSync(REFUNDS, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } }) : [];
  if (done.some((r) => String(r.refundOf || '').toLowerCase() === pay)) { console.error('REFUSED: this payment was already refunded'); process.exit(3); }
  const pub = v.createPublicClient({ chain: base, transport: v.fallback([v.http('https://mainnet.base.org'), v.http('https://base-rpc.publicnode.com')]) });
  const rc = await pub.getTransactionReceipt({ hash: pay });
  if (rc.status !== 'success') { console.error('REFUSED: the payment transaction did not succeed'); process.exit(3); }
  const legs = rc.logs.filter((l) => l.address.toLowerCase() === USDC && l.topics[0] === TRANSFER && RECEIVE.has('0x' + l.topics[2].slice(26)));
  if (legs.length !== 1) { console.error('REFUSED: expected exactly one USDC transfer to our receive wallet in that transaction, found ' + legs.length); process.exit(3); }
  const payer = v.getAddress('0x' + legs[0].topics[1].slice(26)), raw = BigInt(legs[0].data), usd = Number(raw) / 1e6;
  if (!(usd > 0) || usd > MAX) { console.error('REFUSED: amount ' + usd + ' USDC is outside (0, ' + MAX + ']'); process.exit(3); }
  const code = await pub.getCode({ address: payer });
  const account = privateKeyToAccount(JSON.parse(fs.readFileSync(KEY, 'utf8')).privateKey);
  const erc = v.parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
  const have = await pub.readContract({ address: USDC, abi: erc, functionName: 'balanceOf', args: [account.address] });
  console.log(JSON.stringify({ payment: pay, payer, usd, payerIsContract: !!(code && code !== '0x'), from: account.address, fromUsdc: Number(have) / 1e6, reason }));
  if (have < raw) { console.error('REFUSED: the operator holds ' + Number(have) / 1e6 + ' USDC on Base'); process.exit(3); }
  // SANCTIONS (2026-10-08, CLAUDE.md §9): screened before any send, dry run included; no current list = no refund (fail closed).
  let sc; try { sc = await require('/root/apex-faucet/lib/sanctions.js').checkEvm(payer); } catch (e) { console.error('REFUSED: ' + e.message); process.exit(3); }
  if (sc.listed) { console.error('REFUSED: ' + payer + ' is on the OFAC SDN list (' + sc.name + '). Do not refund; a human decides.'); process.exit(3); }
  const blk = await pub.readContract({ address: USDC, abi: v.parseAbi(['function isBlacklisted(address) view returns (bool)']), functionName: 'isBlacklisted', args: [payer] });
  if (blk) { console.error('REFUSED: ' + payer + ' is on the USDC blacklist'); process.exit(3); }
  console.log('sanctions: not on the OFAC SDN list (' + sc.addresses + ' addresses, copy ' + sc.listAgeDays + ' days old), not USDC-blacklisted');
  if (!LIVE) return console.log('dry run (add --live to send)');
  const greq = { source: 'base-refund', chain: 'base', chainId: 8453, from: account.address, to: payer, usdc: usd, purpose: 'refund of ' + pay };
  H.mustAllow(greq);
  const wal = v.createWalletClient({ chain: base, transport: v.http('https://mainnet.base.org'), account });
  let hash;
  try { const { request } = await pub.simulateContract({ address: USDC, abi: erc, functionName: 'transfer', args: [payer, raw], account }); hash = await wal.writeContract(request); }
  catch (e) { H.release(greq, 'not sent: ' + (e.shortMessage || e.message)); throw e; }
  const r2 = await pub.waitForTransactionReceipt({ hash });
  if (r2.status !== 'success') { console.error('refund reverted: ' + hash); process.exit(1); }
  fs.appendFileSync(REFUNDS, JSON.stringify({ at: new Date().toISOString(), chain: 'base', refundOf: pay, to: payer, usd, tx: hash, reason, from: account.address.toLowerCase(), fromSource: 'tools/refund-base.js (payment read from the chain)' }) + '\n');
  console.log('REFUNDED ' + usd + ' USDC to ' + payer + ' tx ' + hash);
})().catch((e) => { console.error('REFUND FAILED: ' + (e.shortMessage || e.message)); process.exit(1); });
