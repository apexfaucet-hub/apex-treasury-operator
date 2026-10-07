'use strict';
// THE OPERATOR'S HOUR (2026-10-07). Once an hour the treasury decides, on its own, what to do with its idle USDC on Arc:
//   - if it holds a position in any Earn Kit vault: run park-float.js `check` (the exit rule: withdraw what it can if the vault
//     stopped being safe);
//   - otherwise: find the best-paying USDC vault that vault-guard.js allows for the amount it could park, and run park-float.js
//     `park` there. park-float applies the rest (the books must be sure, the economics must pay for the gas, the central send
//     gate, the transaction-shape gate) and refuses if anything fails.
// Every hour's decision is written down with its reasons (TICK_LOG, and TICK_LATEST for the page), including "did nothing".
// Env: PARK_KEY, PARK_LEDGER, ACCOUNT_SUMMARY, SEND_GATE_LIB (all passed through to park-float.js), TICK_LOG, TICK_LATEST.
// Usage: node operator/treasury-tick.js [--live]      (without --live every step is a dry run)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const V = require('viem');
const G = require('./vault-guard.js');
const { earnKitVaults } = require('./vault-check.js');

const LIVE = process.argv.includes('--live');
const TICK_LOG = process.env.TICK_LOG || path.join(__dirname, '..', 'data', 'treasury-ticks.ndjson');
const TICK_LATEST = process.env.TICK_LATEST || null;
const RPC = 'https://rpc.mainnet.arc.io';
const pub = V.createPublicClient({ transport: V.fallback(['https://rpc.blockdaemon.mainnet.arc.io', RPC].map((u) => V.http(u, { timeout: 20000 }))) });
const VA = V.parseAbi(['function balanceOf(address) view returns (uint256)', 'function convertToAssets(uint256) view returns (uint256)']);
const GAS_KEEP = 0.05;

function parkFloat(args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'park-float.js'), ...args, ...(LIVE ? ['--live'] : [])], { env: process.env, encoding: 'utf8', timeout: 600000 });
  const lines = String(r.stdout || '').trim().split('\n');
  let last = null; for (let i = lines.length - 1; i >= 0 && !last; i--) { try { const j = JSON.parse(lines[i]); if (j && j.mode) last = j; } catch (_) {} }
  return { code: r.status, record: last, tail: lines.slice(-4).join(' | ').slice(0, 600), err: String(r.stderr || '').slice(0, 300) };
}

async function main() {
  const k = JSON.parse(fs.readFileSync(process.env.PARK_KEY, 'utf8'));
  const me = V.getAddress(k.address);
  const out = { at: new Date().toISOString(), live: LIVE, wallet: me };
  const walletUsd = Number(V.formatUnits(await pub.getBalance({ address: me }), 18));
  out.walletUsd = +walletUsd.toFixed(6);
  const vaults = (await earnKitVaults()).filter((v) => v.assetAddress === G.USDC);
  const held = [];
  for (const v of vaults) {
    const sh = await pub.readContract({ address: v.address, abi: VA, functionName: 'balanceOf', args: [me] }).catch(() => 0n);
    if (sh > 0n) { const a = await pub.readContract({ address: v.address, abi: VA, functionName: 'convertToAssets', args: [sh] }); held.push({ vault: v.address, name: v.name, usdc: Number(V.formatUnits(a, 6)) }); }
  }
  out.held = held;
  if (held.length) {
    out.decision = 'checked positions';
    out.results = held.map((h) => Object.assign({ vault: h.vault, name: h.name }, parkFloat(['check', h.vault])));
  } else {
    const amount = Math.floor(Math.min(G.LIMITS.MAX_PARK_USD, walletUsd - G.LIMITS.RESERVE_USD - GAS_KEEP) * 100) / 100;
    out.amountUsd = amount;
    if (!(amount >= G.LIMITS.MIN_PARK_USD)) {
      out.decision = 'nothing to park';
      out.why = 'wallet holds ' + walletUsd.toFixed(4) + ' USDC; it keeps ' + G.LIMITS.RESERVE_USD + ' in reserve plus gas, which leaves less than ' + G.LIMITS.MIN_PARK_USD;
    } else {
      const ranked = vaults.filter((v) => v.apy != null).sort((a, b) => b.apy - a.apy);
      out.considered = [];
      let pick = null;
      for (const v of ranked) {
        const d = await G.decidePark({ vault: v.address, amountUsd: amount, heldUsd: 0, walletUsd });
        out.considered.push({ vault: v.address, name: v.name, apy: v.apy, allowed: d.ok, refusals: d.refusals, withdrawableNow: d.chain ? +Number(d.chain.withdrawableNow).toFixed(2) : null, withdrawableNowPct: d.chain ? d.chain.withdrawableNowPct : null });
        if (d.ok) { pick = v; break; }
      }
      if (!pick) { out.decision = 'stayed in the wallet'; out.why = 'no vault passes the guard for ' + amount + ' USDC'; }
      else {
        const r = parkFloat(['park', pick.address, String(amount)]);
        out.decision = r.code === 0 ? 'parked' : 'park refused';
        out.vault = { address: pick.address, name: pick.name, apy: pick.apy };
        out.result = r;
        if (r.code !== 0) out.why = r.record && r.record.refused ? r.record.refused.join(' | ') : r.tail;
      }
    }
  }
  fs.mkdirSync(path.dirname(TICK_LOG), { recursive: true });
  fs.appendFileSync(TICK_LOG, JSON.stringify(out) + '\n');
  if (TICK_LATEST) { fs.writeFileSync(TICK_LATEST + '.tmp', JSON.stringify(out, null, 1)); fs.renameSync(TICK_LATEST + '.tmp', TICK_LATEST); }
  console.log('[treasury-tick] ' + out.decision + (out.why ? ': ' + out.why : '') + ' | wallet ' + out.walletUsd + ' USDC, held ' + held.length);
}
main().catch((e) => { console.error('[treasury-tick] failed: ' + (e.shortMessage || e.message)); process.exitCode = 1; });
