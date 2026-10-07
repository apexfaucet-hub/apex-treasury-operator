#!/usr/bin/env node
'use strict';
// WATCHTOWER GAS (2026-10-07). Moves USDC from our x402 receive wallet to the watchtower (agent #211), whose wallet pays the
// gas of every ERC-8004 rating we write (core/arc/fair-rate.js scores, core/arc/watch-feedback.js weekly uptime; ~0.0043 USDC
// each). Our own two wallets only:
//   - both addresses come from their key files and must equal the ones written below (never typed, never recalled); the
//     watchtower must have no contract code, read on chain before signing;
//   - the receive wallet keeps at least SOURCE_KEEP after the send (it pays refunds and refills the operator's gas);
//   - every send asks the send gate (sender "arc-hand-watchtower-gas" in /etc/apex/send-gate.json: 1 USDC per send and per
//     day, enforce) and is recorded by the EVM recorder so the account layer sees a recorded internal transfer.
// Usage: node tools/arc-watchtower-gas.js <usdc> [--live]     (without --live it only checks and prints)
const fs = require('fs');
const v = require('/root/apex-faucet/node_modules/viem');
const { privateKeyToAccount } = require('/root/apex-faucet/node_modules/viem/accounts');
const H = require('/root/apex-faucet/lib/hand-gate.js');

const LIVE = process.argv.includes('--live');
const AMOUNT = Number(process.argv[2]);
const SOURCE_KEEP = 0.3;
const SOURCE_EXPECT = '0xd334ab5151c624cada654854e2879903dc4217ed';
const DEST_EXPECT = '0x6a663faa871f0622ff2435b65f514faf876c59bf';
const SENDER = 'arc-hand-watchtower-gas';
const arc = v.defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } });
const transport = v.fallback(['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io', 'https://rpc.beamrpc.com'].map((u) => v.http(u, { timeout: 20000 })), { rank: false });

(async () => {
  if (!(AMOUNT > 0 && AMOUNT <= 1)) { console.error('amount must be above 0 and at most 1 USDC'); process.exit(2); }
  const src = privateKeyToAccount(JSON.parse(fs.readFileSync('/root/apex-faucet/keys/arc-receive.json', 'utf8')).privateKey);
  const dstFile = JSON.parse(fs.readFileSync('/root/apex-faucet/keys/arc-watchtower.json', 'utf8'));
  const dst = String(dstFile.address || privateKeyToAccount(dstFile.privateKey).address).toLowerCase();
  if (src.address.toLowerCase() !== SOURCE_EXPECT) { console.error('source key does not derive to the expected receive wallet: refusing'); process.exit(3); }
  if (dst !== DEST_EXPECT) { console.error('watchtower key does not derive to the expected address: refusing'); process.exit(3); }
  const pub = v.createPublicClient({ chain: arc, transport });
  const code = await pub.getBytecode({ address: dst });
  if (code && code !== '0x') { console.error('destination has contract code: refusing'); process.exit(3); }
  const [sb, db] = await Promise.all([pub.getBalance({ address: src.address }), pub.getBalance({ address: dst })]);
  const srcUsdc = Number(sb) / 1e18, dstUsdc = Number(db) / 1e18;
  console.log('receive ' + srcUsdc.toFixed(4) + ' USDC, watchtower ' + dstUsdc.toFixed(4) + ' USDC; send ' + AMOUNT);
  if (srcUsdc - AMOUNT - 0.01 < SOURCE_KEEP) { console.error('the receive wallet would fall under its ' + SOURCE_KEEP + ' USDC keep: refusing'); process.exit(3); }
  const req = { source: SENDER, chain: 'arc', chainId: 5042, from: src.address, to: dst, usdc: AMOUNT, purpose: 'watchtower gas for ERC-8004 ratings' };
  if (!LIVE) { console.log('check only (add --live to send). Gate:', JSON.stringify(require('/root/apex-faucet/lib/arc-send-gate.js').reasons(JSON.parse(fs.readFileSync('/etc/apex/send-gate.json', 'utf8')), req, 0))); return; }
  H.mustAllow(req);
  const wal = v.createWalletClient({ chain: arc, transport, account: src });
  let hash;
  try { hash = await wal.sendTransaction({ to: dst, value: v.parseUnits(String(AMOUNT), 18) }); }
  catch (e) { H.release(req, 'send failed: ' + (e.shortMessage || e.message)); console.error('send failed: ' + (e.shortMessage || e.message)); process.exit(1); }
  console.log('sent ' + hash);
  fs.appendFileSync('/root/apex-faucet/data/arc-watchtower-gas.ndjson', JSON.stringify({ at: new Date().toISOString(), hash, usdc: AMOUNT, from: src.address, to: dst }) + '\n');
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60000 }).catch(() => null);
  console.log('receipt ' + (rc ? rc.status : 'not seen yet'));
  await H.record(hash, { source: SENDER, chain: 'arc', wallets: [src.address], expect: { usdc: AMOUNT }, category: 'internal:gas-topup' });
  const after = Number(await pub.getBalance({ address: dst })) / 1e18;
  console.log('watchtower now ' + after.toFixed(4) + ' USDC');
})().catch((e) => { console.error('failed: ' + (e.shortMessage || e.message)); process.exit(1); });
