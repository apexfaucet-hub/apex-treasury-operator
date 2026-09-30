'use strict';
// ACCOUNT LAYER: X1 and Solana balance reads (2026-09-29). Read-only, via lib/account/rpc.js; commitment "finalized";
// every result carries the slot it was read at. Both token programs (SPL Token and Token-2022) are read, because
// treasury-nav found real holdings under both.
const rpc = require('../rpc.js');
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

// Native balance: { raw, decimals: 9, slot, url }
async function nativeBalance(chain, address) {
  const { result, url } = await rpc.call(chain, 'getBalance', [address, { commitment: 'finalized' }]);
  return { raw: String(result.value), decimals: 9, slot: result.context.slot, url };
}

// Every token account of a wallet, summed per mint: [{ mint, raw, decimals, slot, url }]
async function tokenBalances(chain, address) {
  const byMint = new Map();
  let slot = null, url = null;
  for (const programId of TOKEN_PROGRAMS) {
    const r = await rpc.call(chain, 'getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
    slot = Math.max(slot || 0, r.result.context.slot); url = r.url;
    for (const x of r.result.value) {
      const info = x.account.data.parsed.info;
      const ta = info.tokenAmount;
      const prev = byMint.get(info.mint);
      const raw = BigInt(ta.amount) + (prev ? BigInt(prev.raw) : 0n);
      byMint.set(info.mint, { mint: info.mint, raw: raw.toString(), decimals: ta.decimals, program: programId });
    }
  }
  return [...byMint.values()].filter((t) => t.raw !== '0').map((t) => Object.assign(t, { slot, url }));
}

// One specific token account (the faucet pot): { mint, raw, decimals, slot, url }
async function tokenAccount(chain, account) {
  const r = await rpc.call(chain, 'getAccountInfo', [account, { encoding: 'jsonParsed', commitment: 'finalized' }]);
  const info = r.result.value && r.result.value.data && r.result.value.data.parsed && r.result.value.data.parsed.info;
  if (!info || !info.tokenAmount) throw new Error('not a token account: ' + account);
  return { mint: info.mint, raw: String(info.tokenAmount.amount), decimals: info.tokenAmount.decimals, owner: info.owner, slot: r.result.context.slot, url: r.url };
}

async function accountData(chain, address) {
  const r = await rpc.call(chain, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]);
  if (!r.result.value) throw new Error('account not found: ' + address);
  return { data: Buffer.from(r.result.value.data[0], 'base64'), slot: r.result.context.slot, url: r.url };
}

async function tokenAccountRaw(chain, account) {
  const r = await rpc.call(chain, 'getTokenAccountBalance', [account, { commitment: 'finalized' }]);
  return { raw: String(r.result.value.amount), decimals: r.result.value.decimals, slot: r.result.context.slot, url: r.url };
}

module.exports = { nativeBalance, tokenBalances, tokenAccount, accountData, tokenAccountRaw, TOKEN_PROGRAMS };
