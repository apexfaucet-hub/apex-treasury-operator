'use strict';
// BUY AND RATE (2026-09-30). The operator's purchase workflow, and honest ERC-8004 reputation from real use:
//   revenue in -> budget -> buy one real call from another Arc agent over x402 -> prove OUR settlement on chain ->
//   grade the delivery -> write giveFeedback backed by a receipt anyone can check -> record every outflow.
// Reviewed by Fable 30 Sep (audits/fable-review-buy-and-rate-2026-09-30.md): 7 must-fixes and the should-fixes are in.
//
// Rules (CLAUDE.md §1, §9):
//   - No proven settlement, no feedback. Proof = in the settlement receipt, an AuthorizationUsed(me, nonce) log for
//     the EXACT authorization we signed this run, and a Transfer me -> payTo of exactly that value, on USDC 0x3600.
//   - Grade DELIVERY, not taste: proven settlement + HTTP 200 + a non-empty body -> 100; proven settlement + a server
//     error or an empty 200 -> 0. A 4xx after payment may be OUR request's fault, and a timeout or a response without
//     a provable settlement cannot be graded: none of those is rated.
//   - One resource is one rating, for the ONE agent that resource is tied to (its own registration declares it, or a
//     catalogue whose payTo is that agent's on-chain owner). A resource several agents declare is skipped.
//     At most MAX_PER_OWNER agents of one owner per run.
//   - Never about ourselves, never twice for the same agent within 30 days (a signed authorization counts as bought).
//   - The receipt names the resource, price, settlement and what came back (status, bytes, type, sha256), NEVER the
//     seller's data itself; it discloses relations (they buy from us; #211 sells on Arc too).
//   - Budget: at most the outside Arc revenue of the last 7 days minus what this job spent in those 7 days, capped per
//     run; purchases and feedback gas both count.
//   - Wallet: the Watchtower's (#211), shared with watch-feedback.js through one lock file; never near 08:40 UTC, never
//     while that wallet has a pending transaction (both re-checked before every send).
//   - Every authorization handed out is recorded, proven or not, and a sweep at the end books any late settlement.
//   - DRY by default: the paid retry is intercepted and never sent; nothing is signed on chain.
//
//   node buy-and-rate.js [--live] [--only <agentId>] [--max N]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const V = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } = require('@x402/fetch');
const { ExactEvmScheme } = require('@x402/evm');

const LIVE = process.argv.includes('--live');
const argv = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ONLY = argv('--only') ? Number(argv('--only')) : null;
const MAX = Number(argv('--max') || 20);

// Published copy: every location is a setting. KEY is a JSON file {address, privateKey}, never printed.
const ENV = (k, d) => process.env[k] || d;
const KEY = process.env.RATER_KEY;
const KEYDIR = ENV('OUR_KEYS_DIR', '');                                   // our own key files: their addresses are never targets
const WATCH = ENV('WATCH_FILE', './data/arc-agent-watch.json');           // the Watchtower's hourly measurements
const SETTLEMENTS = ENV('SETTLEMENTS_FILE', './data/settlements.ndjson'); // our revenue ledger (the budget)
const EVID = ENV('EVIDENCE_DIR', './data/evidence');                      // served byte for byte at EVIDENCE_URL/<id>/<file>
const EVIDENCE_URL = ENV('EVIDENCE_URL', 'https://apexfaucet.xyz/arc/agents');
const LOG = ENV('RATE_LOG', './data/buy-and-rate.ndjson');
const LEDGER = ENV('LEDGER_FILE', './data/ledger/buy-and-rate.ndjson');
const LOCK = ENV('WALLET_LOCK', './data/.rater-wallet.lock');            // shared with any other writer of the same key
const REPUTATION = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const USDC = '0x3600000000000000000000000000000000000000';
const RPC = 'https://rpc.mainnet.arc.io';
const MAX_PER_CALL_UNITS = 10000n;            // $0.01
const RUN_CAP_USD = 0.20;
const RESERVE_USD = 0.10;                     // left in the Watchtower wallet for its own weekly uptime writes
const TIMEOUT_MS = 30000;
const AGAIN_DAYS = 30;
const MAX_PER_OWNER = 3;
const MAX_AUTH_SECONDS = 300;
// Resources that need a query to be a real request (read from their 402/OpenAPI). Argos: look up our own APEX token.
const REQUEST_OVERRIDE = { 304: 'https://arcus-api.argosbot.io/v1/lookup?token=0x59933f316417c89d9dc5107b30f08c99b774ea9d&chain=arc' };
const CATALOGUE_PICK = { 'https://www.fuci.family/.well-known/x402': { url: 'https://www.fuci.family/api/x402/kya?agent=1', relation: 'Fuci-hosted agents also buy from us (one of them buys our Arc launch feed)' } };

const lc = (a) => String(a || '').toLowerCase();
const arc = V.defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = V.createPublicClient({ chain: arc, transport: V.fallback([RPC, 'https://rpc.beamrpc.com'].map((u) => V.http(u, { timeout: 20000 }))) });
const REP = V.parseAbi(['function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)']);
const ID = V.parseAbi(['function ownerOf(uint256) view returns (address)']);
const TRANSFER = V.parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const AUTH_USED = V.parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)');
const readLines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
const append = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n'); };
const say = (...a) => console.log(...a);
class Stop extends Error {}

// Every EVM address we hold a key for: never a target.
function ourAddresses() {
  const s = new Set();
  if (!KEYDIR) return s;
  try { for (const f of fs.readdirSync(KEYDIR)) { try { const k = JSON.parse(fs.readFileSync(path.join(KEYDIR, f), 'utf8')); if (/^0x[0-9a-fA-F]{40}$/.test(k.address || '')) s.add(lc(k.address)); } catch (_) {} } } catch (_) {}
  return s;
}
function budget() {
  const since = Date.now() - 7 * 86400e3;
  const revenue = readLines(SETTLEMENTS).filter((r) => !r.ours && (r.chain === 'arc' || r.chain === 'eip155:5042') && Date.parse(r.at) >= since).reduce((t, r) => t + (Number(r.amount) || 0), 0);
  const spent = readLines(LOG).filter((r) => r.live && Date.parse(r.at) >= since).reduce((t, r) => t + (Number(r.costUsdc) || 0), 0);
  return { revenue7d: +revenue.toFixed(6), spent7d: +spent.toFixed(6), available: +Math.max(0, Math.min(RUN_CAP_USD, revenue - spent)).toFixed(6) };
}
function nearWatchFeedback() {
  const now = new Date(), mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (Math.abs(mins - (8 * 60 + 40)) <= 15) return 'within 15 minutes of watch-feedback (08:40 UTC)';
  try { if (cp.execFileSync('systemctl', ['is-active', 'apex-arc-watch-feedback.service'], { encoding: 'utf8' }).trim() === 'active') return 'watch-feedback is running'; } catch (_) {}
  return null;
}
async function pendingFree(me) {
  const [pending, latest] = await Promise.all([pub.getTransactionCount({ address: me, blockTag: 'pending' }), pub.getTransactionCount({ address: me, blockTag: 'latest' })]);
  return pending === latest;
}

// Targets: one resource per agent, from what the Watchtower measured and each agent's own declarations.
async function targets(ours) {
  const w = JSON.parse(fs.readFileSync(WATCH, 'utf8'));
  // bought = rated, or an authorization handed out that is not known to have expired unused (the sweep records those)
  const logRows = readLines(LOG);
  const expired = new Set(logRows.filter((r) => r.authExpiredUnused).map((r) => lc(r.authExpiredUnused)));
  const recent = new Set(logRows.filter((r) => r.live && (r.feedbackTx || (r.signed && !(r.authorization && expired.has(lc(r.authorization.nonce))))) && Date.now() - Date.parse(r.at) < AGAIN_DAYS * 86400e3).map((r) => r.agentId));
  const cands = [];
  for (const a of w.agents) {
    if (a.ours || a.id === 211 || ours.has(lc(a.owner)) || recent.has(a.id)) continue;
    if (ONLY != null && a.id !== ONLY) continue;
    for (const e of a.endpoints || []) {
      if (e.kind !== 'x402') continue;
      const x = (e.last && e.last.x402) || {};
      const opt = (x.options || []).find((o) => o.scheme === 'exact' && o.network === 'eip155:5042' && lc(o.asset) === USDC);
      if (!opt || ours.has(lc(opt.payTo))) continue;
      if (opt.where === 'catalogue') {
        const pick = CATALOGUE_PICK[e.url];
        if (!pick) continue;
        cands.push({ agentId: a.id, name: a.name, owner: lc(a.owner), url: pick.url, declared: pick.url, payTo: lc(opt.payTo), relation: pick.relation, via: 'catalogue ' + e.url });
      } else if (e.last && e.last.status === 402) {
        cands.push({ agentId: a.id, name: a.name, owner: lc(a.owner), url: REQUEST_OVERRIDE[a.id] || e.url, declared: e.url, payTo: lc(opt.payTo), priceUnits: BigInt(opt.atomic || 0), relation: null, via: 'own registration' });
      }
    }
  }
  const byUrl = new Map();
  for (const c of cands) byUrl.set(c.url, (byUrl.get(c.url) || []).concat(c));
  const out = [];
  for (const [url, cs] of byUrl) {
    if (cs[0].via.startsWith('catalogue')) {
      const owners = [];
      for (const c of cs) { let o = null; try { o = lc(await pub.readContract({ address: IDENTITY, abi: ID, functionName: 'ownerOf', args: [BigInt(c.agentId)] })); } catch (_) {} if (o && o === c.payTo) owners.push(c); }
      if (owners.length === 1) out.push(owners[0]); else say('skip', url, '- tied to', owners.length, 'agents by owner = payTo');
    } else if (cs.length === 1) out.push(cs[0]);
    else say('skip', url, '- declared by', cs.length, 'agents (ambiguous)');
  }
  // one resource per agent, at most MAX_PER_OWNER agents of one owner (owners rated least recently first)
  const lastByOwner = {};
  for (const r of readLines(LOG)) if (r.live && r.owner) lastByOwner[r.owner] = Math.max(lastByOwner[r.owner] || 0, Date.parse(r.at));
  out.sort((a, b) => (lastByOwner[a.owner] || 0) - (lastByOwner[b.owner] || 0));
  const seen = new Set(), perOwner = {};
  return out.filter((c) => {
    if (seen.has(c.agentId) || (perOwner[c.owner] || 0) >= MAX_PER_OWNER) return false;
    seen.add(c.agentId); perOwner[c.owner] = (perOwner[c.owner] || 0) + 1; return true;
  }).slice(0, MAX);
}

async function main() {
  const why = nearWatchFeedback();
  if (why) { say('refused:', why); return 2; }
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); } catch (_) {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < 60 * 60e3) { say('refused: another run holds', LOCK); return 2; }
    fs.writeFileSync(LOCK, String(process.pid));
  }
  try { return await run(); } finally { try { fs.unlinkSync(LOCK); } catch (_) {} }
}

async function run() {
  if (!KEY) { say('RATER_KEY is required (a JSON key file; it is never printed)'); return 64; }
  const k = JSON.parse(fs.readFileSync(KEY, 'utf8'));
  const account = privateKeyToAccount(k.privateKey);
  if (V.getAddress(account.address) !== V.getAddress(k.address)) throw new Error('key file address mismatch');
  const me = lc(account.address);
  if (!(await pendingFree(me))) { say('refused: the Watchtower wallet has a pending transaction'); return 2; }
  const startBlock = await pub.getBlockNumber();
  const wallet = Number(V.formatUnits(await pub.getBalance({ address: me }), 18));
  const b = budget();
  const ours = ourAddresses(); ours.add(me);
  const list = await targets(ours);
  let available = Math.min(b.available, wallet - RESERVE_USD);
  say('wallet', me, 'USDC', wallet.toFixed(6), '| outside Arc revenue 7d', b.revenue7d, '| spent 7d', b.spent7d, '| this run may spend', Math.max(0, available).toFixed(6), '|', list.length, 'targets |', LIVE ? 'LIVE' : 'DRY');

  const gasPrice = await pub.getGasPrice();
  const handed = [];   // every authorization signed this run: { agentId, owner, payTo, authorization, proven }
  let code = 0;
  try {
    for (const t of list) {
      let fbGasUsd = 0.005;
      try { const g = await pub.estimateContractGas({ address: REPUTATION, abi: REP, functionName: 'giveFeedback', args: [BigInt(t.agentId), 100n, 0, 'x402-paid-call', 'delivered', t.declared.slice(0, 200), EVIDENCE_URL + '/' + t.agentId + '/evidence/paid-2026-01-01T000000Z.json', '0x' + '00'.repeat(32)], account: me }); fbGasUsd = Number(V.formatUnits(g * gasPrice * 12n / 10n, 18)); } catch (e) { say('#' + t.agentId, 'feedback would not simulate:', (e.shortMessage || e.message).slice(0, 100), '- skipped'); continue; }
      const maxPrice = Number(V.formatUnits(t.priceUnits && t.priceUnits > 0n ? t.priceUnits : MAX_PER_CALL_UNITS, 6));
      if (maxPrice + fbGasUsd > available) { say('#' + t.agentId, 'budget left', available.toFixed(6), '< price + gas', (maxPrice + fbGasUsd).toFixed(6), '- stop'); break; }
      await buyAndRate(t, account, me, startBlock, handed, (spent) => { available -= spent; });
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    say('STOPPED:', e.message); code = 3;
  }
  if (LIVE) await sweepLate(me, startBlock, handed);
  return code;
}

// Books any authorization of this run that settled but was not proven in-line (a seller that settled after answering).
async function sweepLate(me, startBlock, handed) {
  const open = handed.filter((h) => !h.proven && h.authorization);
  if (!open.length) return;
  const latestValid = Math.max(...open.map((h) => Number(h.authorization.validBefore || 0)));
  const wait = latestValid * 1000 - Date.now();
  if (wait > 0 && wait < (MAX_AUTH_SECONDS + 30) * 1000) { say('waiting', Math.ceil(wait / 1000), 's for the last authorization to expire before the late-settlement sweep'); await new Promise((r) => setTimeout(r, wait + 5000)); }
  const head = await pub.getBlockNumber();
  const used = new Map();
  for (let f = startBlock; f <= head; f += 9000n) {
    const to = f + 8999n > head ? head : f + 8999n;
    const logs = await pub.getLogs({ address: USDC, event: AUTH_USED, args: { authorizer: me }, fromBlock: f, toBlock: to });
    for (const l of logs) used.set(lc(l.args.nonce), l.transactionHash);
  }
  for (const h of open) {
    const tx = used.get(lc(h.authorization.nonce));
    if (!tx) { append(LOG, { at: new Date().toISOString(), live: true, agentId: h.agentId, owner: h.owner, authExpiredUnused: h.authorization.nonce, result: 'authorization expired unused: no money left' }); say('#' + h.agentId, 'authorization never settled (expired): no money left'); continue; }
    const usdc = Number(V.formatUnits(BigInt(h.authorization.value), 6));
    append(LEDGER, { at: new Date().toISOString(), chain: 'arc', tx, wallet: me, direction: 'out', asset_id: 'arc:native', amount: usdc, amount_units6: String(h.authorization.value), counterparty: h.payTo, category: 'purchase:x402-settled-late', notes: 'x402 call to agent ' + h.agentId + ' settled after the reply; not rated' });
    append(LOG, { at: new Date().toISOString(), live: true, agentId: h.agentId, owner: h.owner, signed: true, lateSettlement: tx, costUsdc: usdc, result: 'settled late: booked, not rated' });
    say('#' + h.agentId, 'settled late in', tx.slice(0, 12) + '…', '- booked', usdc, 'USDC');
  }
}

async function buyAndRate(t, account, me, startBlock, handed, charge) {
  const row = { at: new Date().toISOString(), live: LIVE, agentId: t.agentId, name: t.name, owner: t.owner, resource: t.url, payTo: t.payTo, via: t.via };
  let authorization = null;
  // DRY: the paid retry (the request carrying a payment signature) is intercepted here and never leaves this machine.
  // LIVE and DRY alike: the authorization we sign is decoded and kept, so every one handed out is on record.
  const baseFetch = async (input, init) => {
    const h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
    const sig = h.get('payment-signature') || h.get('x-payment');
    if (sig) {
      try { const p = JSON.parse(Buffer.from(sig, 'base64').toString('utf8')); const a = (p.payload && p.payload.authorization) || null; if (a) authorization = { to: lc(a.to), value: String(a.value), validBefore: String(a.validBefore), nonce: lc(a.nonce) }; } catch (_) {}
      if (!LIVE) return new Response(JSON.stringify({ dry: true }), { status: 599, headers: { 'content-type': 'application/json' } });
    }
    return fetch(input, Object.assign({}, init, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
  };
  // Pay only on Arc, only USDC's own EIP-3009 domain, only to the payTo the agent declared, only up to $0.01, only with a
  // short-lived authorization.
  const policyOk = (version, reqs) => reqs.filter((r) => r.scheme === 'exact' && r.network === 'eip155:5042' && lc(r.asset) === USDC && lc(r.payTo) === t.payTo
    && BigInt(r.amount || r.maxAmountRequired || 0) <= MAX_PER_CALL_UNITS && Number(r.maxTimeoutSeconds || 0) > 0 && Number(r.maxTimeoutSeconds) <= MAX_AUTH_SECONDS
    && r.extra && r.extra.name === 'USDC' && (!r.extra.assetTransferMethod || r.extra.assetTransferMethod === 'eip3009'));
  // SEND GATE (2026-10-06): before the client signs, the payment asks operator/arc-send-gate.js (sender
  // "arc-buy-and-rate", any_destination with a 0.01 cap per payment and 0.20 a day, because each payee comes from that agent's
  // own 402). Asked once per agent; in shadow mode a breach is logged and alerted, in enforce mode nothing is offered to sign.
  let gateDecision = null;
  const policy = (version, reqs) => {
    const ok = policyOk(version, reqs); if (!ok.length || !LIVE) return ok;
    if (!gateDecision) {
      try { gateDecision = require('./arc-send-gate.js').check({ source: 'arc-buy-and-rate', chain: 'arc', chainId: 5042, from: me, to: ok[0].payTo, usdc: Number(BigInt(ok[0].amount || ok[0].maxAmountRequired || 0)) / 1e6, purpose: 'buy-and-rate #' + t.agentId }); }
      catch (e) { gateDecision = { allow: false, decision: 'unavailable' }; say('SEND GATE UNAVAILABLE, nothing signed:', String(e.message).slice(0, 80)); }   // fail closed (7 Oct, §18)
    }
    return gateDecision.allow ? ok : [];
  };
  const pay = wrapFetchWithPaymentFromConfig(baseFetch, { schemes: [{ network: 'eip155:5042', client: new ExactEvmScheme(account) }], policies: [policy],
    spendControls: { allowedAssets: [{ network: 'eip155:5042', asset: USDC, maxAmountPerPayment: String(MAX_PER_CALL_UNITS) }] } });
  const t0 = Date.now();
  let res, body = Buffer.alloc(0), err = null;
  try { res = await pay(t.url, { method: 'GET', headers: { 'user-agent': 'APEX-Watchtower/1.0 (+https://apexfaucet.xyz/arc/agents/; paid review)' } }); body = Buffer.from(await res.arrayBuffer()); }
  catch (e) { err = String(e.message).slice(0, 200); }
  row.ms = Date.now() - t0;
  row.response = res ? { status: res.status, bytes: body.length, contentType: res.headers.get('content-type'), sha256: crypto.createHash('sha256').update(body).digest('hex') } : null;
  row.error = err; row.signed = !!authorization; row.authorization = authorization;
  // A 402 after we paid is the seller refusing our payment: keep its protocol error text (not the seller's product).
  if (res && res.status === 402 && authorization) { try { const j = JSON.parse(body.toString('utf8')); row.sellerError = String(j.error || j.message || j.reason || '').slice(0, 300) || null; } catch (_) {} }
  if (!LIVE) { row.result = authorization ? 'dry: payment signed, not sent' : 'dry: no acceptable payment was offered'; append(LOG, row); say('#' + t.agentId, t.name, '->', row.result, row.error ? '(' + row.error + ')' : ''); return; }
  if (!authorization) { row.result = 'no acceptable payment was offered: nothing signed, nothing rated'; append(LOG, row); say('#' + t.agentId, row.result); return; }
  const h = { agentId: t.agentId, owner: t.owner, payTo: t.payTo, authorization, proven: false };
  handed.push(h);

  // Settlement proof, tied to OUR authorization: the receipt must carry AuthorizationUsed(me, our nonce) and a Transfer
  // me -> payTo of exactly the value we signed, in a block after this run started.
  let settle = null; try { const hh = res && (res.headers.get('payment-response') || res.headers.get('x-payment-response')); settle = hh ? decodePaymentResponseHeader(hh) : null; } catch (_) {}
  const txh = settle && settle.success !== false && (!settle.network || settle.network === 'eip155:5042') && /^0x[0-9a-fA-F]{64}$/.test(String(settle.transaction || '')) ? settle.transaction : null;
  let paid = null;
  if (txh && authorization) {
    try {
      const r = await pub.waitForTransactionReceipt({ hash: txh, timeout: 60000 });
      const usdcLogs = r.logs.filter((l) => lc(l.address) === USDC);
      const used = V.parseEventLogs({ abi: [AUTH_USED], logs: usdcLogs }).some((l) => lc(l.args.authorizer) === me && lc(l.args.nonce) === authorization.nonce);
      const m = V.parseEventLogs({ abi: [TRANSFER], logs: usdcLogs }).find((l) => lc(l.args.from) === me && lc(l.args.to) === t.payTo && l.args.value === BigInt(authorization.value));
      if (r.status === 'success' && used && m && r.blockNumber >= startBlock) paid = { tx: txh, block: String(r.blockNumber), units: m.args.value.toString(), usdc: Number(V.formatUnits(m.args.value, 6)) };
    } catch (e) { row.settleError = String(e.shortMessage || e.message).slice(0, 160); }
  }
  row.settlement = settle ? { tx: settle.transaction || null, network: settle.network || null, success: settle.success } : null;
  row.paid = paid;
  if (!paid) { row.result = 'no settlement of our authorization proven on chain: nothing rated (late settlements are swept at the end)'; append(LOG, row); say('#' + t.agentId, row.result); return; }
  h.proven = true;
  charge(paid.usdc);
  append(LEDGER, { at: row.at, chain: 'arc', tx: paid.tx, wallet: me, direction: 'out', asset_id: 'arc:native', amount: paid.usdc, amount_units6: paid.units, counterparty: t.payTo, category: 'purchase:x402-review', notes: 'paid x402 call to agent ' + t.agentId });

  const delivered = !!(res && res.status === 200 && body.length > 0);
  const failed = !!res && (res.status >= 500 || (res.status === 200 && body.length === 0));
  if (!delivered && !failed) {   // 4xx after a proven payment: possibly our request's fault, so no rating
    row.result = 'paid, HTTP ' + (res ? res.status : 'none') + ' after payment: not rated (our request may have been incomplete)';
    append(LOG, Object.assign(row, { costUsdc: paid.usdc })); say('#' + t.agentId, row.result); return;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace(/^(\d{4})(\d{2})(\d{2})T/, '$1-$2-$3T');
  const file = 'paid-' + stamp + '.json';
  const evidence = { kind: 'x402 paid call', reviewer: 'APEX Watchtower (ERC-8004 #211 on Arc), operated by APEX Faucet (#1). #211 also sells its own data over x402 on Arc.', agentId: t.agentId, agentName: t.name,
    resource: t.url, declaredResource: t.declared, how: 'GET, one call, paid over x402 on Arc (eip155:5042) with USDC, to the payTo this agent declares (' + t.via + ')',
    payment: { payer: me, payTo: t.payTo, usdc: paid.usdc, tx: paid.tx, block: paid.block, verified: 'AuthorizationUsed(payer, nonce) for our own signed authorization and a Transfer payer -> payTo of that value, both in the receipt, on USDC 0x3600' },
    response: row.response, ms: row.ms, grade: delivered ? 100 : 0,
    rubric: 'Delivery only, not taste: a proven settlement + HTTP 200 + a non-empty body = 100; a proven settlement + a server error or an empty 200 = 0. A 4xx after payment, a timeout, or a response without a provable settlement is not rated. The body is the seller\'s product and is not republished; its sha256 is.',
    relation: t.relation || 'none known', at: row.at };
  const bytes = Buffer.from(JSON.stringify(evidence, null, 1) + '\n', 'utf8');
  const feedbackURI = EVIDENCE_URL + '/' + t.agentId + '/evidence/' + file;
  const hash = V.keccak256(bytes);
  const args = [BigInt(t.agentId), delivered ? 100n : 0n, 0, 'x402-paid-call', delivered ? 'delivered' : 'not-delivered', t.declared.slice(0, 200), feedbackURI, hash];
  try { await pub.simulateContract({ address: REPUTATION, abi: REP, functionName: 'giveFeedback', args, account: me }); }
  catch (e) { row.result = 'paid, feedback simulation failed: ' + String(e.shortMessage || e.message).slice(0, 120); append(LOG, Object.assign(row, { costUsdc: paid.usdc })); say('#' + t.agentId, row.result); return; }
  // written only after the simulation passed, so a refused feedback never leaves an orphan file
  fs.mkdirSync(path.join(EVID, String(t.agentId)), { recursive: true });
  fs.writeFileSync(path.join(EVID, String(t.agentId), file), bytes, { flag: 'wx' });
  // the shared key: re-check the watch-feedback window and pending transactions right before sending
  const why = nearWatchFeedback();
  if (why || !(await pendingFree(me))) { append(LOG, Object.assign(row, { costUsdc: paid.usdc, evidence: feedbackURI, result: 'paid, feedback NOT sent: ' + (why || 'pending transaction on the key') })); throw new Stop(why || 'pending transaction on the Watchtower key'); }
  let fbTx = null;
  try {
    const wal = V.createWalletClient({ chain: arc, account, transport: V.http(RPC, { timeout: 30000 }) });
    fbTx = await wal.writeContract({ address: REPUTATION, abi: REP, functionName: 'giveFeedback', args });
    say('#' + t.agentId, 'feedback sent', fbTx);
    const fr = await pub.waitForTransactionReceipt({ hash: fbTx, timeout: 90000 });
    const gasUsd = Number(V.formatUnits(fr.gasUsed * fr.effectiveGasPrice, 18));
    charge(gasUsd);
    append(LEDGER, { at: new Date().toISOString(), chain: 'arc', tx: fbTx, wallet: me, direction: 'out', asset_id: 'arc:native', amount: gasUsd, amount_wei: String(fr.gasUsed * fr.effectiveGasPrice), counterparty: REPUTATION, category: 'gas:feedback', notes: 'giveFeedback for agent ' + t.agentId });
    Object.assign(row, { grade: delivered ? 100 : 0, evidence: feedbackURI, feedbackHash: hash, feedbackTx: fbTx, feedbackStatus: fr.status, costUsdc: +(paid.usdc + gasUsd).toFixed(6), result: 'rated ' + (delivered ? 100 : 0) });
    append(LOG, row);
    say('#' + t.agentId, t.name, 'paid', paid.usdc, 'USDC tx', paid.tx.slice(0, 12) + '…', '| HTTP', row.response && row.response.status, row.response && row.response.bytes, 'bytes | rated', delivered ? 100 : 0, '| feedback', fr.status);
  } catch (e) {
    append(LOG, Object.assign(row, { grade: delivered ? 100 : 0, evidence: feedbackURI, feedbackHash: hash, feedbackTx: fbTx, feedbackStatus: 'unknown', costUsdc: paid.usdc, error: String(e.shortMessage || e.message).slice(0, 200), result: 'paid, feedback send failed or unconfirmed' }));
    throw new Stop('feedback send failed or unconfirmed for agent ' + t.agentId + ' (tx ' + (fbTx || 'none') + '): stopping, a transaction may be pending');
  }
}

main().then((c) => process.exit(c || 0)).catch((e) => { console.error('FAILED', e.message); try { fs.unlinkSync(LOCK); } catch (_) {} process.exit(1); });
