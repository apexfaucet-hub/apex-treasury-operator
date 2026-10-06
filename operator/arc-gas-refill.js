#!/usr/bin/env node
'use strict';
// ARC GAS AUTO-REFILL (2026-10-06, Fable review gap 4). On 4 Oct the Arc operator (which pays the gas of every x402
// settlement, faucet claim and contract call) ran dry while nobody could act; direct Arc payments were refused for two days.
// This moves USDC between two of OUR wallets only: from the x402 receive wallet to the operator, with hard limits:
//   - both addresses come from their key files' address fields and must equal the ones written below (never typed into a
//     transaction, never recalled); the operator must have no contract code, read on chain before signing;
//   - refill only when the operator is under FLOOR, up to TARGET, at most the per-send cap;
//   - the receive wallet keeps at least SOURCE_KEEP after the send and its gas, or nothing is sent (it pays refunds);
//   - at most ONE refill per 24 h: an operator under its floor again within 24 h of a refill is a suspected drain (bug,
//     loop or stolen key), so nothing is sent, the run exits 1, and check-fee-wallets alerts as the balance keeps falling.
//     A refill must never hide a drain;
//   - every send asks the send gate first (lib/arc-send-gate.js, sender "arc-gas-refill", enforce: per-send and per-day
//     caps in /etc/apex/send-gate.json), writes its hash BEFORE waiting, and is recorded by the EVM recorder
//     (lib/ledger-log-evm.js) so the account layer sees a recorded internal transfer.
// Usage: node tools/arc-gas-refill.js [--dry]      (timer: apex-arc-gas-refill.timer, every 30 min)
const fs = require('fs');
const v = require('/root/apex-faucet/node_modules/viem');
const { privateKeyToAccount } = require('/root/apex-faucet/node_modules/viem/accounts');
const G = require('/root/apex-faucet/lib/arc-send-gate.js');
const REC = require('/root/apex-faucet/lib/ledger-log-evm.js');

const DRY = process.argv.includes('--dry');
const FLOOR = 0.4, TARGET = 1.5, MIN_SEND = 0.1, SOURCE_KEEP = 0.3, ONE_PER_MS = 24 * 3600 * 1000;
const OPERATOR_EXPECT = '0x024b82335c29fa5606a8ea5c1d24fc9ead50700c';
const SOURCE_EXPECT = '0xd334ab5151c624cada654854e2879903dc4217ed';
const STATE = '/root/apex-faucet/data/arc-gas-refill-state.json';
const LOG = '/root/apex-faucet/data/arc-gas-refill.ndjson';
const REC_DIR = REC.DIR || '/root/apex-faucet/data/ledger';
const RPCS = ['https://rpc.mainnet.arc.io', 'https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.beamrpc.com'];
const arc = v.defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPCS[0]] } } });
const transport = () => v.fallback(RPCS.map((u) => v.http(u, { timeout: 15000, retryCount: 1 })), { rank: false });
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(Object.assign({ at: new Date().toISOString() }, o)) + '\n');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return d; throw e; } };

// Pure: what to do for these balances. Exported for tests/arc-gas-refill.test.js.
function plan({ opBal, srcBal, gasCost, lastSentAt, now, capUsdc }) {
  if (opBal >= FLOOR) return { act: 'none' };
  if (lastSentAt && now - Date.parse(lastSentAt) < ONE_PER_MS) return { act: 'refuse', drain: true, reason: 'SUSPECTED DRAIN: the operator is under its floor again within 24 h of the last refill (' + lastSentAt + '): nothing sent' };
  // the per-send cap is the gate policy's (one number in one place, Fable review 6 Oct); a missing cap sends nothing
  if (!(Number(capUsdc) > 0)) return { act: 'refuse', reason: 'no per-send cap for arc-gas-refill in /etc/apex/send-gate.json' };
  let amount = Math.min(TARGET - opBal, Number(capUsdc), srcBal - SOURCE_KEEP - gasCost);
  amount = Math.floor(Number(amount.toFixed(9)) * 1e6) / 1e6;   // toFixed first: 1.5 - 0.39 is 1.1099999… in floating point
  if (!(amount >= MIN_SEND)) return { act: 'refuse', reason: 'the receive wallet cannot fund a refill and keep ' + SOURCE_KEEP + ' USDC (it could send ' + Math.max(0, amount).toFixed(4) + ')' };
  return { act: 'send', amount };
}
if (require.main !== module) { module.exports = { plan, FLOOR, TARGET, SOURCE_KEEP }; return; }

(async () => {
  const opAddr = String(readJson('/root/apex-faucet/keys/arc-operator.json', {}).address || '').toLowerCase();
  if (opAddr !== OPERATOR_EXPECT) throw new Error('operator key file address ' + opAddr + ' is not the expected operator');
  const srcKey = readJson('/root/apex-faucet/keys/arc-receive.json', {});
  const src = privateKeyToAccount(srcKey.privateKey);
  if (src.address.toLowerCase() !== SOURCE_EXPECT || String(srcKey.address || '').toLowerCase() !== SOURCE_EXPECT) throw new Error('receive key does not derive the expected source address');
  const pub = v.createPublicClient({ chain: arc, transport: transport() });
  if (Number(await pub.getChainId()) !== 5042) throw new Error('RPC is not Arc mainnet');
  const code = await pub.getCode({ address: opAddr });
  if (code && code !== '0x') throw new Error('the operator address has contract code: refusing');
  // Fable review (SHOULD): a run that died between broadcast and record, or a recorder miss, would leave the last refill
  // unrecorded for good while its hash keeps the outflow watch quiet. Catch up: if the last refill's hash has no ledger row
  // and no recorder error row, and it landed, record it now.
  const st0 = readJson(STATE, {});
  if (st0.lastTx) {
    const has = (f) => { try { return fs.readFileSync(f, 'utf8').includes(st0.lastTx); } catch (e) { return false; } };
    if (!has(REC_DIR + '/arc-gas-refill.ndjson') && !has(REC_DIR + '/_errors-arc-gas-refill.ndjson')) {
      const rc = await pub.getTransactionReceipt({ hash: st0.lastTx }).catch(() => null);
      if (rc) {
        const f = await REC.recordSentEvm(st0.lastTx, { source: 'arc-gas-refill', chain: 'arc', wallets: [src.address], expect: { usdc: st0.amount }, category: 'internal:gas-topup', notes: 'receive -> operator (recorded on a later run)' });
        log({ step: f && f.length ? 'recorded-late' : 'not-recorded', tx: st0.lastTx, amount: st0.amount });
        if (st0.broadcastFailed && rc.status === 'success') {   // it landed after all: the 24 h rule applies to it
          const b = await pub.getBlock({ blockNumber: rc.blockNumber }).catch(() => null);
          const t = b ? new Date(Number(b.timestamp) * 1000).toISOString() : new Date().toISOString();
          fs.writeFileSync(STATE + '.tmp', JSON.stringify({ lastSentAt: t, lastTx: st0.lastTx, amount: st0.amount, landedLate: true }, null, 1)); fs.renameSync(STATE + '.tmp', STATE);
        }
      }
    }
  }
  const opBal = Number(v.formatEther(await pub.getBalance({ address: opAddr })));
  const srcBal = Number(v.formatEther(await pub.getBalance({ address: src.address })));
  const st = readJson(STATE, {});
  const line = 'operator ' + opBal.toFixed(4) + ' USDC (floor ' + FLOOR + '), receive ' + srcBal.toFixed(4) + ' USDC (keeps ' + SOURCE_KEEP + ')';
  const gasPrice = await pub.getGasPrice();
  const gasCost = Number(v.formatEther(gasPrice * 21000n * 2n));   // twice the price, a margin for a moving fee
  const pol = readJson('/etc/apex/send-gate.json', null);
  const capUsdc = pol && pol.senders && pol.senders['arc-gas-refill'] ? pol.senders['arc-gas-refill'].per_tx_usdc : null;
  const p = plan({ opBal, srcBal, gasCost, lastSentAt: st.lastSentAt, now: Date.now(), capUsdc });
  if (p.act === 'none') { console.log('OK   ' + line + ': nothing to do'); return; }
  if (p.act === 'refuse') { log({ step: 'refused', reason: p.reason, opBal, srcBal, lastTx: st.lastTx || null }); console.log('FAIL ' + line + '. ' + p.reason); process.exit(1); }
  const amount = p.amount;
  const req = { source: 'arc-gas-refill', chain: 'arc', chainId: 5042, from: src.address, to: opAddr, usdc: amount, purpose: 'operator gas: under ' + FLOOR + ' USDC' };
  if (DRY) { const why = G.reasons(pol, req, 0); console.log('DRY  ' + line + ': would send ' + amount + ' USDC -> operator; the gate ' + (why.length ? 'would REFUSE: ' + why.join('; ') : 'would allow it (ignoring today\'s total)')); return; }
  const d = G.check(req);
  if (!d.allow) { log({ step: 'gate-denied', amount, reasons: d.reasons }); console.log('FAIL gate denied: ' + d.reasons.join('; ')); process.exit(1); }
  const wal = v.createWalletClient({ chain: arc, transport: transport(), account: src });
  let hash;
  try {
    const value = v.parseEther(String(amount));
    const req2 = await wal.prepareTransactionRequest({ to: opAddr, value, gas: 21000n });
    const signed = await wal.signTransaction(req2);
    hash = v.keccak256(signed);
    fs.writeFileSync(STATE + '.tmp', JSON.stringify({ lastSentAt: new Date().toISOString(), lastTx: hash, amount }, null, 1)); fs.renameSync(STATE + '.tmp', STATE);
    log({ step: 'sent', tx: hash, amount, opBal, srcBal });   // the hash is written before the wait: a slow receipt is not a lost send
    await pub.sendRawTransaction({ serializedTransaction: signed });
  } catch (e) {
    // Fable review MUST 1: a broadcast that threw moved nothing (as far as we can tell): give the day's allowance back and
    // clear lastSentAt, so the 24 h drain rule does not lock out the refill while the operator is dry. If the broadcast lands
    // after all, the worst case is a second refill next run: at most two caps, both receive -> operator.
    G.release(req, (hash ? 'broadcast failed: ' : 'not signed: ') + (e.shortMessage || e.message));
    if (hash) { try { fs.writeFileSync(STATE + '.tmp', JSON.stringify({ lastSentAt: null, lastTx: hash, amount, broadcastFailed: true }, null, 1)); fs.renameSync(STATE + '.tmp', STATE); } catch (_) {} }
    log({ step: 'send-error', tx: hash || null, error: String(e.shortMessage || e.message).slice(0, 200) });
    throw e;
  }
  const flows = await REC.recordSentEvm(hash, { source: 'arc-gas-refill', chain: 'arc', wallets: [src.address], expect: { usdc: amount }, category: 'internal:gas-topup', notes: 'receive -> operator, operator was ' + opBal.toFixed(4) + ' USDC' });
  log({ step: flows && flows.length ? 'recorded' : 'not-recorded', tx: hash, amount });
  console.log('SENT ' + amount + ' USDC receive -> operator, tx ' + hash + (flows && flows.length ? ' (recorded)' : ' (NOT recorded: see data/ledger/_errors-arc-gas-refill.ndjson)'));
})().catch((e) => { console.error('FAIL arc-gas-refill: ' + (e.shortMessage || e.message)); process.exit(1); });
