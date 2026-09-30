'use strict';
// ARC VAULT CHECK + PARKING GUARD (2026-09-30). Question: "if our operator parks USDC in this vault, can it get it out?"
// Circle's Earn Kit already reports each vault's available liquidity and a low_liquidity warning; that is an API.
// This file reads the same facts from the chain, so the operator's limit does not rest on anyone's API (CLAUDE.md §1).
// On 30 Sep 2026 (02:20-03:00 UTC) the two reads agreed to the last digit on five vaults (Galaxy 0.05, Keyrock 1.958377, Steakhouse 88,614.68).
//
// METHOD
// - Circle Earn Kit (`exploreVaults({chain:'Arc'})`) names the vaults. Its warnings can only make the guard refuse MORE,
//   never allow more.
// - A Morpho Vault V2 keeps some USDC idle and lends the rest through adapters. On chain: totalAssets, the idle balance,
//   each adapter (adapters(i), realAssets()) and the vault's liquidityAdapter.
// - Morpho's public API lists Arc's Morpho Blue markets; for each, the market (supply, borrow) and the adapter's position
//   are read ON CHAIN. An adapter can take out min(what it supplied, the market's free liquidity).
// - withdrawableNow = idle + what the vault's withdraw path can pull now. A V2 withdraw deallocates ONLY from the market
//   named in liquidityData() (abi-encoded MarketParams) through the liquidity adapter, so "now" is idle + min(what that
//   adapter supplied there, that market's free liquidity). Money in the adapter's other markets, and in other adapters,
//   moves only when the vault's allocators move it (or by a forced deallocation that costs a penalty): reported apart,
//   never added to "now". (Fixed 30 Sep: the first version summed every market of the liquidity adapter and overstated
//   Bitwise Premium RWA USDC as 33,746.70 when the chain says 25,589.009387, Earn Kit's figure to the digit.)
//   If liquidityData cannot be read or decoded, nothing is counted from the adapter.
// - `supplied` uses the market's last stored state; realAssets() includes interest accrued since, so the small
//   `notInListedMarkets` remainder is mostly that interest.
// Full utilisation is how lending works. "Locked for now" describes the market, never the borrower or the curator.
const { createPublicClient, http, fallback, parseAbi, formatUnits, decodeAbiParameters, encodeAbiParameters, keccak256 } = require('viem');

const ARC = { id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.beamrpc.com'] } } };
const pub = createPublicClient({ chain: ARC, transport: fallback(['https://rpc.beamrpc.com', 'https://arc.drpc.org', 'https://rpc.mainnet.arc.io'].map((u) => http(u, { timeout: 20000, retryCount: 1 }))) });
const MORPHO_BLUE = '0x34CD04070dD72b14E241112F6d83812Df5Af7fCD';
const V = parseAbi(['function totalAssets() view returns (uint256)', 'function asset() view returns (address)', 'function adaptersLength() view returns (uint256)',
  'function adapters(uint256) view returns (address)', 'function liquidityAdapter() view returns (address)', 'function liquidityData() view returns (bytes)', 'function name() view returns (string)']);
const MARKET_PARAMS = [{ type: 'tuple', components: [{ name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' }, { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' }] }];
// The market a V2 withdraw pulls from: keccak256(abi.encode(MarketParams)) of liquidityData, or null if unreadable.
function liquidityMarketId(data) {
  try {
    if (!data || data === '0x' || data.length < 2 + 64 * 5) return null;
    const [p] = decodeAbiParameters(MARKET_PARAMS, data);
    return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }], [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv])).toLowerCase();
  } catch (_) { return null; }
}
const AD = parseAbi(['function realAssets() view returns (uint256)']);
const E = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
const MB = parseAbi(['function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)']);
const lc = (a) => String(a || '').toLowerCase();

let _vaults = { at: 0, list: null }, _markets = { at: 0, list: null };
async function earnKitVaults() {
  if (_vaults.list && Date.now() - _vaults.at < 10 * 60e3) return _vaults.list;
  const { EarnKit } = require('@circle-fin/earn-kit');
  const r = await new EarnKit().exploreVaults({ chain: 'Arc' });
  _vaults = { at: Date.now(), list: (r.vaults || []).map((v) => ({ address: lc(v.vaultAddress), name: v.name || null, asset: v.asset || null, assetAddress: lc(v.assetAddress), protocol: v.protocol || null,
    apy: v.currentApy != null ? Number(v.currentApy) : null, curator: v.manager ? v.manager.name : null, earnKitAvailable: v.liquidity != null ? Number(v.liquidity) : null,
    warnings: (v.warnings || []).map((w) => w.type + ':' + w.level) })) };
  return _vaults.list;
}
async function morphoMarkets() {
  if (_markets.list && Date.now() - _markets.at < 10 * 60e3) return _markets.list;
  const r = await fetch('https://api.morpho.org/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ query: '{ markets(first: 200, where: { chainId_in: [5042] }) { items { marketId loanAsset { symbol address } collateralAsset { symbol address } } } }' }) });
  const j = await r.json();
  if (!j.data) throw new Error('Morpho market list unreadable');
  _markets = { at: Date.now(), list: j.data.markets.items.map((m) => ({ id: m.marketId, loan: m.loanAsset && m.loanAsset.symbol, collateral: m.collateralAsset && m.collateralAsset.symbol })) };
  return _markets.list;
}

async function checkVault(address) {
  const vault = lc(address);
  const [ta, asset, nA, liqAd, liqData] = await Promise.all([
    pub.readContract({ address: vault, abi: V, functionName: 'totalAssets' }),
    pub.readContract({ address: vault, abi: V, functionName: 'asset' }),
    pub.readContract({ address: vault, abi: V, functionName: 'adaptersLength' }).catch(() => null),
    pub.readContract({ address: vault, abi: V, functionName: 'liquidityAdapter' }).catch(() => null),
    pub.readContract({ address: vault, abi: V, functionName: 'liquidityData' }).catch(() => null)]);
  const liqMarket = liquidityMarketId(liqData);
  if (nA === null) throw new Error('not a Morpho Vault V2 (no adapters()); this check reads V2 vaults');
  const [dec, sym, idle] = await Promise.all([pub.readContract({ address: asset, abi: E, functionName: 'decimals' }), pub.readContract({ address: asset, abi: E, functionName: 'symbol' }).catch(() => '?'),
    pub.readContract({ address: asset, abi: E, functionName: 'balanceOf', args: [vault] })]);
  const f = (x) => Number(formatUnits(x, dec));
  const markets = await morphoMarkets();
  const adapters = [];
  for (let i = 0n; i < nA; i++) {
    const a = lc(await pub.readContract({ address: vault, abi: V, functionName: 'adapters', args: [i] }));
    const real = await pub.readContract({ address: a, abi: AD, functionName: 'realAssets' }).catch(() => null);
    const pos = [];
    for (const m of markets) {
      const p = await pub.readContract({ address: MORPHO_BLUE, abi: MB, functionName: 'position', args: [m.id, a] }).catch(() => null);
      if (!p || p[0] === 0n) continue;
      const mk = await pub.readContract({ address: MORPHO_BLUE, abi: MB, functionName: 'market', args: [m.id] });
      const supplied = mk[1] > 0n ? (p[0] * mk[0]) / mk[1] : 0n, free = mk[0] - mk[2];
      pos.push({ market: m.id, isLiquidityMarket: !!liqMarket && lc(m.id) === liqMarket, pair: (m.loan || '?') + '/' + (m.collateral || '?'), supplied: f(supplied), marketSupply: f(mk[0]), marketBorrow: f(mk[2]), marketFree: f(free),
        utilisationPct: mk[0] > 0n ? Number((mk[2] * 1000000n) / mk[0]) / 10000 : null, withdrawableFromHere: f(supplied < free ? supplied : free) });
    }
    const mapped = pos.reduce((t, x) => t + x.supplied, 0);
    adapters.push({ adapter: a, isLiquidityAdapter: !!liqAd && lc(liqAd) === a, realAssets: real == null ? null : f(real), markets: pos,
      notInListedMarkets: real == null ? null : Math.max(0, f(real) - mapped) });
  }
  const liqAdapter = adapters.find((x) => x.isLiquidityAdapter);
  const nowFromAdapter = liqAdapter ? liqAdapter.markets.filter((x) => x.isLiquidityMarket).reduce((t, x) => t + x.withdrawableFromHere, 0) : 0;
  const forcible = adapters.reduce((t, a) => t + a.markets.filter((x) => !(a.isLiquidityAdapter && x.isLiquidityMarket)).reduce((s, x) => s + x.withdrawableFromHere, 0), 0);
  const total = f(ta), now = f(idle) + nowFromAdapter;
  return {
    ok: true, vault, asset: sym, assetAddress: lc(asset), totalAssets: total, idle: f(idle), liquidityMarket: liqMarket, liquidityAdapter: liqAd && lc(liqAd) !== '0x0000000000000000000000000000000000000000' ? lc(liqAd) : null,
    withdrawableNow: now, withdrawableNowPct: total > 0 ? Math.round((now / total) * 1e6) / 1e4 : null,
    moreOnlyByForcedDeallocation: forcible,
    adapters,
    verdict: total <= 0 ? 'EMPTY' : now / total >= 0.2 ? 'LIQUID' : now / total >= 0.01 ? 'TIGHT' : 'LOCKED FOR NOW',
    meaning: 'withdrawableNow is what a depositor can take out in one transaction at this block. The rest is lent out: it comes back as borrowers repay, and the market\'s rate rises at full utilisation to pull repayments. "Locked for now" describes the market, not the borrower or the curator.',
    method: 'Vault named by Circle Earn Kit; totalAssets, idle balance, adapters, positions and Morpho Blue market supply/borrow read on chain (Arc, Morpho Blue ' + MORPHO_BLUE + '). Markets found through Morpho\'s public API, each one read on chain.',
  };
}

// Idle asset held by the vault itself, read from the chain alone (no API): the floor of what a withdraw can pay.
async function idleOnChain(address) {
  const asset = await pub.readContract({ address: lc(address), abi: V, functionName: 'asset' });
  const [dec, idle] = await Promise.all([pub.readContract({ address: asset, abi: E, functionName: 'decimals' }), pub.readContract({ address: asset, abi: E, functionName: 'balanceOf', args: [lc(address)] })]);
  return Number(formatUnits(idle, dec));
}

async function board() {
  const list = await earnKitVaults();
  const out = [];
  for (const v of list) {
    try { const r = await checkVault(v.address); out.push(Object.assign({ name: v.name, apy: v.apy }, r)); }
    catch (e) { out.push({ ok: false, vault: v.address, name: v.name, error: String(e.shortMessage || e.message).slice(0, 120) }); }
  }
  return out.sort((a, b) => (b.totalAssets || 0) - (a.totalAssets || 0));
}

module.exports = { checkVault, idleOnChain, board, earnKitVaults, morphoMarkets, MORPHO_BLUE };
