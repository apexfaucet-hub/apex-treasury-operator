'use strict';
// Runs the parking guard over every USDC vault Circle Earn Kit lists on Arc, for a 0.3 USDC park from a 1.32 USDC
// wallet, and prints one line per vault. The saved output is the record behind LIMITS.md's "Idle float" verdict.
const G = require('../operator/vault-guard.js');
const { earnKitVaults } = require('../operator/vault-check.js');
(async () => {
  const at = new Date().toISOString();
  const list = (await earnKitVaults()).filter((v) => v.assetAddress === G.USDC);
  const rows = [];
  for (const v of list) {
    const d = await G.decidePark({ vault: v.address, amountUsd: 0.3, heldUsd: 0, walletUsd: 1.32 });
    rows.push({ vault: v.address, name: v.name, apy: v.apy, totalAssets: d.chain && d.chain.totalAssets, withdrawableNow: d.chain && d.chain.withdrawableNow,
      withdrawableNowPct: d.chain && d.chain.withdrawableNowPct, earnKitWarnings: v.warnings, guard: d.ok ? 'ALLOWS (economics decided at quote time)' : 'REFUSES', refusals: d.refusals });
  }
  rows.sort((a, b) => (b.totalAssets || 0) - (a.totalAssets || 0));
  console.log(JSON.stringify({ at, amountUsd: 0.3, walletUsd: 1.32, vaults: rows }, null, 1));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
