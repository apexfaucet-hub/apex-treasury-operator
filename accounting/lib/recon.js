'use strict';
// ACCOUNT LAYER P4: the pieces of reconciliation that read the chain (2026-09-29). Read-only, via lib/account/rpc.js.
// Given a wallet and a window, return every movement of value the chain shows for it, per transaction, with the other
// side of each movement, so the caller can sort each outflow into: recorded (ledger has the hash), recorded by amount
// (ledger row without a hash), ours-but-unrecorded (fee, rent, internal, trade, burn) or an unexplained external outflow.
// Nothing here guesses: a read that fails throws, and the caller marks the pair incomplete.
const rpc = require('./rpc.js');

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ARC_NATIVE_LOG = '0xfffffffffffffffffffffffffffffffffffffffe';   // EIP-7708-style log for every native USDC move, 18 decimals
const ARC_USDC_VIEW = '0x3600000000000000000000000000000000000000';    // ERC-20 VIEW of native USDC: never counted on top
const LOG_STEP = { arc: 4000n, base: 2000n };
const hex = (n) => '0x' + BigInt(n).toString(16);
const pad = (a) => '0x' + '0'.repeat(24) + String(a).slice(2).toLowerCase();
const unpad = (t) => '0x' + String(t).slice(-40).toLowerCase();

// ── EVM ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function evmBlockAtTime(chain, iso) {
  const target = Math.floor(Date.parse(iso) / 1000);
  const ts = async (n) => Number(BigInt((await rpc.call(chain, 'eth_getBlockByNumber', [hex(n), false])).result.timestamp));
  let hi = BigInt((await rpc.call(chain, 'eth_blockNumber', [])).result), lo = 1n;
  if (await ts(hi) <= target) return hi;
  while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (await ts(mid) <= target) lo = mid; else hi = mid; }
  return lo;   // last block at or before the time
}

// Every Transfer log (any contract, incl. Arc's native system log) with one of `wallets` as sender or receiver, in
// blocks (from, to]. ERC-721 transfers (4 topics) are returned separately; they carry no fungible value.
// `contracts` (Fable review v2 #4b): only Transfer logs FROM these contracts are asked for (the tokens we value, plus Arc's
// native log). Asking every contract let anyone emit junk logs naming our address and raise alarms, or flood the read
// past the endpoint's cap. A window the endpoint refuses as too large is split in half, down to 50 blocks, then throws.
async function evmMovements(chain, wallets, fromBlock, toBlock, contracts) {
  const topics = wallets.map(pad);
  const seen = new Map(), nfts = [];
  const step = LOG_STEP[chain] || 2000n;
  const addr = contracts && contracts.length ? contracts.map((c) => String(c).toLowerCase()) : undefined;
  // the contract filter goes in chunks of 20 (rpc.mainnet.arc.io refuses 45 as "requested range too large")
  const chunks = []; if (addr) for (let i = 0; i < addr.length; i += 20) chunks.push(addr.slice(i, i + 20)); else chunks.push(undefined);
  const get = async (a, b) => {
    for (const t of [[TRANSFER, topics], [TRANSFER, null, topics]]) for (const ch of chunks) {
      let result;
      try { ({ result } = await rpc.call(chain, 'eth_getLogs', [Object.assign({ fromBlock: hex(a), toBlock: hex(b), topics: t }, ch ? { address: ch } : {})])); }
      catch (e) {
        if (b - a > 50n && /range|too many|limit|exceed|10000|response size|query returned/i.test(e.message)) { const mid = (a + b) / 2n; await get(a, mid); await get(mid + 1n, b); return; }
        throw e;
      }
      if (!Array.isArray(result)) throw new Error('eth_getLogs returned no array for ' + hex(a) + '..' + hex(b));
      for (const lg of result) seen.set(lg.transactionHash + ':' + lg.logIndex, lg);
    }
  };
  for (let a = BigInt(fromBlock) + 1n; a <= BigInt(toBlock); a += step) await get(a, a + step - 1n > BigInt(toBlock) ? BigInt(toBlock) : a + step - 1n);
  const moves = [];
  for (const lg of seen.values()) {
    const addr2 = String(lg.address).toLowerCase();
    if (chain === 'arc' && addr2 === ARC_USDC_VIEW) continue;   // the view echoes the native move: count the native log only
    if ((lg.topics || []).length === 4) { nfts.push({ tx: lg.transactionHash, contract: addr2, from: unpad(lg.topics[1]), to: unpad(lg.topics[2]), id: BigInt(lg.topics[3]).toString() }); continue; }
    if ((lg.topics || []).length !== 3) continue;
    const asset = chain === 'arc' && addr2 === ARC_NATIVE_LOG ? 'arc:native' : chain + ':' + addr2;
    moves.push({ tx: lg.transactionHash, block: BigInt(lg.blockNumber), logIndex: Number(lg.logIndex), asset, from: unpad(lg.topics[1]), to: unpad(lg.topics[2]), raw: BigInt(lg.data === '0x' ? 0 : lg.data) });
  }
  moves.sort((x, y) => (x.block === y.block ? x.logIndex - y.logIndex : x.block < y.block ? -1 : 1));
  return { moves, nfts };
}

// Gas: receipts of every transaction in the movement set; the sender pays gasUsed x effectiveGasPrice (+ Base's l1Fee).
async function evmReceipts(chain, txs) {
  const out = new Map();
  for (const h of txs) {
    const { result } = await rpc.call(chain, 'eth_getTransactionReceipt', [h]);
    if (!result) throw new Error('no receipt for ' + h);
    const gas = BigInt(result.gasUsed) * BigInt(result.effectiveGasPrice || '0x0') + BigInt(result.l1Fee || '0x0');
    out.set(h, { from: String(result.from).toLowerCase(), gas, status: result.status, block: BigInt(result.blockNumber),
      logs: (result.logs || []).map((l) => ({ address: String(l.address).toLowerCase(), topics: l.topics || [], data: l.data || '0x' })) });
  }
  return out;
}
// Transactions a wallet SENT that moved no token (approvals, contract calls, failed calls) emit no Transfer log. Find each
// one exactly: bisect the nonce to the block where it was used, then read that block. `known` = [{ nonce, block }] of the
// sent transactions already found through logs, which narrow each search to the gap between neighbours.
async function evmFindSent(chain, address, fromBlock, toBlock, nonceFrom, nonceTo, known, cap) {
  const a = address.toLowerCase();
  const have = new Set(known.map((k) => k.nonce));
  const missing = [];
  for (let n = nonceFrom; n < nonceTo; n++) if (!have.has(n)) missing.push(n);
  if (missing.length > (cap || 60)) throw new Error(missing.length + ' sent transactions without a Transfer log: more than the ' + (cap || 60) + ' this reader bisects');
  const found = [];
  const sorted = known.slice().sort((x, y) => x.nonce - y.nonce);
  for (const n of missing) {
    let lo = BigInt(fromBlock), hi = BigInt(toBlock);   // nonce(lo) <= n < nonce(hi)
    for (const k of sorted) { if (k.nonce < n && k.block > lo) lo = k.block; if (k.nonce > n && k.block < hi) hi = k.block; }
    if (lo > BigInt(fromBlock)) lo -= 1n;                // the neighbour's own block may also hold nonce n
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (await evmNonce(chain, address, mid) > n) hi = mid; else lo = mid; }
    const { result } = await rpc.call(chain, 'eth_getBlockByNumber', [hex(hi), true]);
    const t = (result && result.transactions || []).find((x) => String(x.from).toLowerCase() === a && Number(BigInt(x.nonce)) === n);
    if (!t) throw new Error('nonce ' + n + ' of ' + address + ' not found in block ' + hi);
    found.push({ hash: t.hash, nonce: n, block: hi });
  }
  return found;
}
async function evmTxNonce(chain, hash) {
  const { result } = await rpc.call(chain, 'eth_getTransactionByHash', [hash]);
  if (!result) throw new Error('no transaction ' + hash);
  return { nonce: Number(BigInt(result.nonce)), block: BigInt(result.blockNumber), from: String(result.from).toLowerCase() };
}
// Owner program of an account (null if it no longer exists), to tell a program account (rent) from a wallet (a payment).
async function svmOwner(chain, address) {
  const { result } = await rpc.call(chain, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]);
  return result && result.value ? result.value.owner : null;
}
async function evmNonce(chain, address, block) {
  return BigInt((await rpc.call(chain, 'eth_getTransactionCount', [address, hex(block)])).result);
}

// ── SVM ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Signatures touching `address` with fromSlot < slot <= toSlot (finalized). Throws past maxPages rather than truncating.
async function svmSignatures(chain, address, fromSlot, toSlot, maxPages) {
  const out = []; let before = null;
  for (let page = 0; page < (maxPages || 30); page++) {
    const { result } = await rpc.call(chain, 'getSignaturesForAddress', [address, Object.assign({ limit: 1000, commitment: 'finalized' }, before ? { before } : {})]);
    if (!Array.isArray(result)) throw new Error('getSignaturesForAddress returned no array');
    for (const s of result) if (s.slot > fromSlot && s.slot <= toSlot) out.push(s);
    if (!result.length || result.length < 1000 || result[result.length - 1].slot <= fromSlot) return out;
    before = result[result.length - 1].signature;
  }
  throw new Error('more than ' + (maxPages || 30) + ' pages of signatures for ' + address + ': window too long for a full read');
}

async function svmTx(chain, sig) {
  const { result } = await rpc.call(chain, 'getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'finalized' }]);
  if (!result || !result.meta) throw new Error('no transaction/meta for ' + sig);
  return result;
}

// What one transaction did to `address` (an owner wallet, or a token account when asTokenAccount), per asset, plus the
// other side of each movement. Raw BigInt units.
function svmEffects(chain, tx, address, asTokenAccount) {
  const m = tx.transaction.message, meta = tx.meta;
  const keys = (m.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey))
    .concat((meta.loadedAddresses && meta.loadedAddresses.writable) || [], (meta.loadedAddresses && meta.loadedAddresses.readonly) || []);
  const fee = BigInt(meta.fee || 0), feePayer = keys[0];
  const pre = meta.preTokenBalances || [], post = meta.postTokenBalances || [];
  const tokenAcctIdx = new Set(pre.concat(post).map((b) => b.accountIndex));
  // per (holder, mint) raw delta; holder = owner wallet (or the token account itself when asked)
  const tok = new Map();
  const add = (holder, mint, v) => { const k = holder + '|' + mint; tok.set(k, (tok.get(k) || 0n) + v); };
  for (const b of pre) add(asTokenAccount && keys[b.accountIndex] === address ? address : b.owner, b.mint, -BigInt(b.uiTokenAmount.amount));
  for (const b of post) add(asTokenAccount && keys[b.accountIndex] === address ? address : b.owner, b.mint, BigInt(b.uiTokenAmount.amount));
  const effects = [];
  if (!asTokenAccount) {
    let nd = 0n; const gainers = [];
    keys.forEach((k, i) => {
      const d = BigInt(meta.postBalances[i] || 0) - BigInt(meta.preBalances[i] || 0);
      if (k === address) nd += d;
      else if (d > 0n) gainers.push({ account: k, raw: d, newAccount: BigInt(meta.preBalances[i] || 0) === 0n, tokenAccount: tokenAcctIdx.has(i),
        tokenOwner: (post.find((b) => b.accountIndex === i) || pre.find((b) => b.accountIndex === i) || {}).owner || null });
    });
    if (nd !== 0n || feePayer === address) effects.push({ asset: chain + ':native', raw: nd, feePaid: feePayer === address ? fee : 0n, gainers });
  }
  const mints = new Set([...tok.keys()].map((k) => k.split('|')[1]));
  for (const mint of mints) {
    const mine = tok.get(address + '|' + mint) || 0n;
    if (mine === 0n) continue;
    const others = [...tok.entries()].filter(([k]) => k.endsWith('|' + mint) && !k.startsWith(address + '|')).map(([k, v]) => ({ holder: k.split('|')[0], raw: v }));
    const supplyDelta = [...tok.entries()].filter(([k]) => k.endsWith('|' + mint)).reduce((t, [, v]) => t + v, 0n);
    effects.push({ asset: chain + ':' + mint, raw: mine, gainers: others.filter((o) => o.raw > 0n), losers: others.filter((o) => o.raw < 0n), supplyDelta });
  }
  // programs invoked, top level and inner (a DEX swap may be reached through a router)
  const programs = new Set();
  for (const ix of (m.instructions || [])) if (keys[ix.programIdIndex]) programs.add(keys[ix.programIdIndex]);
  for (const inner of (meta.innerInstructions || [])) for (const ix of (inner.instructions || [])) if (keys[ix.programIdIndex]) programs.add(keys[ix.programIdIndex]);
  return { sig: tx.transaction.signatures[0], slot: tx.slot, blockTime: tx.blockTime, err: meta.err, fee, feePayer, effects, programs: [...programs] };
}

// Same, bounded by TIME at the old end (for a reading that recorded a time but no slot): blockTime >= sinceSec, slot <= toSlot.
async function svmSignaturesSince(chain, address, sinceSec, toSlot, maxPages) {
  const out = []; let before = null;
  for (let page = 0; page < (maxPages || 30); page++) {
    const { result } = await rpc.call(chain, 'getSignaturesForAddress', [address, Object.assign({ limit: 1000, commitment: 'finalized' }, before ? { before } : {})]);
    if (!Array.isArray(result)) throw new Error('getSignaturesForAddress returned no array');
    for (const s of result) if (s.slot <= toSlot && s.blockTime != null && s.blockTime >= sinceSec) out.push(s);
    const last = result[result.length - 1];
    if (!result.length || result.length < 1000 || (last.blockTime != null && last.blockTime < sinceSec)) return out;
    before = last.signature;
  }
  throw new Error('more than ' + (maxPages || 30) + ' pages of signatures for ' + address);
}

// Every transaction that touched a wallet (or a token account) in (fromSlot, toSlot], with its effects on it. For an owner
// wallet the associated token accounts of `mints` are asked as well: an INCOMING token transfer lists only the token
// account, never the owner, so asking the owner alone would miss it.
// Pass { sinceSec } as fromSlot to bound by time instead of slot.
async function svmWalletEffects(chain, address, kind, mints, fromSlot, toSlot) {
  const list = (a) => (fromSlot && typeof fromSlot === 'object' ? svmSignaturesSince(chain, a, fromSlot.sinceSec, toSlot) : svmSignatures(chain, a, fromSlot, toSlot));
  const sigs = await list(address);
  if (kind !== 'token-account' && mints && mints.length) {
    const PK = require('/root/apex-faucet/node_modules/@solana/web3.js').PublicKey;
    const { getAssociatedTokenAddressSync } = require('/root/apex-faucet/node_modules/@solana/spl-token');
    for (const mint of mints) for (const prog of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
      const ata = getAssociatedTokenAddressSync(new PK(mint), new PK(address), true, new PK(prog)).toBase58();
      for (const x of await list(ata)) if (!sigs.some((y) => y.signature === x.signature)) sigs.push(x);
    }
  }
  const out = [];
  for (const x of sigs) out.push(svmEffects(chain, await svmTx(chain, x.signature), address, kind === 'token-account'));
  return out;
}

module.exports = { evmFindSent, evmTxNonce, svmOwner, svmWalletEffects, svmSignaturesSince, TRANSFER, ARC_NATIVE_LOG, ARC_USDC_VIEW, hex, pad, unpad, evmBlockAtTime, evmMovements, evmReceipts, evmNonce, svmSignatures, svmTx, svmEffects };
