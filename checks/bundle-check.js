'use strict';
// ARC BUNDLE CHECK (2026-09-30). "Was this launch bundled?" A bundle is the launcher buying its own token at launch
// through several wallets, so the chart looks like demand while one party holds the supply and can dump it. Fuci's
// trading autopilots refuse "bundled launches" (fuci.family/llms.txt); nothing on Arc sells the check itself.
//
// METHOD, read from the chain only (Uniswap v4 PoolManager on Arc):
//   1. The launcher is the wallet that sent the transaction which INITIALISED the pool.
//   2. Early buys: Swap events for the pool in the first WINDOW_BLOCKS blocks (~2 minutes at ~0.5 s a block). A Swap's
//      `sender` is a router, so the buyer is the transaction's `from`. A buy is a swap in which the USDC side is negative
//      (the swapper paid USDC; v4 reports amounts from the caller's side).
//   3. Funding: every native USDC transfer on Arc emits a Transfer log from the system address 0xff..fe. For each early
//      buyer we read those logs INTO the buyer during FUNDING_LOOKBACK blocks (~3 hours) before its first buy.
//   4. Verdict: BUNDLED when 2+ early buying wallets are linked (the launcher plus wallets it funded, or wallets funded by one
//      shared PLAIN wallet; contracts paying sale proceeds are not funding). DEV BUY when only the launcher itself bought. SUSPECT when 3+ different wallets bought in the launch block itself and most of them
//      were brand new (nonce <= 2). Otherwise NO BUNDLE SEEN.
// LIMITS, stated in every answer: funding older than the lookback, or routed through an exchange or a bridge, is not seen;
// a launcher can buy from wallets it never funded directly. "No bundle seen" is a measurement, not a clean bill of health.
const { pub, PM, EV } = require('/home/claudeuser/core/arc/scanlib.js');
const { isUsdc } = require('/home/claudeuser/core/arc/exit-probe.js');
const { parseAbiItem } = require('/root/apex-faucet/node_modules/viem');

const WINDOW_BLOCKS = 240n;          // ~2 minutes
const FUNDING_LOOKBACK = 21600n;     // ~3 hours
const MAX_SWAPS = 60;
const MAX_BUYERS = 12;
const NATIVE_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const SUPPLY_ABI = [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const lc = (a) => String(a || '').toLowerCase();

async function logsChunked(params, from, to, step) {
  const out = [];
  for (let a = from; a <= to; a += step) {
    const b = a + step - 1n > to ? to : a + step - 1n;
    out.push(...await pub.getLogs({ ...params, fromBlock: a, toBlock: b }));
  }
  return out;
}

// pool: { id, block, currency0, currency1 }. Returns the analysis; throws on a failed read (never a guess).
async function bundleCheck(pool) {
  const id = pool.id, created = BigInt(pool.block);
  const usdcIs0 = isUsdc(pool.currency0), usdcIs1 = isUsdc(pool.currency1);
  if (!usdcIs0 && !usdcIs1) throw new Error('not a USDC pool');
  const token = usdcIs0 ? pool.currency1 : pool.currency0;
  const head = await pub.getBlockNumber();
  const windowEnd = created + WINDOW_BLOCKS > head ? head : created + WINDOW_BLOCKS;
  const complete = created + WINDOW_BLOCKS <= head;

  // 1. launcher
  const init = await pub.getLogs({ address: PM, event: EV.init, args: { id }, fromBlock: created, toBlock: created });
  if (!init.length) throw new Error('pool initialisation not found at its block');
  const initTx = await pub.getTransaction({ hash: init[0].transactionHash });
  const launcher = lc(initTx.from);

  // 2. early swaps -> buys by transaction sender
  const swaps = (await logsChunked({ address: PM, event: EV.swap, args: { id } }, created, windowEnd, 2000n)).slice(0, MAX_SWAPS);
  const txFrom = new Map();
  for (const s of swaps) if (!txFrom.has(s.transactionHash)) txFrom.set(s.transactionHash, null);
  await Promise.all([...txFrom.keys()].map(async (h) => { const t = await pub.getTransaction({ hash: h }); txFrom.set(h, lc(t.from)); }));
  const buys = [];
  for (const s of swaps) {
    const a0 = s.args.amount0, a1 = s.args.amount1;
    const usdcAmt = usdcIs0 ? a0 : a1, tokAmt = usdcIs0 ? a1 : a0;
    if (usdcAmt < 0n && tokAmt > 0n) buys.push({ buyer: txFrom.get(s.transactionHash), tx: s.transactionHash, block: s.blockNumber, tokens: tokAmt });
  }
  const byBuyer = new Map();
  for (const b of buys) {
    const e = byBuyer.get(b.buyer) || { buyer: b.buyer, firstBlock: b.block, firstTx: b.tx, tokens: 0n, buys: 0 };
    e.tokens += b.tokens; e.buys++; if (b.block < e.firstBlock) { e.firstBlock = b.block; e.firstTx = b.tx; }
    byBuyer.set(b.buyer, e);
  }
  const early = [...byBuyer.values()].sort((x, y) => (x.firstBlock < y.firstBlock ? -1 : x.firstBlock > y.firstBlock ? 1 : 0)).slice(0, MAX_BUYERS);

  // 3. funding and freshness of each early buyer
  const codeCache = new Map();
  await Promise.all(early.map(async (e) => {
    const from = e.firstBlock > FUNDING_LOOKBACK ? e.firstBlock - FUNDING_LOOKBACK : 0n;
    const ins = await logsChunked({ address: NATIVE_EMITTER, event: TRANSFER, args: { to: e.buyer } }, from, e.firstBlock, 10000n);
    const all = [...new Set(ins.map((l) => lc(l.args.from)))];
    // A contract paying a wallet (PoolManager and routers paying sale proceeds, launchpads, faucets, Circle Gateway) is not
    // funding by a person. Tested 30 Sep: counting them flagged sniper bots paid by a router as a 9-wallet "bundle".
    const funders = [];
    for (const f of all) { if (f === lc(PM)) continue; if (!codeCache.has(f)) codeCache.set(f, await pub.getCode({ address: f }).then((c) => !!(c && c !== '0x')).catch(() => true)); if (!codeCache.get(f)) funders.push(f); }
    e.funders = funders;
    e.fundedByLauncher = funders.includes(launcher);
    e.nonceAtLaunch = await pub.getTransactionCount({ address: e.buyer, blockNumber: created > 0n ? created - 1n : 0n });
  }));

  // 4. linking
  const byFunder = new Map();
  for (const e of early) for (const f of e.funders) { if (!byFunder.has(f)) byFunder.set(f, []); byFunder.get(f).push(e.buyer); }
  const sharedFunders = [...byFunder.entries()].filter(([f, bs]) => bs.length >= 2 && f !== lc(PM)).map(([f, bs]) => ({ funder: f, buyers: bs, isLauncher: f === launcher }));
  const launcherBought = early.some((e) => e.buyer === launcher);
  const linked = new Set();
  if (launcherBought) linked.add(launcher);
  for (const e of early) if (e.fundedByLauncher) linked.add(e.buyer);
  for (const s of sharedFunders) for (const b of s.buyers) linked.add(b);
  const block0 = early.filter((e) => e.firstBlock === created);
  const block0Fresh = block0.filter((e) => e.nonceAtLaunch <= 2);

  let supply = null; try { supply = await pub.readContract({ address: token, abi: SUPPLY_ABI, functionName: 'totalSupply' }); } catch (e) { supply = null; }
  const linkedTokens = early.filter((e) => linked.has(e.buyer)).reduce((t, e) => t + e.tokens, 0n);
  const pct = (x) => (supply && supply > 0n ? Number((x * 1000000n) / supply) / 10000 : null);

  let verdict, why;
  const launcherPct = launcherBought ? pct(early.find((e) => e.buyer === launcher).tokens) : null;
  if (linked.size >= 2) {
    verdict = 'BUNDLED';
    why = linked.size + ' early buying wallets are linked: ' + (launcherBought ? 'the launcher bought, and ' : '')
      + (sharedFunders.some((s) => s.isLauncher) || early.some((e) => e.fundedByLauncher) ? 'wallets funded by the launcher bought' : 'wallets funded by one shared wallet bought') + ' in the first two minutes';
  } else if (launcherBought) {
    verdict = 'DEV BUY'; why = 'the wallet that opened the pool bought its own token (' + (launcherPct == null ? '?' : launcherPct) + '% of supply); no other linked wallets seen';
  } else if (block0.length >= 3 && block0Fresh.length * 2 > block0.length) {
    verdict = 'SUSPECT'; why = block0.length + ' different wallets bought in the launch block itself, ' + block0Fresh.length + ' of them brand new (no funding link seen)';
  } else {
    verdict = 'NO BUNDLE SEEN'; why = early.length ? 'no early buyer is the launcher or linked to it or to each other by funding in the last ~3 hours' : 'no buys in the first two minutes';
  }
  return {
    ok: true, verdict, why, complete, pool: id, token, launcher, launchBlock: Number(created),
    window: { blocks: Number(WINDOW_BLOCKS), approxSeconds: Math.round(Number(WINDOW_BLOCKS) * 0.5), swapsRead: swaps.length, buys: buys.length, distinctEarlyBuyers: byBuyer.size },
    launchBlockBuyers: block0.length, launchBlockFreshWallets: block0Fresh.length, launcherBought, launcherSupplyPct: launcherPct,
    linkedBuyers: linked.size, linkedSupplyPct: pct(linkedTokens),
    earlyBuyers: early.map((e) => ({ buyer: e.buyer, secondsAfterLaunch: Math.round(Number(e.firstBlock - created) * 0.5), buys: e.buys, tokens: e.tokens.toString(),
      supplyPct: pct(e.tokens), linked: linked.has(e.buyer), fundedByLauncher: e.fundedByLauncher, funders: e.funders.slice(0, 5), nonceAtLaunch: e.nonceAtLaunch, firstTx: e.firstTx })),
    sharedFunders,
    method: 'Launcher = sender of the pool\'s Initialize transaction. Early buys = Swap events in the first ' + WINDOW_BLOCKS + ' blocks (~2 min) where the swapper paid USDC; buyer = transaction sender. Funding = native USDC Transfer logs (system emitter 0xff..fe) into each buyer during ~3 hours before its first buy.',
    limits: 'Funding older than ~3 hours, or through an exchange or bridge, is not seen; a launcher can buy from wallets it never funded directly. NO BUNDLE SEEN is a measurement, not a clean bill of health.' + (complete ? '' : ' The two-minute window has not finished yet: early buyers may still be missing.'),
  };
}

module.exports = { bundleCheck, WINDOW_BLOCKS, FUNDING_LOOKBACK };
