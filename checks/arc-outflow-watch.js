#!/usr/bin/env node
'use strict';
// ARC OUTFLOW WATCH (2026-10-06, Fable review gap 5: "a gate protects only callers"). Every 15 minutes it reads, from the
// chain, every native USDC movement OUT of our Arc project wallets since the last run (Arc emits a Transfer log from
// 0xffff…fffe for every native USDC move: plain sends, ERC-20 transfers, contract pulls). Each one must be explained:
//   - its destination is one of ours (registry: project / founder classes) or on the send gate's list of known contracts
//     (/etc/apex/send-gate.json: faucet pot, splitter, PoolManager, routers, Permit2, Gateway), or
//   - its transaction hash is written in one of our own records (data/ledger/*, refunds, arc-move, buy-and-rate,
//     account annotations, the gas refill log).
// Anything else is value leaving us for a stranger with no record: the private channel is told AT ONCE (it does not wait for
// nightwatch), once per transaction. A drain by a stolen key or a bug outside the gate looks exactly like this.
// Limits, stated: it watches USDC only (other Arc tokens: the account cycle, every 2 h); it reads at most 100,000 blocks
// (~14 h) per run, so a gap longer than that is reported as a gap, never skipped silently.
// State: data/arc-outflow-watch.json (last block, alerted hashes). Planted test: ARC_WATCH_PLANT=<json file of logs>.
// Usage: node tools/arc-outflow-watch.js            (timer: apex-arc-outflow-watch.timer, every 15 min)
const fs = require('fs');
const path = require('path');
const v = require('/root/apex-faucet/node_modules/viem');

const ROOT = '/root/apex-faucet';
const STATE = process.env.ARC_WATCH_STATE || ROOT + '/data/arc-outflow-watch.json';
const NATIVE_LOG = '0xfffffffffffffffffffffffffffffffffffffffe';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAX_SPAN = 100000n;
const SMALL_USDC = 2;   // a send to a known contract or a founder wallet under this needs no record
const lc = (a) => String(a || '').toLowerCase();
const pad = (a) => '0x' + '0'.repeat(24) + lc(a).slice(2);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return d; throw e; } };
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };

function knownSets() {
  const reg = readJson(ROOT + '/data/protected/account/wallet-registry.json', null);
  if (!reg) throw new Error('wallet registry unreadable');
  const arc = reg.entries.filter((e) => e.chain === 'arc');
  const watched = arc.filter((e) => e.owner_class === 'project' && e.kind === 'wallet').map((e) => lc(e.address));
  // Fable review (6 Oct): only our own project wallets explain a send by themselves. A known contract (pot, routers,
  // PoolManager, Gateway) or a founder wallet explains it only when the amount is small (under SMALL_USDC) or its hash is
  // on record: a planted 100,000 USDC deposit into the PoolManager used to pass silently.
  const ours = new Set(arc.filter((e) => e.owner_class === 'project').map((e) => lc(e.address)));
  const known = new Set(arc.filter((e) => ['founder', 'founder-personal', 'contract-held'].includes(e.owner_class)).map((e) => lc(e.address)));
  const policy = readJson('/etc/apex/send-gate.json', { destinations: {} });
  for (const a of Object.keys(policy.destinations || {})) if (!ours.has(lc(a))) known.add(lc(a));
  // every tx hash one of our own records names
  const hashes = new Set();
  const grab = (text) => { for (const m of String(text).matchAll(/0x[0-9a-fA-F]{64}/g)) hashes.add(lc(m[0])); };
  const LD = ROOT + '/data/ledger';
  try { for (const f of fs.readdirSync(LD)) if (!f.startsWith('_') && f.endsWith('.ndjson')) grab(fs.readFileSync(path.join(LD, f), 'utf8')); } catch (e) {}
  for (const f of [ROOT + '/data/refunds.ndjson', '/home/claudeuser/core/data/arc-move.jsonl', '/home/claudeuser/core/data/buy-and-rate.ndjson',
    ROOT + '/data/protected/account/annotations.ndjson', ROOT + '/data/arc-gas-refill.ndjson']) grab(lines(f).join('\n'));
  return { watched, ours, known, hashes };
}

// Pure: which outflows are unexplained. Exported for the tests.
function classify(logs, K) {
  const out = [];
  for (const l of logs) {
    const from = '0x' + String(l.topics[1]).slice(26).toLowerCase(), to = '0x' + String(l.topics[2]).slice(26).toLowerCase();
    if (!K.watched.includes(from)) continue;
    const usdc = Number(BigInt(l.data)) / 1e18;
    const tx = lc(l.transactionHash);
    if (K.ours.has(to) || K.hashes.has(tx)) continue;
    if (K.known && K.known.has(to) && usdc < SMALL_USDC) continue;
    out.push({ from, to, usdc, tx, block: Number(BigInt(l.blockNumber)) });
  }
  return out;
}

async function tell(text) {
  try {
    const env = fs.readFileSync(ROOT + '/.env', 'utf8');
    const pick = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
    const token = pick('TELEGRAM_BOT_TOKEN'), chat = pick('TELEGRAM_OPS_CHAT_ID') || pick('TELEGRAM_PRIVATE_CHAT_ID');
    if (!token || !chat) return 'ALERT NOT SENT: no Telegram token / private chat in .env';
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) });
    return r.ok ? 'ALERT SENT to the private channel' : 'ALERT NOT DELIVERED: Telegram HTTP ' + r.status;
  } catch (e) { return 'ALERT NOT SENT: ' + e.message; }
}

if (require.main !== module) { module.exports = { classify, knownSets }; return; }

(async () => {
  const K = knownSets();
  const st = readJson(STATE, { lastBlock: null, alerted: [] });
  let logs = [], head = null, fromBlock = null, gap = null;
  const disagree = [], secondErrors = [];
  if (process.env.ARC_WATCH_PLANT) logs = JSON.parse(fs.readFileSync(process.env.ARC_WATCH_PLANT, 'utf8'));
  else {
    // Two independent nodes (Fable review): a pruned or lagging node answers an empty range as if it were empty. Blockdaemon
    // serves wide ranges; the official RPC is read in 4,000-block chunks. The union is classified; a disagreement is said.
    const pub = v.createPublicClient({ transport: v.http('https://rpc.blockdaemon.mainnet.arc.io', { timeout: 30000, retryCount: 2 }) });
    const pub2 = v.createPublicClient({ transport: v.http('https://rpc.mainnet.arc.io', { timeout: 30000, retryCount: 2 }) });
    head = await pub.getBlockNumber();
    fromBlock = st.lastBlock != null ? BigInt(st.lastBlock) + 1n : head - 7000n;   // first run: the last ~1 h
    if (head - fromBlock + 1n > MAX_SPAN) { gap = { from: fromBlock.toString(), to: (head - MAX_SPAN).toString() }; fromBlock = head - MAX_SPAN + 1n; }
    // one request covers all watched wallets (topic1 as an OR list); the official node throttles bursts, so it is read
    // with pauses and retries, then beamrpc (1,000-block cap) as the second witness if the official one keeps refusing
    const topics = [TRANSFER, K.watched.map(pad)];
    const r = await pub.request({ method: 'eth_getLogs', params: [{ address: NATIVE_LOG, topics, fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + head.toString(16) }] });
    const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
    async function second(url, step) {
      const c = v.createPublicClient({ transport: v.http(url, { timeout: 30000, retryCount: 0 }) });
      const out = [];
      for (let a = fromBlock; a <= head; a += step) {
        const b = a + step - 1n > head ? head : a + step - 1n;
        let got = null;
        for (let k = 0; k < 4 && !got; k++) { try { got = await c.request({ method: 'eth_getLogs', params: [{ address: NATIVE_LOG, topics, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }] }); } catch (e) { await sleep(1500 * (k + 1)); } }
        if (!got) throw new Error(url + ' refused blocks ' + a + '..' + b);
        out.push(...got); await sleep(300);
      }
      return out;
    }
    let r2 = null, witness = null;
    for (const [url, step] of [['https://rpc.mainnet.arc.io', 4000n], ['https://rpc.beamrpc.com', 1000n]]) {
      try { r2 = await second(url, step); witness = url; break; } catch (e) { secondErrors.push(e.message.slice(0, 120)); }
    }
    logs.push(...r);
    if (r2) {
      const id = (l) => lc(l.transactionHash) + ':' + String(l.logIndex);
      const seen = new Set(r.map(id)), seen2 = new Set(r2.map(id));
      const only2 = r2.filter((l) => !seen.has(id(l))), only1 = r.filter((l) => !seen2.has(id(l)));
      if (only2.length || only1.length) disagree.push('blockdaemon ' + r.length + ' log(s), ' + witness.replace('https://', '') + ' ' + r2.length + ' (' + only1.length + ' only on the first, ' + only2.length + ' only on the second)');
      logs.push(...only2);
    }
  }
  const bad = classify(logs, K).filter((b) => !(st.alerted || []).includes(b.tx));
  const line = (logs.length + ' outflow log(s) from ' + K.watched.length + ' Arc wallets' + (head != null ? ', blocks ' + fromBlock + '..' + head : ' (planted)'));
  if (head != null) {
    st.next = { lastBlock: head.toString(), checkedAt: new Date().toISOString(), alerted: (st.alerted || []).slice(-500), pending: st.pending || [], disagree,
      secondOkAt: secondErrors.length < 2 ? new Date().toISOString() : (st.secondOkAt || null), secondErrors };
  }
  const save = () => { if (st.next) { fs.writeFileSync(STATE + '.tmp', JSON.stringify(st.next, null, 1)); fs.renameSync(STATE + '.tmp', STATE); } };
  // pending alerts from an earlier run whose message did not go out are raised again
  const pendingBad = (st.pending || []).filter((p) => !bad.some((b) => b.tx === p.tx));
  bad.push(...pendingBad);
  if (gap) console.log('GAP  blocks ' + gap.from + '..' + gap.to + ' were not read (the watch was off longer than ~14 h); the account cycle still covers them');
  if (disagree.length) console.log('WARN the two nodes disagree (the union was checked): ' + disagree.join('; '));
  if (secondErrors.length >= 2) console.log('WARN no second node answered this run (' + secondErrors.join(' | ') + '); checked on one node only');
  if (!bad.length) { if (st.next) st.next.pending = []; save(); console.log('OK   ' + line + ': every one explained'); process.exit(gap || disagree.length ? 1 : 0); }
  const msg = 'ARC OUTFLOW NOBODY RECORDED: ' + bad.length + ' USDC transfer(s) from our wallets to an unknown address with no record of ours.\n' +
    bad.slice(0, 5).map((b) => b.usdc.toFixed(4) + ' USDC ' + b.from.slice(0, 10) + ' -> ' + b.to + '\n  https://explorer.arc.io/tx/' + b.tx).join('\n') +
    '\nIf this was a hand transfer, write it down (annotation). If not: touch /etc/apex/SEND-STOP stops the gated senders (' + Object.keys(readJson('/etc/apex/send-gate.json', { senders: {} }).senders || {}).join(', ') + '); any other sender must be stopped by hand.';
  console.log('FAIL ' + line + '\n' + msg);
  if (!process.env.ARC_WATCH_PLANT) {
    const r = await tell(msg); console.log(r);
    if (st.next) {
      if (/^ALERT SENT/.test(r)) { st.next.alerted = [...new Set([...st.next.alerted, ...bad.map((b) => b.tx)])].slice(-500); st.next.pending = []; }
      else st.next.pending = bad;   // not delivered: kept, raised again next run, and check-send-gate fails on it
      save();
    }
  }
  process.exit(1);
})().catch((e) => { console.error('FAIL arc-outflow-watch: ' + (e.shortMessage || e.message)); process.exit(2); });
