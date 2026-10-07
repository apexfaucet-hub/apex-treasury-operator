#!/usr/bin/env node
'use strict';
// FAIR RATER (2026-10-07, Martin: "write a program which rates everybody fairly"). Writes the APEX Watchtower score
// (rubric apex-watch v1, /root/apex-faucet/public/arc/fair-score.js: the same file the board shows) for every MEASURED agent
// in Arc's ERC-8004 registry to the reputation registry, from agent #211's own wallet: tag1 "score", tag2 "apex-watch-v1",
// value 0-100, evidence file hashed on chain (same pattern as watch-feedback.js, which keeps writing weekly uptime).
//   - Everyone who qualifies, up or down. Qualifies = lists a service we can call AND has 6+ measured hours (not "partial").
//   - Never about ourselves: our agents (#1, #211, any agent owned by one of our wallets) are skipped, and the contract is asked
//     isAuthorizedOrOwner before every write.
//   - Each agent once; again only when its score has moved 10+ points and the last write is 7+ days old.
//   - Gas is real money: at most MAX per run and DAILY_CAP per UTC day, never below MIN_BALANCE in the wallet.
//     About 0.0043 USDC per write (receipt of 7 Oct: 214,452 gas at 20 gwei).
//   - Shares the watchtower key with watch-feedback.js and buy-and-rate.js: same wallet lock, so they never send at once.
// Usage: node core/arc/fair-rate.js [--dry] [--max N] [--only ID]
const fs = require('fs');
const path = require('path');
const { createPublicClient, createWalletClient, http, fallback, defineChain, parseAbi, keccak256, getAddress } = require('/root/apex-faucet/node_modules/viem');
const { privateKeyToAccount } = require('/root/apex-faucet/node_modules/viem/accounts');
const FAIR = require('/root/apex-faucet/public/arc/fair-score.js');
// Every sender records what it sent (CLAUDE.md 2). A rating moves no value, only gas: expect 0 USDC out, so any value outflow
// or a revert is written down as a failure for the account layer instead of passing silently.
const REC = require('/root/apex-faucet/lib/ledger-log-evm.js');

const WATCH = '/root/apex-faucet/data/protected/arc-agent-watch.json';
const EARN = '/root/apex-faucet/data/protected/arc-agent-earnings.json';
const LOG = '/root/apex-faucet/data/arc-fair-rate.jsonl';
const EVID = '/root/apex-faucet/data/arc-watch-evidence';
const IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REPUTATION = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const WATCHTOWER_AGENT_ID = 211;
const REWRITE_MS = 7 * 24 * 3600e3, REWRITE_DELTA = 10;
const argv = process.argv;
const DRY = argv.includes('--dry');
const MAX = argv.includes('--max') ? Math.max(0, Number(argv[argv.indexOf('--max') + 1]) || 0) : 30;
const ONLY = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;
const DAILY_CAP = 60;
// A score goes on chain only after 6 measured hours (the rubric's own threshold for using 7-day uptime). Below that the board shows
// a provisional score ("answering now, N measured hours so far"); one probe is not a rating.
const MIN_HOURS = 6;
const MIN_BALANCE = 0.03;
const OUR_WALLETS = (() => {
  const set = new Set();
  for (const f of fs.readdirSync('/root/apex-faucet/keys').filter((x) => x.endsWith('.json'))) {
    try { const j = JSON.parse(fs.readFileSync('/root/apex-faucet/keys/' + f, 'utf8')); if (Array.isArray(j)) continue;
      const a = j.address || (typeof j.privateKey === 'string' && /^0x[0-9a-fA-F]{64}$/.test(j.privateKey) ? privateKeyToAccount(j.privateKey).address : null);
      if (a) set.add(String(a).toLowerCase()); } catch (e) { /* not an EVM key file */ }
  }
  try { JSON.stringify(JSON.parse(fs.readFileSync('/root/apex-faucet/data/arc-extra-wallets.json', 'utf8'))).replace(/0x[0-9a-fA-F]{40}/g, (m) => { set.add(m.toLowerCase()); return m; }); } catch (e) {}
  return set;
})();
const arc = defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } });
const pub = createPublicClient({ chain: arc, transport: fallback(['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.beamrpc.com', 'https://rpc.mainnet.arc.io'].map((u) => http(u, { timeout: 20000 }))) });
const REP_ABI = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function getIdentityRegistry() view returns (address)',
]);
const ID_ABI = parseAbi(['function isAuthorizedOrOwner(address spender, uint256 agentId) view returns (bool)']);

function readLog() {
  const last = new Map(); let today = 0; const day = new Date().toISOString().slice(0, 10);
  try {
    for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
      if (!line.trim()) continue; let j; try { j = JSON.parse(line); } catch (e) { continue; }
      if (j.status !== 'success') continue;
      last.set(j.agentId, { at: Date.parse(j.at), value: j.value });
      if (String(j.at).slice(0, 10) === day) today++;
    }
  } catch (e) { /* no log yet */ }
  return { last, today };
}

async function main() {
  const w = JSON.parse(fs.readFileSync(WATCH, 'utf8'));
  if (!w || !Array.isArray(w.agents) || (w.lastRound && w.lastRound.aborted)) throw new Error('no clean watchtower round to score from');
  if (Date.now() - Date.parse(w.at) > 3 * 3600e3) throw new Error('the watchtower data is ' + Math.round((Date.now() - Date.parse(w.at)) / 60000) + ' minutes old - not writing stale measurements on chain');
  let byId = {}; try { byId = JSON.parse(fs.readFileSync(EARN, 'utf8')).byId || {}; } catch (e) { console.log('[FAIR-RATE] earnings index unreadable (' + e.message + '): customers points read as 0 this run'); }
  const idReg = await pub.readContract({ address: REPUTATION, abi: REP_ABI, functionName: 'getIdentityRegistry' });
  if (getAddress(idReg) !== getAddress(IDENTITY)) throw new Error('reputation registry points at ' + idReg + ', not ' + IDENTITY);
  const key = JSON.parse(fs.readFileSync('/root/apex-faucet/keys/arc-watchtower.json', 'utf8'));
  const acct = privateKeyToAccount(key.privateKey);
  const wal = createWalletClient({ chain: arc, transport: fallback(['https://rpc.mainnet.arc.io', 'https://rpc.blockdaemon.mainnet.arc.io'].map((u) => http(u, { timeout: 20000 })), { rank: false }), account: acct });
  const { last, today } = readLog();
  const plan = [];
  let counted = { measured: 0, partial: 0, fresh: 0, noService: 0, ours: 0, unchanged: 0 };
  for (const a of w.agents) {
    if (ONLY != null && a.id !== ONLY) continue;
    if (a.ours || a.id === WATCHTOWER_AGENT_ID || a.id === 1 || OUR_WALLETS.has(String(a.owner || '').toLowerCase())) { counted.ours++; continue; }
    const x = byId[a.id];
    const s = FAIR.score(a, x && x.earned, x && x.gateway);
    if (!s.breakdown.endpoints) { counted.noService++; continue; }
    if (s.partial) { counted.partial++; continue; }
    if ((Number(a.samples7d) || 0) < MIN_HOURS) { counted.fresh++; continue; }
    counted.measured++;
    const prev = last.get(a.id);
    if (prev && (Date.now() - prev.at < REWRITE_MS || Math.abs(prev.value - s.score) < REWRITE_DELTA)) { counted.unchanged++; continue; }
    plan.push({ a, s, prev, hours: Number(a.samples7d) || 0 });
  }
  // Order only decides who is written first when gas is short; everyone who qualifies is written in time. Never-rated agents
  // first, answering ones before silent ones (an active owner will see it), then the ones measured longest.
  const live = (a) => (a.status === 'up' || a.status === 'degraded' ? 0 : 1);
  plan.sort((p, q) => (p.prev ? 1 : 0) - (q.prev ? 1 : 0) || live(p.a) - live(q.a) || q.hours - p.hours || p.a.id - q.a.id);
  const room = Math.max(0, Math.min(MAX, DAILY_CAP - today));
  console.log('[FAIR-RATE] ' + JSON.stringify(counted) + '; ' + plan.length + ' to write, ' + today + ' written today, room ' + room + (DRY ? ' (dry run)' : ''));
  let balance = Number(await pub.getBalance({ address: acct.address })) / 1e18;
  const hourNow = new Date().toISOString().slice(0, 13);
  let failures = 0; const results = [];
  for (const { a, s } of plan.slice(0, room)) {
    if (balance < MIN_BALANCE) { console.log('[FAIR-RATE] stopping: the watchtower wallet holds ' + balance.toFixed(4) + ' USDC'); break; }
    if (failures >= 3) { console.log('[FAIR-RATE] stopping after 3 failures'); break; }
    const file = 'score-' + hourNow + 'Z.json';
    const dir = path.join(EVID, String(a.id)), fp = path.join(dir, file);
    const feedbackURI = 'https://apexfaucet.xyz/arc/agents/' + a.id + '/evidence/' + file;
    const endpoint = a.primary && a.primary.url ? String(a.primary.url).slice(0, 200) : '';
    const evidence = {
      agentRegistry: 'eip155:5042:' + IDENTITY, agentId: a.id, clientAddress: 'eip155:5042:' + acct.address,
      createdAt: new Date().toISOString(), value: s.score, valueDecimals: 0, tag1: 'score', tag2: s.version, endpoint,
      watchtower: {
        by: 'APEX Watchtower, agent #' + WATCHTOWER_AGENT_ID + ' on Arc (apexfaucet.xyz/arc/agents/)',
        meaning: 'A 0-100 score built only from what our hourly checks measured and what the chain shows, the same rubric for every agent. It never depends on whether an agent rates us.',
        rubric: FAIR.RUBRIC, breakdown: s.breakdown, notes: s.notes, rubricSource: 'https://apexfaucet.xyz/arc/fair-score.js',
        measuredAt: w.at, inputs: { status: a.status, uptime7d: a.uptime7d, measuredHours7d: a.samples7d, p50Ms: a.p50Ms, arcPayable: a.arcPayable || null,
          domains: a.domains || [], earned: (byId[a.id] && byId[a.id].earned) || null, gatewayCredits: (byId[a.id] && byId[a.id].gateway && byId[a.id].gateway.credits) || 0 },
        page: 'https://apexfaucet.xyz/arc/agents/' + a.id,
      },
    };
    const bytes = fs.existsSync(fp) ? fs.readFileSync(fp) : Buffer.from(JSON.stringify(evidence, null, 1) + '\n', 'utf8');
    const hash = keccak256(bytes);
    const args = [BigInt(a.id), BigInt(s.score), 0, 'score', s.version, endpoint, feedbackURI, hash];
    const row = { at: new Date().toISOString(), agentId: a.id, name: a.name, value: s.score, evidence: feedbackURI, hash };
    try {
      if (await pub.readContract({ address: IDENTITY, abi: ID_ABI, functionName: 'isAuthorizedOrOwner', args: [acct.address, BigInt(a.id)] })) { console.log('  skip #' + a.id + ': our wallet is its owner or operator'); continue; }
      await pub.simulateContract({ address: REPUTATION, abi: REP_ABI, functionName: 'giveFeedback', args, account: acct });
    } catch (e) { row.status = 'simulate-failed'; row.error = String(e.shortMessage || e.message).slice(0, 160); results.push(row); failures++; console.log('  #' + a.id + ' simulation failed: ' + row.error); continue; }
    if (DRY) { row.status = 'dry'; results.push(row); console.log('  #' + a.id + ' ' + (a.name || '') + ': ' + s.score + '/100 -> would write (simulated OK)'); continue; }
    if (!fs.existsSync(fp)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fp, bytes); }
    try {
      const tx = await wal.writeContract({ address: REPUTATION, abi: REP_ABI, functionName: 'giveFeedback', args });
      row.tx = tx;
      let rc = null; for (let i = 0; i < 30 && !rc; i++) { try { rc = await pub.getTransactionReceipt({ hash: tx }); } catch (e) {} if (!rc) await new Promise((r) => setTimeout(r, 2000)); }
      row.status = rc ? rc.status : 'pending';
      if (rc) { const cost = Number(rc.gasUsed * rc.effectiveGasPrice) / 1e18; row.costUsdc = +cost.toFixed(6); balance -= cost; }
      if (row.status !== 'success') failures++;
      await REC.recordSentEvm(tx, { source: 'arc-fair-rate', chain: 'arc', wallets: [acct.address], expect: { usdc: 0 }, category: 'cost:gas', product: 'erc8004-rating' });
    } catch (e) { row.status = 'send-failed'; row.error = String(e.shortMessage || e.message).slice(0, 160); failures++; }
    fs.appendFileSync(LOG, JSON.stringify(row) + '\n');
    results.push(row);
    console.log('  #' + a.id + ' ' + (a.name || '') + ': ' + s.score + '/100 -> ' + row.status + (row.tx ? ' ' + row.tx : '') + (row.error ? ' ' + row.error : ''));
  }
  const ok = results.filter((r) => r.status === 'success'), bad = results.filter((r) => r.status !== 'success' && r.status !== 'dry');
  console.log('[FAIR-RATE] written ' + ok.length + ', failed ' + bad.length + ', cost ' + ok.reduce((t, r) => t + (r.costUsdc || 0), 0).toFixed(4) + ' USDC, wallet left ' + balance.toFixed(4) + ' USDC');
  if (bad.length) process.exitCode = 1;
}

const WALLET_LOCK = '/home/claudeuser/core/data/.watchtower-wallet.lock';
function takeLock() {
  try { fs.writeFileSync(WALLET_LOCK, 'fair-rate ' + process.pid, { flag: 'wx' }); return true; } catch (_) {
    let age = Infinity; try { age = Date.now() - fs.statSync(WALLET_LOCK).mtimeMs; } catch (e) {}
    if (age < 60 * 60e3) return false;
    fs.writeFileSync(WALLET_LOCK, 'fair-rate ' + process.pid); return true;
  }
}
if (!takeLock()) { console.log('[FAIR-RATE] another writer holds ' + WALLET_LOCK + ': skipped this run'); process.exitCode = 0; }
else main().catch((e) => { console.error('[FAIR-RATE] failed: ' + (e.shortMessage || e.message)); process.exitCode = 1; }).finally(() => { try { fs.unlinkSync(WALLET_LOCK); } catch (_) {} });
