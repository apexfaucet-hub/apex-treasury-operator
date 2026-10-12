// arc-mandate agent SDK: pay from a MandateBox on Arc, inside the owner's rules.
//
//   import { boxStatus, payDirect, signX402, x402Fetch } from './sdk/mandate.mjs';
//
// Two ways to pay, both checked by the box against the same rules and the same daily slots:
//   payDirect  - the agent calls box.pay(); the seller is paid by a plain USDC transfer (replay the tx hash).
//   signX402   - the agent signs a standard x402 "exact" authorization with from = the box; any seller whose
//                facilitator settles EIP-3009 with a bytes signature (EIP-1271) can take it. x402Fetch wraps it.
// Nothing here holds money or keys beyond the agent account you pass in.
import { parseAbi, encodeAbiParameters, getAddress, hashTypedData } from 'viem';

export const ARC_CHAIN_ID = 5042;
export const USDC = '0x3600000000000000000000000000000000000000';
export const USDC_DOMAIN = { name: 'USDC', version: '2', chainId: ARC_CHAIN_ID, verifyingContract: USDC };
export const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};

export const BOX_ABI = parseAbi([
  'function owner() view returns (address)',
  'function agent() view returns (address)',
  'function maxPerPayment() view returns (uint128)',
  'function maxPaymentsPerDay() view returns (uint32)',
  'function expiresAt() view returns (uint64)',
  'function paused() view returns (bool)',
  'function anyPayee() view returns (bool)',
  'function isPayee(address) view returns (bool)',
  'function today() view returns (uint256)',
  'function slotNonce(uint256 day, uint256 slot) view returns (bytes32)',
  'function slotUsed(uint256 day, uint256 slot) view returns (bool)',
  'function nextFreeSlot() view returns (bool found, uint256 slot)',
  'function leftToday() view returns (uint256 payments, uint256 maxValue)',
  'function balance() view returns (uint256)',
  'function explain(bytes32 hash, bytes signature) view returns (uint8)',
  'function pay(address to, uint256 value, uint256 slot, bytes32 ref) returns (bytes32 nonce)',
  'function setRules(address agent, uint128 maxPerPayment, uint32 maxPaymentsPerDay, uint64 expiresAt, bool anyPayee)',
  'function setPayees(address[] allow, address[] disallow)',
  'function setPaused(bool paused)',
  'function withdraw(address to, uint256 value)',
  'function withdrawAll(address to)',
  'function VERSION() view returns (string)',
  'error Refused(uint8 reason)',
]);

export const FACTORY_ABI = parseAbi([
  'function create(bytes32 salt, address agent, uint128 maxPerPayment, uint32 maxPaymentsPerDay, uint64 expiresAt, bool anyPayee, address[] payees) payable returns (address box)',
  'function predict(address owner, bytes32 salt) view returns (address)',
  'function isMandate(address) view returns (bool)',
  'function mandatesCreated() view returns (uint256)',
  'event MandateCreated(address indexed box, address indexed owner, address indexed agent, uint256 maxPerPayment, uint256 maxPaymentsPerDay, uint256 expiresAt, bool anyPayee, uint256 fundedWei)',
]);

// Same order as MandateBox.Refusal.
export const REFUSALS = ['ok', 'no agent set', 'caller is not the agent', 'paused by the owner', 'mandate expired',
  'zero amount', 'over the per-payment limit', 'payee not on the list', 'bad payee', 'no payments left today',
  'slot already used', 'signature is not for this transfer', 'not signed by the agent', 'malformed signature'];

export const usdcUnits = (usd) => BigInt(Math.round(Number(usd) * 1e6));
export const usd = (units) => Number(units) / 1e6;

/** Everything a UI or an agent needs to know about a box, read from the chain. */
export async function boxStatus(pub, box) {
  const r = (functionName, args = []) => pub.readContract({ address: box, abi: BOX_ABI, functionName, args });
  const [owner, agent, maxPerPayment, maxPaymentsPerDay, expiresAt, paused, anyPayee, today, left, bal, version] = await Promise.all([
    r('owner'), r('agent'), r('maxPerPayment'), r('maxPaymentsPerDay'), r('expiresAt'), r('paused'), r('anyPayee'),
    r('today'), r('leftToday'), r('balance'), r('VERSION'),
  ]);
  return { box: getAddress(box), owner, agent, maxPerPayment, maxPaymentsPerDay: Number(maxPaymentsPerDay), expiresAt: Number(expiresAt),
    paused, anyPayee, day: today, paymentsLeftToday: Number(left[0]), maxValueLeftToday: left[1], balance: bal, version };
}

// Slots this process has handed out but that may not be settled yet, so two payments signed close together never share one.
const reserved = new Map(); // `${box}:${day}` -> Set(slot)

/** The first slot today that is unused on chain and not reserved by this process. */
export async function freeSlot(pub, box) {
  const [day, n] = await Promise.all([
    pub.readContract({ address: box, abi: BOX_ABI, functionName: 'today' }),
    pub.readContract({ address: box, abi: BOX_ABI, functionName: 'maxPaymentsPerDay' }),
  ]);
  const key = getAddress(box) + ':' + day;
  const mine = reserved.get(key) || new Set();
  for (let i = 0; i < Number(n); i++) {
    if (mine.has(i)) continue;
    const used = await pub.readContract({ address: box, abi: BOX_ABI, functionName: 'slotUsed', args: [day, BigInt(i)] });
    if (!used) { mine.add(i); reserved.set(key, mine); return { day, slot: i }; }
  }
  throw new Error('no payments left today in this mandate (all ' + n + ' slots used)');
}

/** Give a reserved slot back (the payment using it was refused or never sent). */
export function releaseSlot(box, day, slot) {
  const mine = reserved.get(getAddress(box) + ':' + day);
  if (mine) mine.delete(slot);
}

/** Pay `to` from the box with a plain USDC transfer. Returns the transaction hash once mined. */
export async function payDirect({ pub, wallet, box, to, value, ref = '0x' + '00'.repeat(32) }) {
  const { day, slot } = await freeSlot(pub, box);
  const args = [getAddress(to), BigInt(value), BigInt(slot), ref];
  // Simulate first: a refused payment is explained here, before any gas is spent.
  try { await pub.simulateContract({ address: box, abi: BOX_ABI, functionName: 'pay', args, account: wallet.account }); }
  catch (e) { releaseSlot(box, day, slot); throw new Error('the mandate refused this payment: ' + refusalOf(e)); }
  let hash;
  try { hash = await wallet.writeContract({ address: box, abi: BOX_ABI, functionName: 'pay', args, chain: wallet.chain }); }
  catch (e) { releaseSlot(box, day, slot); throw e; }
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (rc.status !== 'success') throw new Error('pay transaction failed on chain: ' + hash);
  return { hash, slot };
}

/**
 * Sign a standard x402 "exact" EIP-3009 authorization that moves `value` USDC from the box to `to`.
 * Returns { authorization, signature } where signature is the box's EIP-1271 envelope:
 * abi.encode(to, value, validAfter, validBefore, slot, agentSignature).
 */
export async function signX402({ pub, account, box, to, value, validForSeconds = 3600 }) {
  const { day, slot } = await freeSlot(pub, box);
  try {
    return await signSlot({ pub, account, box, to, value, validForSeconds, day, slot });
  } catch (e) {
    releaseSlot(box, day, slot);
    throw e;
  }
}

async function signSlot({ pub, account, box, to, value, validForSeconds, day, slot }) {
  const nonce = await pub.readContract({ address: box, abi: BOX_ABI, functionName: 'slotNonce', args: [day, BigInt(slot)] });
  const now = Math.floor(Date.now() / 1000);
  // A slot belongs to one UTC day: an authorization settled after midnight is refused, so never sign past it.
  const midnight = (Number(day) + 1) * 86400;
  const validBefore = BigInt(Math.min(now + validForSeconds, midnight - 1));
  const authorization = { from: getAddress(box), to: getAddress(to), value: BigInt(value), validAfter: 0n, validBefore, nonce };
  const agentSig = await account.signTypedData({ domain: USDC_DOMAIN, types: TRANSFER_TYPES, primaryType: 'TransferWithAuthorization', message: authorization });
  const signature = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
    [authorization.to, authorization.value, 0n, validBefore, BigInt(slot), agentSig],
  );
  // Ask the box now, so a payment it would refuse fails here with a reason instead of at the seller.
  const digest = hashTypedData({ domain: USDC_DOMAIN, types: TRANSFER_TYPES, primaryType: 'TransferWithAuthorization', message: authorization });
  const code = Number(await pub.readContract({ address: box, abi: BOX_ABI, functionName: 'explain', args: [digest, signature] }));
  if (code !== 0) throw new Error('the mandate would refuse this payment: ' + (REFUSALS[code] || 'reason ' + code));
  return {
    slot,
    authorization: Object.fromEntries(Object.entries(authorization).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
    signature,
  };
}

/** fetch() that pays an x402 402 on Arc from the box. Pays only Arc USDC "exact" offers at or under maxUsd. */
export async function x402Fetch(url, { pub, account, box, maxUsd = 0.05, init = {} }) {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;
  const hdr = first.headers.get('payment-required');
  let req = null;
  try { req = hdr ? JSON.parse(Buffer.from(hdr, 'base64').toString('utf8')) : await first.clone().json(); } catch { req = null; }
  const offers = (req && req.accepts) || [];
  const offer = offers.find((o) => o.scheme === 'exact' && (o.network === 'eip155:5042' || o.network === 'arc')
    && String(o.asset || '').toLowerCase() === USDC.toLowerCase() && !(o.extra && o.extra.name === 'GatewayWalletBatched'));
  if (!offer) throw new Error('no Arc USDC exact offer in this 402');
  const amount = BigInt(offer.amount || offer.maxAmountRequired);
  if (usd(amount) > maxUsd) throw new Error('price ' + usd(amount) + ' USDC is above maxUsd ' + maxUsd);
  const signed = await signX402({ pub, account, box, to: offer.payTo, value: amount });
  const payload = { x402Version: 2, accepted: offer, resource: req.resource, payload: { signature: signed.signature, authorization: signed.authorization } };
  const headers = Object.assign({}, init.headers || {}, { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64') });
  return fetch(url, Object.assign({}, init, { headers }));
}

export function refusalOf(e) {
  const data = e && (e.cause?.data || e.data);
  if (data && data.errorName === 'Refused') return REFUSALS[Number(data.args[0])] || 'reason ' + data.args[0];
  const m = String(e && (e.shortMessage || e.message) || e);
  const hit = /Refused\((\d+)\)/.exec(m);
  return hit ? (REFUSALS[Number(hit[1])] || 'reason ' + hit[1]) : m.split('\n')[0];
}

