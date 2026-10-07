#!/usr/bin/env node
'use strict';
// YIELD ON ARC, HONESTLY (2026-10-07, Martin: "turn everything we have into a service"). Every lending vault Circle's Earn Kit
// lists on Arc (Morpho Vault V2: Galaxy, Keyrock, Steakhouse, Gauntlet, Bitwise...), with what matters before you deposit:
// the rate (Circle's figure, a lending rate, not a promise), the size and HOW MUCH CAN BE TAKEN OUT RIGHT NOW, read on chain
// by core/arc/vault-check.js (idle + the liquidity market's free supply; the rest waits for borrowers to repay).
//   - data/protected/arc-yield.json   the full board: per vault its adapters and markets (pair, utilisation, free supply) and a
//                                      24 h trail of what could be withdrawn: the paid feed /api/x402/arc-yield (never under public/)
//   - public/arc/earn/index.html      the free page: the board, and the reader for your own positions
// A vault that cannot be read is shown as unreadable, never as empty. A board with no readable vault is not written at all.
// Usage: node tools/arc-yield.js     (timer apex-arc-yield, every 15 min)
const fs = require('fs');
const path = require('path');
const VC = require('/home/claudeuser/core/arc/vault-check.js');

const FULL = '/root/apex-faucet/data/protected/arc-yield.json';
const TRAIL = '/root/apex-faucet/data/protected/arc-yield-trail.json';
const PAGE = process.env.EARN_PAGE_OUT || '/root/apex-faucet/public/arc/earn/index.html';   // EARN_PAGE_OUT: tests write elsewhere
const TRAIL_MS = 24 * 3600e3;
const SEEN = '/root/apex-faucet/data/arc-yield-vaults-seen.json';   // every USDC vault ever verified here: positions stay reachable if a vault leaves the board
// Deposits and withdrawals from the visitor's own wallet (public/arc/earn/earn.js). Off until reviewed; the read-only positions work either way.
const EARN_ON = process.env.EARN_ON_TEST === '0' ? false : true;   // reviewed 7 Oct (round trip 0x45efa1e0/0x763f53ca, 19 encodings, fake-wallet UI test)

const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usd = (n) => (n == null ? '?' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3).toLocaleString('en-US') + 'k' : '$' + n.toFixed(2));
const pct = (a) => (a == null ? '?' : (a * 100).toFixed(2) + '%');

async function main() {
  const list = await VC.earnKitVaults();
  const rows = [];
  for (const v of list) {
    let r; try { r = await VC.checkVault(v.address); } catch (e) { r = { ok: false, error: String(e.shortMessage || e.message).slice(0, 140) }; }
    rows.push({ name: v.name, address: v.address, curator: v.curator, protocol: v.protocol, asset: v.asset || r.asset || null, assetAddress: v.assetAddress || r.assetAddress || null,
      apy: v.apy, apySource: 'Circle Earn Kit currentApy (a lending rate that moves with borrowing, not a promise)', earnKitWarnings: v.warnings, earnKitAvailable: v.earnKitAvailable,
      ok: r.ok !== false, error: r.error || null, totalAssets: r.totalAssets ?? null, idle: r.idle ?? null, withdrawableNow: r.withdrawableNow ?? null, withdrawableNowPct: r.withdrawableNowPct ?? null,
      verdict: r.verdict || null, liquidityMarket: r.liquidityMarket || null, liquidityAdapter: r.liquidityAdapter || null, moreOnlyByForcedDeallocation: r.moreOnlyByForcedDeallocation ?? null, adapters: r.adapters || [] });
  }
  const readable = rows.filter((r) => r.ok && r.totalAssets != null);
  if (!readable.length) throw new Error('no vault could be read: board not written (a failed read is not an empty board)');
  rows.sort((a, b) => (b.totalAssets || 0) - (a.totalAssets || 0));

  // 24 h trail of what could be withdrawn, per vault
  let trail = {}; try { trail = JSON.parse(fs.readFileSync(TRAIL, 'utf8')); } catch (e) {}
  const now = Date.now();
  for (const r of readable) { const t = (trail[r.address] || []).filter((x) => now - x[0] < TRAIL_MS); t.push([now, +r.withdrawableNow.toFixed(6), +r.totalAssets.toFixed(2), r.apy]); trail[r.address] = t; }
  for (const k of Object.keys(trail)) if (!readable.find((r) => r.address === k)) trail[k] = trail[k].filter((x) => now - x[0] < TRAIL_MS);
  fs.writeFileSync(TRAIL + '.tmp', JSON.stringify(trail)); fs.renameSync(TRAIL + '.tmp', TRAIL);

  const usdc = readable.filter((r) => r.asset === 'USDC');
  const totals = { vaults: rows.length, readable: readable.length, usdcInVaults: usdc.reduce((t, r) => t + r.totalAssets, 0), usdcWithdrawableNow: usdc.reduce((t, r) => t + r.withdrawableNow, 0) };
  const exitable = usdc.filter((r) => r.withdrawableNow >= 1000 && r.apy != null).sort((a, b) => b.apy - a.apy)[0] || null;
  const out = {
    at: new Date().toISOString(), chain: 'arc', chainId: 5042, totals,
    bestRateYouCanExit: exitable ? { name: exitable.name, address: exitable.address, apy: exitable.apy, withdrawableNow: exitable.withdrawableNow } : null,
    vaults: rows.map((r) => Object.assign({}, r, { trail24h: (trail[r.address] || []).map((x) => ({ at: new Date(x[0]).toISOString(), withdrawableNow: x[1], totalAssets: x[2], apy: x[3] })) })),
    centrifuge: 'Centrifuge tokenized funds (JTRSY US Treasuries, JAAA AAA CLOs, HYB high-yield bonds) arrived on Arc in early October 2026; Centrifuge restricts direct access to non-US professional investors, so they are not listed here and their contracts are not read by us.',
    meaning: 'withdrawableNow is what a depositor can take out in one transaction at this block: the vault\'s idle USDC plus the free supply of the one market its withdraw path draws from. The rest is lent to borrowers and comes back as they repay; at full use the market\'s rate rises to pull repayments. It describes the market, never the curator or the borrowers.',
    method: 'Vaults named by Circle Earn Kit (exploreVaults, Arc). totalAssets, idle balance, adapters, positions and Morpho Blue market supply/borrow read on chain at Morpho Blue ' + VC.MORPHO_BLUE + '. Rates are Circle\'s figures. Refreshed every 15 minutes.',
  };
  fs.writeFileSync(FULL + '.tmp', JSON.stringify(out, null, 1)); fs.renameSync(FULL + '.tmp', FULL);
  writePage(out);
  console.log('[arc-yield] ' + readable.length + '/' + rows.length + ' vaults read; USDC in vaults ' + Math.round(totals.usdcInVaults) + ', withdrawable now ' + Math.round(totals.usdcWithdrawableNow));
}

function writePage(B) {
  const navVer = (fs.readFileSync('/root/apex-faucet/public/index.html', 'utf8').match(/nav-v2\.js\?v=(r\d+)/) || [])[1] || 'r242';
  const shellSrc = fs.readFileSync('/root/apex-faucet/public/arc/graveyard/index.html', 'utf8');
  const shellHead = shellSrc.slice(shellSrc.indexOf('<head>') + 6, shellSrc.indexOf('<meta charset'));
  const T = B.totals, best = B.bestRateYouCanExit;
  const shown = B.vaults.filter((v) => v.ok && v.totalAssets != null && v.totalAssets >= 1);
  const bad = B.vaults.filter((v) => !v.ok);
  const title = 'Yield on Arc, honestly: every vault and what you can take out today';
  const desc = usd(T.usdcInVaults) + ' of USDC sits in ' + T.vaults + ' lending vaults on Arc; ' + usd(T.usdcWithdrawableNow) + ' of it can be withdrawn right now. Rates, sizes and real exit liquidity, read on chain every 15 minutes.';
  const vaultList = shown.filter((v) => v.assetAddress === '0x3600000000000000000000000000000000000000').map((v) => ({ a: v.address, n: v.name, c: v.curator, out: +(v.withdrawableNow || 0).toFixed(2), apy: v.apy, warn: v.earnKitWarnings || [], verdict: v.verdict }));
  const isUsdc = (v) => v.assetAddress === '0x3600000000000000000000000000000000000000';
  let seen = {}; try { seen = JSON.parse(fs.readFileSync(SEEN, 'utf8')); } catch (e) {}
  for (const v of B.vaults) if (v.ok && isUsdc(v) && !seen[v.address]) seen[v.address] = { n: v.name, c: v.curator, firstSeen: B.at };
  if (!process.env.EARN_PAGE_OUT) { fs.writeFileSync(SEEN + '.tmp', JSON.stringify(seen, null, 1)); fs.renameSync(SEEN + '.tmp', SEEN); }
  const seenList = Object.entries(seen).map(([a, x]) => ({ a, n: x.n, c: x.c }));
  const table = shown.map((v) => '<tr><td><b>' + esc(v.name) + '</b><br><span class="soft">' + esc(v.curator || '') + ' · ' + esc(v.asset || '') + '</span>' + (EARN_ON && isUsdc(v) ? '<br><button type="button" class="pb dep" data-v="' + esc(v.address) + '">Deposit</button>' : '') + '</td><td>' + pct(v.apy) + '</td><td>' + usd(v.totalAssets) + '</td><td><b>' + usd(v.withdrawableNow) + '</b><br><span class="soft">' + (v.withdrawableNowPct != null ? v.withdrawableNowPct + '%' : '') + '</span></td><td>' + esc(v.verdict || '') + '</td></tr>').join('\n');
  const html = `<!-- Built by APEXfaucet - generated every 15 minutes by tools/arc-yield.js from Circle Earn Kit and the Arc chain -->
<!DOCTYPE html>
<html lang="en">
<head>${shellHead}<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0b0b0b">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://apexfaucet.xyz/arc/earn/">
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=neon3">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="https://apexfaucet.xyz/arc/earn/"><meta property="og:type" content="website"><meta property="og:site_name" content="APEX Faucet">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}">
<style>
  .ex{max-width:880px;margin:0 auto;padding:84px 16px 80px;color:#3b2d0c;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  html:not([data-theme="light"]) .ex{color:#F3E6CF}
  .ex h1{font-size:clamp(25px,5vw,38px);line-height:1.12;margin:0 0 12px;color:inherit}
  .ex h2{font-size:19px;margin:28px 0 10px;color:inherit}
  .ex .kick{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:3px;text-transform:uppercase;color:#7A5A00;margin-bottom:10px}
  html:not([data-theme="light"]) .ex .kick{color:#F1DB93}
  .ex .soft{font-size:13px;color:#6F5725}
  html:not([data-theme="light"]) .ex .soft{color:#CDBFA6}
  .ex a{color:#8A5A00}
  html:not([data-theme="light"]) .ex a{color:#F1DB93}
  .warn{border:2px dashed #B8912F;border-radius:18px;padding:16px;margin:0 0 16px}
  .warn .st{font-size:clamp(18px,4.4vw,24px);font-weight:800;margin:0 0 6px;color:inherit}
  .facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 12px}
  .f{padding:14px;border:1px solid #D2BD8A;border-radius:16px;background:#FFFCF5}
  html:not([data-theme="light"]) .f{background:#17131A;border-color:#4A3A3D}
  .f b{display:block;font-size:22px;line-height:1.2;color:inherit}
  .f span{font-size:13px;color:#6F5725}
  html:not([data-theme="light"]) .f span{color:#CDBFA6}
  .tw{overflow-x:auto}
  .ex table{width:100%;border-collapse:collapse;font-size:14px}
  .ex td,.ex th{text-align:left;padding:7px 5px;border-bottom:1px solid rgba(160,130,60,.35);color:inherit;vertical-align:top}
  .pay{padding:14px 16px;border:1px solid #B8912F;border-radius:16px;margin:22px 0 8px}
  #pos{padding:14px 16px;border:1px solid #D2BD8A;border-radius:16px;margin:10px 0}
  html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .ex button.pb{all:unset;box-sizing:border-box!important;cursor:pointer!important;background:#e7c766!important;color:#15110e!important;-webkit-text-fill-color:#15110e!important;border-radius:10px!important;padding:10px 16px!important;font-weight:700!important}
</style>
</head>
<body>
<main class="ex">
  <div class="kick">Arc · lending vaults · read from the chain</div>
  <h1>Yield on Arc, honestly</h1>
  <section class="warn" data-keep-color>
    <p class="st">${usd(T.usdcInVaults)} of USDC sits in ${T.vaults} lending vaults on Arc. <b>${usd(T.usdcWithdrawableNow)}</b> of it can be taken out right now.</p>
    <p style="margin:0 0 6px">The rest is lent to borrowers who put up Bitcoin and comes back as they repay. Before you deposit anywhere, look at "Out now": what a depositor could withdraw at this block. "Show my positions" reads your wallet's vault shares; nothing is signed.</p>
    <p style="margin:8px 0"><button type="button" class="pb" id="posgo">Show my positions</button> &nbsp;<a href="#vaults">See every vault</a></p>
    <div id="posout" class="soft" style="margin:0 0 8px"></div>
    <p class="soft" style="margin:0">Checked <time data-ts="${Math.floor(Date.parse(B.at) / 1000)}">${esc(B.at.slice(0, 16).replace('T', ' '))} UTC</time>, every 15 minutes. Rates are Circle's figures: lending rates that move with borrowing, not promises.</p>
  </section>
  <div class="facts">
    <div class="f"><b>${T.vaults}</b><span>vaults listed by Circle on Arc</span></div>
    <div class="f"><b>${usd(T.usdcInVaults)}</b><span>USDC in them (on chain)</span></div>
    <div class="f"><b>${usd(T.usdcWithdrawableNow)}</b><span>could be withdrawn right now</span></div>
    ${best ? '<div class="f"><b>' + pct(best.apy) + '</b><span>best rate on a vault with $1k+ to take out now (' + esc(best.name) + ')</span></div>' : ''}
  </div>
  <h2 id="vaults">Every vault</h2>
  <div class="tw"><table><tr><th>Vault</th><th>Rate</th><th>Size</th><th>Out now</th><th>State</th></tr>
${table}
  </table></div>
  <div id="dep" class="pay" style="display:none" data-keep-color><div class="dv"></div><p style="margin:8px 0"><input class="damt" inputmode="decimal" placeholder="USDC amount, e.g. 5" style="padding:9px;border-radius:10px;border:1px solid #B8912F;width:11em;max-width:100%"> <button type="button" class="pb dmax">Max</button> <button type="button" class="pb dgo">Deposit from my wallet</button></p><p class="soft" id="earnme" style="margin:0"></p><p class="dmsg" style="margin:6px 0 0"></p><p class="soft" style="margin:6px 0 0">You deposit into the curator's Morpho vault directly from your wallet: two confirmations (allow exactly this amount, then deposit). We never hold your money and take no fee.</p></div>
  ${bad.length ? '<p class="soft">' + bad.length + ' vault(s) could not be read this round; that says nothing about their money.</p>' : ''}
  <p class="soft">State: LIQUID = 20%+ can come out now, TIGHT = 1-20%, LOCKED FOR NOW = under 1%. It describes the lending market, never the vault's manager or its borrowers. Vaults under $1 are left out.</p>
  <h2>Tokenized funds</h2>
  <p>${esc(B.centrifuge)}</p>
  <div class="pay"><b>For agents and treasuries:</b> every vault with where its money is lent (each market, its use and free supply), a 24-hour trail of what could be withdrawn, and Circle's rate, as JSON: <code>GET /api/x402/arc-yield</code>, $0.003 per call over x402 (USDC on Arc, Base or Solana).</div>
  <p class="soft">How: ${esc(B.method)}</p>
</main>
<script>
(function(){ try { var o={day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'};
  document.querySelectorAll('time[data-ts]').forEach(function(t){ t.title=t.textContent; t.textContent=new Date(Number(t.getAttribute('data-ts'))*1000).toLocaleString(undefined,o); }); } catch(e) {} })();
</script>
<script>window.EARN_VAULTS=${JSON.stringify(vaultList)};window.EARN_SEEN=${JSON.stringify(seenList)};window.EARN_ON=${EARN_ON ? 'true' : 'false'};</script>
<script src="/arc/earn/earn.js?v=2" defer></script>
<script src="/nav-v2.js?v=${navVer}"></script>
</body>
</html>
`;
  fs.mkdirSync(path.dirname(PAGE), { recursive: true });
  fs.writeFileSync(PAGE + '.tmp', html); fs.renameSync(PAGE + '.tmp', PAGE);
}

main().catch((e) => { console.error('[arc-yield] failed: ' + (e.shortMessage || e.message)); process.exitCode = 1; });
