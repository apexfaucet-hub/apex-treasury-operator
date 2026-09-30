'use strict';
// ACCOUNT LAYER: prices (2026-09-29). Every price is read from a pool in the SAME run as the balances it values, and
// is stored with its method, source pool, reserves / block and time. Nothing here uses the server's XNT oracle
// (xnt-rate.js can label a fallback as live); that oracle is only ever a comparison in tools/account-verify.js.
//
// Two values per holding:
//   spot    pool price x amount
//   liquid  what selling that holding would actually return (constant-product quote on X1; on Arc, only the part of
//           the pool's liquidity that is NOT ours can buy from us, so our own LP adds no liquidity to our own tokens)
const path = require('path');
const svm = require('./chains/svm.js');
const evm = require('./chains/evm.js');
const { openReadOnly } = require('./db.js');

const X1 = {
  WXNT: 'So11111111111111111111111111111111111111112',
  APEX: 'Du6Z596DwGnfUcMSyRHSBQzNybiQKu8GESVfruEv9Jqr',
  USDCX: 'B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq',
  XNT_USD_POOL: 'CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR',   // the pool the server's /api/xnt-price reads
  APEX_XDEX_POOL: 'EaWyxuG2H81UCk38gwwxwfupTBJgS66diDiJE9bFqzeR',
  XDEX_PROGRAM: 'sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN',
  AMM_PROGRAM: '5bbBHcvBiabQuZgeM6J5jmypyPri6uXWCXjk1CNUimj9',
};
const ARC = {
  APEX: '0x59933f316417c89d9dc5107b30f08c99b774ea9d', APEX_DEC: 9,
  APEX_POOL: '0xcdf5b51387e17311af6abfad3aabe27b536090a60dafa35a043efea3a386fa04',
  STATE_VIEW: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b', POSM: '0x6049c9a0e26405C0985f9E3685C87d0aE917f82B',
  USDC_VIEW: '0x3600000000000000000000000000000000000000',
  EURC: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
};
const BASE = { WETH: '0x4200000000000000000000000000000000000006', USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', V3_FACTORY: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' };
const SOL = { USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };

const b58 = (buf) => require('/root/apex-faucet/node_modules/bs58').encode(buf);
const ui = (raw, dec) => Number(BigInt(raw)) / 10 ** dec;

// Constant-product quote: selling `amount` of a token into a pool with reserves (tokenReserve, otherReserve).
function cpSell(amount, tokenReserve, otherReserve, fee) {
  const a = amount * (1 - (fee || 0.003));
  return otherReserve * a / (tokenReserve + a);
}

// XDEX pool account layout (verified in server.js and treasury-nav): vault0 @72, vault1 @104, mint0 @168, mint1 @200.
async function xdexPool(poolAddr) {
  const acc = await svm.accountData('x1', poolAddr);
  const d = acc.data;
  const v0 = b58(d.slice(72, 104)), v1 = b58(d.slice(104, 136)), m0 = b58(d.slice(168, 200)), m1 = b58(d.slice(200, 232));
  const r0 = await svm.tokenAccountRaw('x1', v0), r1 = await svm.tokenAccountRaw('x1', v1);
  return { pool: poolAddr, mint0: m0, mint1: m1, reserve0: ui(r0.raw, r0.decimals), reserve1: ui(r1.raw, r1.decimals), slot: acc.slot, url: acc.url };
}

async function x1Prices() {
  const at = new Date().toISOString();
  const out = { at, records: [] };
  const xp = await xdexPool(X1.XNT_USD_POOL);
  const usdcIs0 = xp.mint0 === X1.USDCX;
  if (!usdcIs0 && xp.mint1 !== X1.USDCX) throw new Error('XNT/USD pool no longer holds USDC.X');
  const usdc = usdcIs0 ? xp.reserve0 : xp.reserve1, xnt = usdcIs0 ? xp.reserve1 : xp.reserve0;
  out.xntUsd = usdc / xnt;
  out.xntPool = { usdc, xnt };
  out.records.push({ asset_id: 'x1:native', method: 'spot', usd: out.xntUsd, source: 'x1:xdex ' + X1.XNT_USD_POOL + ' USDC.X/WXNT reserves',
    source_detail: { usdcx: usdc, xnt, slot: xp.slot }, flags: ['usdcx-at-par'].concat(usdc < 500 ? ['thin'] : []) });
  out.records.push({ asset_id: 'x1:' + X1.WXNT, method: 'spot', usd: out.xntUsd, source: 'same as x1:native (wrapped XNT)', source_detail: { slot: xp.slot }, flags: [] });
  out.records.push({ asset_id: 'x1:' + X1.USDCX, method: 'par', usd: 1, source: 'par (bridged USDC.X assumed 1.00)', source_detail: {}, flags: ['bridged'] });
  const ap = await xdexPool(X1.APEX_XDEX_POOL);
  const apexIs0 = ap.mint0 === X1.APEX;
  const apexR = apexIs0 ? ap.reserve0 : ap.reserve1, xntR = apexIs0 ? ap.reserve1 : ap.reserve0;
  out.apexPool = { apex: apexR, xnt: xntR, fee: 0.003 };
  out.apexUsd = (xntR / apexR) * out.xntUsd;
  out.records.push({ asset_id: 'x1:' + X1.APEX, method: 'spot', usd: out.apexUsd, source: 'x1:xdex ' + X1.APEX_XDEX_POOL + ' APEX/WXNT reserves x XNT/USD',
    source_detail: { apex: apexR, xnt: xntR, slot: ap.slot }, flags: [] });
  // LP mints of our two XNT/APEX pools, so LP tokens are valued as what they can be withdrawn for.
  const PK = require('/root/apex-faucet/node_modules/@solana/web3.js').PublicKey;
  const [xdexLp] = PK.findProgramAddressSync([Buffer.from('pool_lp_mint'), new PK(X1.APEX_XDEX_POOL).toBuffer()], new PK(X1.XDEX_PROGRAM));
  const [ammPool] = PK.findProgramAddressSync([Buffer.from('pool'), new PK(X1.WXNT).toBuffer(), new PK(X1.APEX).toBuffer()], new PK(X1.AMM_PROGRAM));
  const [ammLp] = PK.findProgramAddressSync([Buffer.from('lp_mint'), ammPool.toBuffer()], new PK(X1.AMM_PROGRAM));
  const rpc = require('./rpc.js');
  const supply = async (m) => { const r = await rpc.call('x1', 'getTokenSupply', [m, { commitment: 'finalized' }]); return ui(r.result.value.amount, r.result.value.decimals); };
  const ammAcc = await svm.accountData('x1', ammPool.toBase58());
  const ammXnt = await svm.tokenAccountRaw('x1', b58(ammAcc.data.slice(72, 104))), ammApex = await svm.tokenAccountRaw('x1', b58(ammAcc.data.slice(104, 136)));
  out.lp = {
    [xdexLp.toBase58()]: { name: 'XDEX APEX/XNT LP', supply: await supply(xdexLp.toBase58()), xnt: xntR, apex: apexR },
    [ammLp.toBase58()]: { name: 'APEX AMM LP', supply: await supply(ammLp.toBase58()), xnt: ui(ammXnt.raw, ammXnt.decimals), apex: ui(ammApex.raw, ammApex.decimals) },
  };
  return out;
}

// Deepest indexed XNT pool per mint from screener.db (reserves as last indexed; flagged "indexed", not chain-read).
async function screenerPools(mints) {
  const out = new Map();
  const valid = [...new Set(mints)].filter((m) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m));
  if (!valid.length) return out;
  const db = require('./extract.js').open();   // WXNT pools copied from screener.db into the extract (review A1)
  try {
    for (let i = 0; i < valid.length; i += 200) {
      const list = valid.slice(i, i + 200);
      const ph = list.map(() => '?').join(',');
      const rows = await db.all('SELECT token_a_mint a, token_b_mint b, reserve_a ra, reserve_b rb, fee_rate fee, token_a_symbol sa, token_b_symbol sb, last_updated upd FROM pools '
        + 'WHERE (token_a_mint = ? AND token_b_mint IN (' + ph + ')) OR (token_b_mint = ? AND token_a_mint IN (' + ph + '))', [X1.WXNT, ...list, X1.WXNT, ...list]);
      for (const r of rows) {
        const aIsX = r.a === X1.WXNT, mint = aIsX ? r.b : r.a;
        const x = Number(aIsX ? r.ra : r.rb), y = Number(aIsX ? r.rb : r.ra);
        if (!(x > 0) || !(y > 0)) continue;
        const prev = out.get(mint);
        if (!prev || x > prev.x) out.set(mint, { x, y, fee: Number(r.fee) > 0 && Number(r.fee) < 1 ? Number(r.fee) : 0.003, symbol: aIsX ? r.sb : r.sa, updated: r.upd });
      }
    }
  } finally { await db.close(); }
  return out;
}

// USD per token from a v4 sqrtPriceX96, given which side is USDC and both decimals.
function v4UsdPerToken(sqrtPriceX96, usdcIs0, usdcDec, tokenDec) {
  const p = (Number(sqrtPriceX96) / 2 ** 96) ** 2;           // token1 raw per token0 raw
  const perToken = usdcIs0 ? (1 / p) * 10 ** (tokenDec - usdcDec) : p * 10 ** (tokenDec - usdcDec);
  return perToken;
}

async function arcApexPrice(block) {
  const s = await evm.v4Slot0('arc', ARC.STATE_VIEW, ARC.APEX_POOL, block);
  // currency0 = native USDC (18 decimals), currency1 = APEX (9 decimals).
  const usd = v4UsdPerToken(s.sqrtPriceX96, true, 18, ARC.APEX_DEC);
  return { asset_id: 'arc:' + ARC.APEX, method: 'spot', usd, source: 'arc:v4 pool ' + ARC.APEX_POOL.slice(0, 10) + '... slot0',
    source_detail: { sqrtPriceX96: s.sqrtPriceX96.toString(), tick: s.tick, block: block.toString() }, flags: [] };
}

async function baseEthUsd(block) {
  const s = await evm.v3Slot0('base', BASE.V3_FACTORY, BASE.WETH, BASE.USDC, 500, block);
  // token0 = WETH (18), token1 = USDC (6): USDC per WETH.
  const usd = (Number(s.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** 12;
  return { asset_id: 'base:native', method: 'spot', usd, source: 'base:uniswap v3 WETH/USDC 0.05% ' + s.pool + ' slot0', source_detail: { block: block.toString() }, flags: [] };
}

module.exports = { X1, ARC, BASE, SOL, cpSell, xdexPool, x1Prices, screenerPools, v4UsdPerToken, arcApexPrice, baseEthUsd, ui };
