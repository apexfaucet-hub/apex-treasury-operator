'use strict';
// ACCOUNT LAYER: Arc and Base reads (2026-09-29). Read-only, via lib/account/rpc.js. Every read of one run is pinned to
// ONE block number, so balances, pool prices and positions describe the same moment and can be re-read exactly by the
// verifier through a different endpoint.
//
// Arc: USDC is the NATIVE coin (18 decimals). The ERC-20 at 0x3600... is a VIEW of the same balance (6 decimals) and is
// never added on top, or every Arc dollar would be counted twice.
const { encodeFunctionData, decodeFunctionResult, parseAbi } = require('/root/apex-faucet/node_modules/viem');
const rpc = require('../rpc.js');

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
const V4_STATE = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)']);
const V4_POSM = parseAbi([
  'function ownerOf(uint256 id) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
]);
const V3_POOL = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)']);
const V3_FACTORY = parseAbi(['function getPool(address,address,uint24) view returns (address)']);

const hexBlock = (n) => '0x' + BigInt(n).toString(16);

async function blockNumber(chain) {
  const { result, url } = await rpc.call(chain, 'eth_blockNumber', []);
  return { block: BigInt(result), url };
}
async function blockTime(chain, block) {
  const { result } = await rpc.call(chain, 'eth_getBlockByNumber', [hexBlock(block), false]);
  return new Date(Number(BigInt(result.timestamp)) * 1000).toISOString();
}
async function nativeBalance(chain, address, block, opts) {
  const { result, url } = await rpc.call(chain, 'eth_getBalance', [address, hexBlock(block)], opts);
  return { raw: BigInt(result).toString(), decimals: 18, url };
}
async function read(chain, to, abi, functionName, args, block, opts) {
  const data = encodeFunctionData({ abi, functionName, args });
  const { result, url } = await rpc.call(chain, 'eth_call', [{ to, data }, hexBlock(block)], opts);
  if (!result || result === '0x') throw new Error(functionName + ' returned nothing at ' + to);
  return { value: decodeFunctionResult({ abi, functionName, data: result }), url };
}
async function erc20Balance(chain, token, holder, block, opts) {
  const r = await read(chain, token, ERC20, 'balanceOf', [holder], block, opts);
  return { raw: r.value.toString(), url: r.url };
}

// Uniswap v4 position: owner, liquidity, pool key and tick range (PositionInfo: tickLower at bits 8..31, tickUpper 32..55).
const int24 = (x) => { const v = Number(x & 0xFFFFFFn); return v >= 0x800000 ? v - 0x1000000 : v; };
async function v4Position(chain, posm, tokenId, block) {
  const owner = (await read(chain, posm, V4_POSM, 'ownerOf', [BigInt(tokenId)], block)).value;
  const liquidity = (await read(chain, posm, V4_POSM, 'getPositionLiquidity', [BigInt(tokenId)], block)).value;
  const [poolKey, info] = (await read(chain, posm, V4_POSM, 'getPoolAndPositionInfo', [BigInt(tokenId)], block)).value;
  return { owner, liquidity, poolKey, tickLower: int24(info >> 8n), tickUpper: int24(info >> 32n) };
}
async function v4Slot0(chain, stateView, poolId, block) {
  const [sqrtPriceX96, tick] = (await read(chain, stateView, V4_STATE, 'getSlot0', [poolId], block)).value;
  return { sqrtPriceX96, tick };
}
async function v3Slot0(chain, factory, tokenA, tokenB, fee, block) {
  const pool = (await read(chain, factory, V3_FACTORY, 'getPool', [tokenA, tokenB, fee], block)).value;
  const [sqrtPriceX96] = (await read(chain, pool, V3_POOL, 'slot0', [], block)).value;
  return { pool, sqrtPriceX96 };
}

// Token amounts held by a concentrated-liquidity position at the current price (standard v3/v4 maths, floats: this is a
// valuation, not a settlement; the method is labelled "v4-liquidity-math").
function positionAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper) {
  const Q = 2 ** 96;
  const L = Number(liquidity), sp = Number(sqrtPriceX96) / Q;
  const sa = Math.sqrt(Math.pow(1.0001, tickLower)), sb = Math.sqrt(Math.pow(1.0001, tickUpper));
  if (sp <= sa) return { raw0: L * (sb - sa) / (sa * sb), raw1: 0 };
  if (sp >= sb) return { raw0: 0, raw1: L * (sb - sa) };
  return { raw0: L * (sb - sp) / (sp * sb), raw1: L * (sp - sa) };
}

module.exports = { blockNumber, blockTime, nativeBalance, erc20Balance, read, v4Position, v4Slot0, v3Slot0, positionAmounts, hexBlock, ERC20 };
