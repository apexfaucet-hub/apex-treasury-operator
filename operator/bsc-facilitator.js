'use strict';
// SELF-FACILITATOR FOR STANDARD x402 ON BNB SMART CHAIN (2026-10-06, Martin: "we have to get on BNB")
//
// Same shape as arc-facilitator.js (verify / settle, same failure reasons). On BNB Chain two dollar coins carry EIP-3009
// (transferWithAuthorization), so a standard x402 client can pay with a signature and we settle it, paying the BNB gas
// (~91,000 gas at 0.05 gwei, about $0.0036 a settlement on 6 Oct). Read on chain 6 Oct (research/bnb-rail-2026-10-06.md):
//   USD1 0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d  name "World Liberty Financial USD", signing version "1", 18 decimals.
//        TRAP: its version() returns 2 (the upgrade version); eip712Domain() says "1" and DOMAIN_SEPARATOR() matches "1".
//   U    0xcE24439F2D9C6a2289F741120FE202248B666666  name "United Stables", version "1" (no version() exists; the
//        separator recomputed with "1" matches DOMAIN_SEPARATOR()), 18 decimals. Address from Binance's docs.
// USDT and Binance-Peg USDC on BNB have NO EIP-3009; they need Permit2 (Binance's own facilitator, after registration).
// The DOMAINS below are re-proven against DOMAIN_SEPARATOR() at boot (selfCheck) and a token whose separator does not match
// is not offered: a wrong domain would make every buyer's signature fail.
// Gas is paid by the Arc operator key on BNB (address 0x024b…, a separate balance in BNB). Money lands on our receive
// address 0xd334… on BNB. Before settling, the payer's token balance is read: a signature from an empty wallet would
// only burn our gas (Fable review, 6 Oct).
const fs = require('fs'); const path = require('path');
const { createPublicClient, createWalletClient, http, fallback, defineChain, parseAbi, verifyTypedData, getAddress, hexToSignature, domainSeparator } = require('/root/apex-faucet/node_modules/viem');
const { privateKeyToAccount } = require('/root/apex-faucet/node_modules/viem/accounts');

const CHAIN_ID = 56;
const NETWORK = 'eip155:56';
const bsc = defineChain({ id: CHAIN_ID, name: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: ['https://bsc-dataseed.bnbchain.org'] } } });
const RPCS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io', 'https://bsc.publicnode.com'];
const transport = () => fallback(RPCS.map((u) => http(u, { timeout: 15000, retryCount: 1 })), { rank: false });
const pub = createPublicClient({ chain: bsc, transport: transport() });

const TOKENS = {
  USD1: { address: getAddress('0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d'), decimals: 18, domain: { name: 'World Liberty Financial USD', version: '1', chainId: CHAIN_ID } },
  U: { address: getAddress('0xcE24439F2D9C6a2289F741120FE202248B666666'), decimals: 18, domain: { name: 'United Stables', version: '1', chainId: CHAIN_ID } },
};
for (const t of Object.values(TOKENS)) t.domain.verifyingContract = t.address;
const MIN_USD = 0.01;   // gas is ~$0.0036 a settlement: under a cent, a payment would mostly pay our gas

const abi = parseAbi([
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
]);
const TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] };

function operator() { try { return privateKeyToAccount(JSON.parse(fs.readFileSync(path.join(__dirname, 'keys', 'arc-operator.json'), 'utf8')).privateKey); } catch (e) { return null; } }
function receiveAddress() { try { return getAddress(JSON.parse(fs.readFileSync(path.join(__dirname, 'keys', 'arc-receive.json'), 'utf8')).address); } catch (e) { return null; } }
const tokenByAddress = (a) => { try { const g = getAddress(a); return Object.entries(TOKENS).find(([, t]) => t.address === g) || null; } catch (e) { return null; } };
// the amount a price asks for, in the token's 18-decimal units, never under MIN_USD
function units(usd) { const u = Math.max(Number(usd) || 0, MIN_USD); return BigInt(Math.round(u * 1e6)) * 10n ** 12n; }

// Re-prove each domain against the chain once; a token that does not match is not offered (fail closed).
let proven = null;
async function selfCheck() {
  if (proven) return proven;
  const ok = {};
  for (const [sym, t] of Object.entries(TOKENS)) {
    try {
      const onChain = await pub.readContract({ address: t.address, abi, functionName: 'DOMAIN_SEPARATOR' });
      const ours = domainSeparator({ domain: t.domain });
      ok[sym] = onChain.toLowerCase() === ours.toLowerCase();
      if (!ok[sym]) console.error('[bsc-facilitator] ' + sym + ' domain does NOT match the chain (' + onChain + ' vs ' + ours + '): not offered');
    } catch (e) { ok[sym] = false; console.error('[bsc-facilitator] ' + sym + ' domain check failed: ' + String(e.shortMessage || e.message).slice(0, 100) + ': not offered for now'); }
  }
  if (Object.values(ok).some(Boolean)) proven = ok;   // a total failure (RPC down) is retried on the next call
  return ok;
}

// payload: x402 v2 exact-EVM { signature, authorization: { from, to, value, validAfter, validBefore, nonce } }, asset = token address
async function verify(payload, requiredUsd, asset) {
  const a = payload && payload.authorization; const sig = payload && payload.signature;
  if (!a || !sig) return { valid: false, reason: 'missing authorization or signature' };
  const tk = tokenByAddress(asset); if (!tk) return { valid: false, reason: 'asset ' + asset + ' is not one we accept on BNB (USD1, U)' };
  const [sym, t] = tk;
  const pr = await selfCheck(); if (!pr[sym]) return { valid: false, reason: sym + ' is not offered right now (signing domain not proven)' };
  const to = receiveAddress(); if (!to) return { valid: false, reason: 'BNB receiver not configured' };
  let from; try { from = getAddress(a.from); } catch { return { valid: false, reason: 'bad from address' }; }
  if (getAddress(a.to) !== to) return { valid: false, reason: 'authorization pays ' + a.to + ', not our address ' + to };
  const value = BigInt(a.value); const need = units(requiredUsd) * 999n / 1000n;
  if (value < need) return { valid: false, reason: 'underpaid: ' + Number(value / 10n ** 12n) / 1e6 + ' ' + sym + ', need ' + Math.max(Number(requiredUsd), MIN_USD) };
  const now = Math.floor(Date.now() / 1000);
  if (Number(a.validAfter) > now) return { valid: false, reason: 'authorization not yet valid' };
  if (Number(a.validBefore) < now + 5) return { valid: false, reason: 'authorization expired' };
  const message = { from, to, value, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce };
  let ok; try { ok = await verifyTypedData({ address: from, domain: t.domain, types: TYPES, primaryType: 'TransferWithAuthorization', message, signature: sig }); }
  catch (e) { return { valid: false, reason: 'signature check failed: ' + String(e.shortMessage || e.message).slice(0, 60) }; }
  if (!ok) return { valid: false, reason: 'signature does not match from' };
  try { if (await pub.readContract({ address: t.address, abi, functionName: 'authorizationState', args: [from, a.nonce] })) return { valid: false, reason: 'authorization nonce already used' }; }
  catch (e) { console.error('[bsc-facilitator] could not read authorizationState: ' + String(e.shortMessage || e.message).slice(0, 100) + ' - proceeding, the contract is the real guard'); }
  try { const bal = await pub.readContract({ address: t.address, abi, functionName: 'balanceOf', args: [from] }); if (bal < value) return { valid: false, reason: 'the paying wallet holds less ' + sym + ' than it signed for' }; }
  catch (e) { return { valid: false, reason: 'could not read the payer\'s balance: try again' }; }
  return { valid: true, from, value, sym, token: t.address, usd: Number(value / 10n ** 12n) / 1e6, message };
}

// SIMULATE BEFORE SENDING (2026-10-08). A signed authorization from a wallet without the money passed verify (the signature is fine)
// and the settlement was SENT: it reverted on chain and we paid the gas. Anyone could drain the operator's gas by signing payments
// from empty wallets (two such Base transactions came from our own test with Coinbase's official client). The exact call is now
// simulated first; a call that would revert is refused, nothing sent, and the reason says so (insufficient_funds when it is money).
function _wouldFail(e) {
  const msg = String((e && (e.shortMessage || e.message)) || e);
  return { success: false, errorReason: /exceeds balance|insufficient|transfer amount exceeds/i.test(msg) ? 'insufficient_funds' : 'invalid_payment',
    errorMessage: 'the settlement would fail on chain, so it was not sent (nothing charged): ' + msg.slice(0, 140) };
}
async function settle(payload, requiredUsd, asset) {
  const v = await verify(payload, requiredUsd, asset);
  if (!v.valid) return { success: false, errorReason: 'invalid_payment', errorMessage: v.reason };
  const acct = operator(); if (!acct) return { success: false, errorReason: 'facilitator_unavailable' };
  const wal = createWalletClient({ chain: bsc, transport: transport(), account: acct });
  const s = hexToSignature(payload.signature); const m = v.message;
  try {
    const args = [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, s.v ? Number(s.v) : (27 + s.yParity), s.r, s.s];
    try { await pub.simulateContract({ address: v.token, abi, functionName: 'transferWithAuthorization', args, account: acct }); } catch (e) { return _wouldFail(e); }
    const hash = await wal.writeContract({ address: v.token, abi, functionName: 'transferWithAuthorization', args, gas: 150000n });
    let mined = null;
    for (let i = 0; i < 20; i++) { try { const rc = await pub.getTransactionReceipt({ hash }); if (rc) { mined = rc; break; } } catch (e) {} await new Promise((r) => setTimeout(r, 1500)); }
    if (!mined) return { success: false, errorReason: 'settlement_pending', transaction: hash };
    if (mined.status !== 'success') return { success: false, errorReason: 'settlement_failed', transaction: hash };
    return { success: true, transaction: hash, payer: v.from, amount: String(v.value), asset: v.token, symbol: v.sym, usd: v.usd, network: NETWORK };
  } catch (e) { return { success: false, errorReason: 'settlement_failed', errorMessage: String(e.shortMessage || e.message).slice(0, 100) }; }
}

// The 402 options for one price: one per proven token. extra carries the EIP-712 name/version a client must sign with.
async function options(usd) {
  const to = receiveAddress(); if (!to) return [];
  const pr = await selfCheck();
  return Object.entries(TOKENS).filter(([sym]) => pr[sym]).map(([sym, t]) => ({
    scheme: 'exact', network: NETWORK, amount: String(units(usd)), maxAmountRequired: String(units(usd)), asset: t.address, payTo: to,
    maxTimeoutSeconds: 300, extra: { name: t.domain.name, version: t.domain.version, symbol: sym, decimals: 18, minUsd: MIN_USD },
  }));
}

// Synchronous form for the 402 builder: only tokens already proven by selfCheck() (started at load) are offered; until the
// first proof answers, BNB is simply not offered (never a guessed domain).
function optionsSync(usd) {
  const to = receiveAddress(); if (!to || !proven) return [];
  return Object.entries(TOKENS).filter(([sym]) => proven[sym]).map(([sym, t]) => ({
    scheme: 'exact', network: NETWORK, amount: String(units(usd)), asset: t.address, payTo: to, maxTimeoutSeconds: 300,
    extra: { name: t.domain.name, version: t.domain.version, symbol: sym, decimals: 18, minUsd: MIN_USD, credentialTypes: ['authorization'],
      note: 'BNB Smart Chain: sign an EIP-3009 transferWithAuthorization in ' + sym + ' (18 decimals, EIP-712 name "' + t.domain.name + '", version "1") to payTo and send it base64 in PAYMENT-SIGNATURE; we settle it and pay the gas. Minimum $' + MIN_USD + ' on BNB.' },
  }));
}
selfCheck().catch(() => {});
setInterval(() => { if (!proven) selfCheck().catch(() => {}); }, 300000).unref();

module.exports = { verify, settle, options, optionsSync, selfCheck, units, receiveAddress, TOKENS, TYPES, CHAIN_ID, NETWORK, MIN_USD };
