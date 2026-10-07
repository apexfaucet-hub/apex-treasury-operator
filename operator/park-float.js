'use strict';
// Park idle USDC in an Arc lending vault through Circle Earn Kit, inside vault-guard.js's limits, or take it out.
//
//   PARK_KEY=<key file> node park-float.js park <vault> <usdc>    decide, quote, and (with --live) deposit
//   PARK_KEY=<key file> node park-float.js check <vault>          exit rule: withdraw what we can if the vault stopped being safe
//   PARK_KEY=<key file> node park-float.js withdraw <vault> <usdc|all>
//   --live   actually send (otherwise a DRY run: the send gate refuses every broadcast and prints what would have gone)
//   --probe  park even when it cannot pay for its gas (a deliberate test of the path; recorded as a probe)
//
// PARK_KEY: a JSON file {address, privateKey}; no default, and never printed. PARK_LOG: decision log (default
// ./data/earn-park.ndjson). PARK_LEDGER: where each sent outflow is recorded for the accountant (required with --live).
// ACCOUNT_SUMMARY: the accounting layer's summary; --live refuses unless its latest cycle is complete, not expired, and has no
// open Arc/Base alert (7 Oct 2026: replaces "6 clean cycles in a row", a goal the owner dropped on 6 Oct), so a new outflow
// never lands while the books are unsure.
// SEND_GATE_LIB: the central send gate (lib/arc-send-gate.js on our server: wallets, destinations, per-tx and per-day caps,
// sender "arc-treasury-park"); --live refuses without it. It sits in front of this file's own transaction-shape gate.
// Every live result is re-read on chain (receipts, our USDC, our shares, the standing allowance) before it is written
// down; the SDK's word is not the record. A leftover allowance with no deposit behind it is revoked at the end.
const fs = require('fs');
const path = require('path');
const G = require('./vault-guard.js');
const V = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { EarnKit } = require('@circle-fin/earn-kit');
const { createViemAdapterFromPrivateKey } = require('@circle-fin/adapter-viem-v2');

const KEY = process.env.PARK_KEY;
const LOG = process.env.PARK_LOG || path.join(__dirname, '..', 'data', 'earn-park.ndjson');
const LEDGER = process.env.PARK_LEDGER || null;
const RPC = 'https://rpc.mainnet.arc.io';
const LIVE = process.argv.includes('--live');
const PROBE = process.argv.includes('--probe');
const [mode, vaultArg, amtArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const arc = V.defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = V.createPublicClient({ chain: arc, transport: V.http(RPC, { timeout: 20000 }) });
const ALLOW = V.parseAbi(['function allowance(address owner, address spender) view returns (uint256)', 'function approve(address spender, uint256 amount) returns (bool)']);
const VAULT = V.parseAbi(['function balanceOf(address) view returns (uint256)', 'function convertToAssets(uint256) view returns (uint256)']);
const big = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
const trail = [];
const log = (o) => { trail.push(o); console.log(JSON.stringify(o, big)); };
const record = (o) => {
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString(), live: LIVE, probe: PROBE }, o), big);
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + '\n'); } catch (e) { console.log('RECORD NOT WRITTEN: ' + e.message); }
  console.log(line);
};

async function position(vault, who) {
  const [usdcWei, shares] = await Promise.all([pub.getBalance({ address: who }), pub.readContract({ address: vault, abi: VAULT, functionName: 'balanceOf', args: [who] })]);
  const assets = shares > 0n ? await pub.readContract({ address: vault, abi: VAULT, functionName: 'convertToAssets', args: [shares] }) : 0n;
  return { walletUsd: Number(V.formatUnits(usdcWei, 18)), shares, heldUsd: Number(V.formatUnits(assets, 6)) };
}
const allowance = (token, me) => pub.readContract({ address: token, abi: ALLOW, functionName: 'allowance', args: [me, G.EARN_ADAPTER] });

async function main() {
  if (!['park', 'check', 'withdraw'].includes(mode) || !/^0x[0-9a-fA-F]{40}$/.test(vaultArg || '')) { console.log('usage: PARK_KEY=<file> node park-float.js park|check|withdraw <vault> [usdc|all] [--live] [--probe]'); process.exit(64); }
  if (!KEY) { console.log('PARK_KEY is required (a JSON key file; it is never printed)'); process.exit(64); }
  const vault = V.getAddress(vaultArg);
  const k = JSON.parse(fs.readFileSync(KEY, 'utf8'));
  const account = privateKeyToAccount(k.privateKey);
  if (V.getAddress(account.address) !== V.getAddress(k.address)) throw new Error('key file address mismatch');
  const me = account.address;

  if (LIVE) {
    if (!LEDGER) { console.log('--live needs PARK_LEDGER: every outflow is recorded for the accountant'); process.exit(64); }
    // the books must be sure: latest cycle complete, summary not expired, no open Arc/Base alert; anything unreadable counts as unsure
    let booksOk = false, why = 'ACCOUNT_SUMMARY unreadable';
    try {
      const sm = JSON.parse(fs.readFileSync(process.env.ACCOUNT_SUMMARY || '', 'utf8'));
      const open = ((sm.alerts && sm.alerts.items) || []).filter((a) => a.chain === 'arc' || a.chain === 'base');
      if (sm.complete !== true) why = 'the latest books cycle is incomplete';
      else if (!(Date.parse(sm.expires_at) > Date.now())) why = 'the books summary has expired';
      else if (open.length) why = open.length + ' open Arc/Base alert(s) in the books';
      else booksOk = true;
    } catch (_) {}
    if (!booksOk) { record({ mode, vault, refused: ['books not sure: ' + why + ' (no new outflow until they are)'] }); process.exit(2); }
    if (!process.env.SEND_GATE_LIB) { record({ mode, vault, refused: ['SEND_GATE_LIB not set: a live send needs the central send gate'] }); process.exit(2); }
    const [pending, latest] = await Promise.all([pub.getTransactionCount({ address: me, blockTag: 'pending' }), pub.getTransactionCount({ address: me, blockTag: 'latest' })]);
    if (pending !== latest) { record({ mode, vault, refused: ['this wallet has a pending transaction (another sender is active): try again later'] }); process.exit(2); }
  }

  const before = await position(vault, me);
  console.log('wallet', me, 'USDC', before.walletUsd.toFixed(6), '| in vault', before.heldUsd.toFixed(6), '| mode', mode, LIVE ? 'LIVE' : 'DRY');

  let amountUsd;
  const plan = { vault, me, dry: !LIVE, ledgerFile: LEDGER, maxApproveUnits: 0n, maxShareApprove: null, maxFeeUnits: 0n };
  if (mode === 'park') {
    amountUsd = Number(amtArg);
    const d = await G.decidePark({ vault, amountUsd, heldUsd: before.heldUsd, walletUsd: before.walletUsd });
    console.log('guard', d.ok ? 'ALLOWS' : 'REFUSES', d.refusals.join(' | '), '| on chain withdrawable now', d.chain && d.chain.withdrawableNow, '(' + (d.chain && d.chain.withdrawableNowPct) + '%)');
    if (!d.ok) { record({ mode, vault, amountUsd, refused: d.refusals, withdrawableNow: d.chain && d.chain.withdrawableNow, withdrawableNowPct: d.chain && d.chain.withdrawableNowPct }); process.exit(2); }
  } else {
    const d = await G.decideExit({ vault, heldUsd: before.heldUsd });
    console.log('exit rule', d.exit ? 'EXIT: ' + d.why : 'stay', '| withdrawable now', d.withdrawableNow, d.fallback ? '(' + d.fallback + ')' : '');
    if (before.shares === 0n) { console.log('nothing held'); return; }
    if (mode === 'check' && !d.exit) return;
    const want = mode === 'withdraw' && amtArg !== 'all' ? Number(amtArg) : before.heldUsd;
    amountUsd = Math.min(want, before.heldUsd, d.withdrawableNow || 0);
    if (!(amountUsd > 0)) { record({ mode, vault, refused: ['nothing withdrawable now'] }); process.exit(2); }
    // Earn Kit approves the shares it needs plus ONE unit (its "warm slot" residual), so the cap is shares held + 1.
    plan.maxShareApprove = before.shares + 1n;
  }
  const amount = amountUsd.toFixed(6).replace(/\.?0+$/, '');
  const units = V.parseUnits(amount, 6);
  if (mode === 'park') plan.maxApproveUnits = units + 1n;          // Earn Kit asks for the amount + 1 unit (seen 30 Sep: 300001 for 0.3)
  else plan.maxFeeUnits = (units * BigInt(G.LIMITS.MAX_FEE_PCT)) / 100n;
  [plan.usdcAllowance, plan.shareAllowance] = await Promise.all([allowance(G.USDC, me), allowance(vault, me)]);

  const adapter = createViemAdapterFromPrivateKey({
    privateKey: k.privateKey,
    getPublicClient: ({ chain }) => V.createPublicClient({ chain, transport: V.http(RPC, { timeout: 20000 }) }),
    getWalletClient: ({ chain, account: acct }) => G.gatedWalletClient({ chain, account: acct, rpcUrl: RPC, plan, log }),
  });
  const kit = new EarnKit();
  const from = { adapter, chain: 'Arc' };
  const quote = mode === 'park' ? await kit.getDepositQuote({ from, vaultAddress: vault, amount }) : await kit.getWithdrawalQuote({ from, vaultAddress: vault, amount });
  const fees = (quote.fees || []).map((f) => f.type + ' ' + f.amount + ' ' + (f.token || f.symbol || ''));
  const gasUsd = (quote.gasFees || []).reduce((t, g) => t + Number(V.formatUnits(BigInt((g.fees && g.fees.fee) || 0), 18)), 0);
  console.log('quote: fees', fees.join(', ') || 'none', '| gas ~' + gasUsd.toFixed(6), 'USDC | apy', quote.currentApy);
  if (fees.some((f) => f.startsWith('circle ') && Number(f.split(' ')[1]) > (G.LIMITS.MAX_FEE_PCT / 100) * amountUsd)) { record({ mode, vault, amountUsd, refused: ['Circle fee above ' + G.LIMITS.MAX_FEE_PCT + '% of the amount: ' + fees.join(', ')] }); process.exit(2); }
  if (mode === 'park') {
    if (before.walletUsd - amountUsd - gasUsd < G.LIMITS.RESERVE_USD) { record({ mode, vault, amountUsd, refused: ['wallet would fall under the ' + G.LIMITS.RESERVE_USD + ' USDC reserve once gas (~' + gasUsd.toFixed(6) + ') is paid'] }); process.exit(2); }
    // ECONOMICS: parking must pay for itself. 30 days of yield at Earn Kit's current APY must beat twice this leg's gas
    // (in + out). APY is Earn Kit's number, so this rule can only refuse. --probe skips ONLY this rule.
    const yield30 = amountUsd * Number(quote.currentApy || 0) * 30 / 365;
    console.log('economics: 30-day yield', yield30.toFixed(8), 'USDC vs round-trip gas ~', (2 * gasUsd).toFixed(6));
    if (yield30 <= 2 * gasUsd) {
      if (!PROBE) { record({ mode, vault, amountUsd, refused: ['does not pay for itself: 30-day yield ' + yield30.toFixed(8) + ' <= round-trip gas ' + (2 * gasUsd).toFixed(6)] }); process.exit(2); }
      console.log('PROBE: parking anyway to test the path; this costs ~' + (2 * gasUsd).toFixed(6) + ' USDC and earns nothing');
    }
  }

  // Central send gate, last check before anything is signed: wallet, destination (Circle's Earn adapter) and the day's caps.
  let gateReq = null;
  if (LIVE) {
    gateReq = { source: 'arc-treasury-park', chain: 'arc', chainId: 5042, from: me, to: G.EARN_ADAPTER, usdc: mode === 'park' ? amountUsd : 0, purpose: mode + ' ' + vault };
    let gd; try { gd = require(process.env.SEND_GATE_LIB).check(gateReq); } catch (e) { gd = { allow: false, reasons: ['send gate error: ' + e.message] }; }
    if (!gd || !gd.allow) { record({ mode, vault, amountUsd, refused: ['central send gate: ' + ((gd && gd.reasons) || []).join('; ')] }); process.exit(2); }
  }
  let result = null, err = null;
  try { result = mode === 'park' ? await kit.deposit({ from, vaultAddress: vault, amount, config: { batchTransactions: false } }) : await kit.withdraw({ from, vaultAddress: vault, amount, config: { batchTransactions: false } }); }
  catch (e) { err = String(e.message).slice(0, 300); }
  if (err && gateReq && !trail.some((t) => t.gate === 'SENT')) { try { require(process.env.SEND_GATE_LIB).release(gateReq, 'nothing broadcast: ' + err.slice(0, 120)); } catch (_) {} }

  // Re-read everything from the chain. A standing USDC allowance with no deposit behind it is revoked (the adapter is an
  // upgradeable proxy, so an unused allowance is exposure); the SDK's 1-unit residual is left, it is its design.
  const sent = trail.filter((t) => t.gate === 'SENT').map((t) => t.hash);
  const receipts = [];
  for (const h of sent) { try { const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 60000 }); receipts.push({ hash: h, status: r.status, gasUsdc: V.formatUnits(r.gasUsed * r.effectiveGasPrice, 18) }); } catch (e) { receipts.push({ hash: h, error: e.shortMessage || e.message }); } }
  const after = await position(vault, me);
  const standing = await allowance(G.USDC, me);
  let revoked = null;
  if (LIVE && mode === 'park' && standing > 1n && !(after.shares > before.shares)) {
    try {
      const wal = G.gatedWalletClient({ chain: arc, account, rpcUrl: RPC, plan, log });
      const h = await wal.writeContract({ address: G.USDC, abi: ALLOW, functionName: 'approve', args: [G.EARN_ADAPTER, 0n] });
      const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 60000 });
      revoked = { hash: h, status: r.status };
    } catch (e) { revoked = { error: e.shortMessage || e.message }; }
  }
  record({ mode, vault, wallet: me, amountUsd, fees, gasQuotedUsdc: gasUsd, gate: trail, error: err, sdkTxHash: result && result.txHash, receipts, revoked,
    usdcBefore: before.walletUsd, usdcAfter: after.walletUsd, usdcDelta: +(after.walletUsd - before.walletUsd).toFixed(6),
    heldBefore: before.heldUsd, heldAfter: after.heldUsd, heldDelta: +(after.heldUsd - before.heldUsd).toFixed(6), usdcAllowanceAfter: standing });
}
main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
