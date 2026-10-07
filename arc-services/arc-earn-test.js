#!/usr/bin/env node
'use strict';
// ARC EARN ROUND TRIP (2026-10-07). Before /arc/earn/ offers a Deposit button to anyone, one of OUR wallets proves the whole path
// on a real Morpho Vault V2 on Arc: approve the vault on USDC's ERC-20 face (0x3600..., read from asset()), deposit(assets, us),
// read the shares, then redeem them back to us. Every step is simulated first; the deposit asks the send gate (sender
// "arc-hand-earn-test": our passport wallet, the Keyrock vault only, 0.05 USDC per send) and every send is recorded.
// Usage: node tools/arc-earn-test.js <vault> <usdc> [--live]
const fs = require('fs');
const v = require('/root/apex-faucet/node_modules/viem');
const { privateKeyToAccount } = require('/root/apex-faucet/node_modules/viem/accounts');
const H = require('/root/apex-faucet/lib/hand-gate.js');

const VAULT = String(process.argv[2] || '').toLowerCase();
const AMOUNT = Number(process.argv[3]);
const LIVE = process.argv.includes('--live');
const SENDER = 'arc-hand-earn-test';
const arc = v.defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } });
const transport = v.fallback(['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io'].map((u) => v.http(u, { timeout: 20000 })), { rank: false });
const ERC20 = v.parseAbi(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const VA = v.parseAbi(['function asset() view returns (address)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)', 'function previewDeposit(uint256) view returns (uint256)', 'function previewRedeem(uint256) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)', 'function deposit(uint256 assets, address onBehalf) returns (uint256)', 'function redeem(uint256 shares, address receiver, address onBehalf) returns (uint256)']);

(async () => {
  if (!/^0x[0-9a-f]{40}$/.test(VAULT) || !(AMOUNT > 0 && AMOUNT <= 0.05)) { console.error('usage: arc-earn-test.js <vault> <usdc up to 0.05> [--live]'); process.exit(2); }
  const k = JSON.parse(fs.readFileSync('/root/apex-faucet/keys/arc-passport.json', 'utf8'));
  const acct = privateKeyToAccount(k.privateKey), me = acct.address;
  const pub = v.createPublicClient({ chain: arc, transport });
  const wal = v.createWalletClient({ chain: arc, transport, account: acct });
  const asset = (await pub.readContract({ address: VAULT, abi: VA, functionName: 'asset' })).toLowerCase();
  if (asset !== '0x3600000000000000000000000000000000000000') { console.error('vault asset is ' + asset + ', not USDC: refusing'); process.exit(3); }
  const dec = Number(await pub.readContract({ address: asset, abi: ERC20, functionName: 'decimals' }));
  const amt = v.parseUnits(String(AMOUNT), dec);
  const bal = await pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [me] });
  console.log('USDC decimals ' + dec + '; wallet ' + me.slice(0, 8) + '… holds ' + v.formatUnits(bal, dec) + ' USDC; deposit ' + AMOUNT);
  if (bal < amt + v.parseUnits('0.03', dec)) { console.error('not enough USDC for the deposit plus gas: refusing'); process.exit(3); }
  const preview = await pub.readContract({ address: VAULT, abi: VA, functionName: 'previewDeposit', args: [amt] });
  console.log('previewDeposit -> ' + preview + ' shares');
  const req = { source: SENDER, chain: 'arc', chainId: 5042, from: me, to: VAULT, usdc: AMOUNT, purpose: 'Morpho V2 deposit/redeem round trip before /arc/earn/ offers deposits' };
  if (!LIVE) { console.log('check only; gate:', JSON.stringify(require('/root/apex-faucet/lib/arc-send-gate.js').reasons(JSON.parse(fs.readFileSync('/etc/apex/send-gate.json', 'utf8')), req, 0))); return; }
  H.mustAllow(req);
  const out = { at: new Date().toISOString(), vault: VAULT, wallet: me, amount: AMOUNT };
  const wait = (h) => pub.waitForTransactionReceipt({ hash: h, timeout: 90000 });
  try {
    // 1. approve exactly the amount on USDC's ERC-20 face
    const ap = await wal.writeContract({ address: asset, abi: ERC20, functionName: 'approve', args: [VAULT, amt] });
    out.approve = ap; console.log('approve ' + ap + ' ' + (await wait(ap)).status);
    // 2. deposit, simulated first now that the allowance exists
    await pub.simulateContract({ address: VAULT, abi: VA, functionName: 'deposit', args: [amt, me], account: acct });
    const dp = await wal.writeContract({ address: VAULT, abi: VA, functionName: 'deposit', args: [amt, me] });
    out.deposit = dp; const drc = await wait(dp); console.log('deposit ' + dp + ' ' + drc.status);
    await H.record(dp, { source: SENDER, chain: 'arc', wallets: [me], expect: { usdc: AMOUNT }, category: 'internal:vault-deposit' });
  } catch (e) { H.release(req, 'failed before or during deposit: ' + (e.shortMessage || e.message)); console.error('FAILED: ' + (e.shortMessage || e.message)); out.error = String(e.shortMessage || e.message); fs.appendFileSync('/root/apex-faucet/data/arc-earn-test.ndjson', JSON.stringify(out) + '\n'); process.exit(1); }
  const shares = await pub.readContract({ address: VAULT, abi: VA, functionName: 'balanceOf', args: [me] });
  const worth = await pub.readContract({ address: VAULT, abi: VA, functionName: 'convertToAssets', args: [shares] });
  const maxW = await pub.readContract({ address: VAULT, abi: VA, functionName: 'maxWithdraw', args: [me] });
  const prevR = await pub.readContract({ address: VAULT, abi: VA, functionName: 'previewRedeem', args: [shares] });
  out.shares = String(shares); out.worth = v.formatUnits(worth, dec); out.maxWithdraw = String(maxW); out.previewRedeem = v.formatUnits(prevR, dec);
  console.log('shares ' + shares + ' worth ' + out.worth + ' USDC; maxWithdraw ' + maxW + ' (Vault V2 may report 0); previewRedeem ' + out.previewRedeem);
  // 3. redeem every share back to us
  try {
    await pub.simulateContract({ address: VAULT, abi: VA, functionName: 'redeem', args: [shares, me, me], account: acct });
    const rd = await wal.writeContract({ address: VAULT, abi: VA, functionName: 'redeem', args: [shares, me, me] });
    out.redeem = rd; console.log('redeem ' + rd + ' ' + (await wait(rd)).status);
    // redeem burns our vault shares (a token Transfer out of our wallet) and returns USDC: declare the shares, nothing else.
    await H.record(rd, { source: SENDER, chain: 'arc', wallets: [me], expect: { usdc: 0, tokens: { [VAULT]: Number(v.formatUnits(shares, 18)) * 1.000001 } }, category: 'internal:vault-withdraw' });
  } catch (e) { console.error('REDEEM FAILED: ' + (e.shortMessage || e.message)); out.redeemError = String(e.shortMessage || e.message); }
  const after = await pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [me] });
  out.usdcBefore = v.formatUnits(bal, dec); out.usdcAfter = v.formatUnits(after, dec);
  console.log('USDC before ' + out.usdcBefore + ', after ' + out.usdcAfter + ' (difference = gas + rounding)');
  fs.appendFileSync('/root/apex-faucet/data/arc-earn-test.ndjson', JSON.stringify(out) + '\n');
})().catch((e) => { console.error('failed: ' + (e.shortMessage || e.message)); process.exit(1); });
