// Demo agent: spends from a MandateBox on Arc mainnet, inside its owner's rules.
//   AGENT_KEY_FILE=/path/agent.json BOX=0x… node examples/demo-agent.mjs [--refusal-on-chain]
// 1. reads the box (rules, balance, payments left today)
// 2. buys one data product with standard x402: the agent signs, the seller settles, the box approves via EIP-1271
// 3. buys one more by direct payment: box.pay() to the seller, then replays the transaction hash
// 4. tries a payment over the per-payment limit: refused by the box with its reason
//    (--refusal-on-chain also sends that payment, so the refusal is a reverted transaction anyone can look up)
// The key file is read, never printed. Use your own box and your own money.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, fallback, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { boxStatus, x402Fetch, payDirect, usd, BOX_ABI, refusalOf, freeSlot } from '../sdk/mandate.mjs';

const SHOP = process.env.SHOP || 'https://apexfaucet.xyz';
const PRODUCT = process.env.PRODUCT || '/api/x402/arc-gold';
const BOX = process.env.BOX;
if (!BOX || !process.env.AGENT_KEY_FILE) { console.error('set BOX and AGENT_KEY_FILE'); process.exit(2); }
const arc = defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } });
const transport = fallback(['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io'].map((u) => http(u, { timeout: 20000 })), { rank: false });
const pub = createPublicClient({ chain: arc, transport });
const account = privateKeyToAccount(JSON.parse(readFileSync(process.env.AGENT_KEY_FILE, 'utf8')).privateKey);
const wallet = createWalletClient({ chain: arc, transport, account });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const st = await boxStatus(pub, BOX);
log(`box ${st.box}: ${usd(st.balance)} USDC, at most ${usd(st.maxPerPayment)} per payment, ${st.paymentsLeftToday} of ${st.maxPaymentsPerDay} payments left today, ${st.paused ? 'PAUSED' : 'active'}, ends ${new Date(st.expiresAt * 1000).toISOString().slice(0, 10)}`);
if (st.agent.toLowerCase() !== account.address.toLowerCase()) { console.error('this key is not the box agent'); process.exit(3); }

// 2. standard x402
const r1 = await x402Fetch(SHOP + PRODUCT, { pub, account, box: BOX, maxUsd: usd(st.maxPerPayment) });
const pr = r1.headers.get('payment-response');
let settled = null; try { settled = pr ? JSON.parse(Buffer.from(pr, 'base64').toString('utf8')) : null; } catch {}
log(`x402 ${PRODUCT}: HTTP ${r1.status}${settled && settled.transaction ? ', settled in ' + settled.transaction : ''}`);
if (r1.status !== 200) log('  body: ' + (await r1.text()).slice(0, 300));

// 3. direct payment, then replay the hash
const q = await fetch(SHOP + PRODUCT);
let need = null, payTo = null;
try { const j = JSON.parse(Buffer.from(q.headers.get('payment-required'), 'base64').toString('utf8')); const o = j.accepts.find((x) => x.network === 'eip155:5042' && !(x.extra && x.extra.name === 'GatewayWalletBatched')); need = BigInt(o.amount); payTo = o.payTo; } catch {}
if (need && payTo) {
  const { hash } = await payDirect({ pub, wallet, box: BOX, to: payTo, value: need });
  const r2 = await fetch(SHOP + PRODUCT, { headers: { 'X-PAYMENT-ARC': hash } });
  log(`direct ${PRODUCT}: paid ${usd(need)} USDC in ${hash}, HTTP ${r2.status}`);
} else log('direct: could not read the price from the 402');

// 4. over the per-payment limit
const over = st.maxPerPayment + 1n;
try { await payDirect({ pub, wallet, box: BOX, to: payTo || st.owner, value: over }); log('OVER-LIMIT PAYMENT WENT THROUGH (bad)'); }
catch (e) { log(`over the limit (${usd(over)} USDC): ${e.message}`); }
if (process.argv.includes('--refusal-on-chain')) {
  const { slot } = await freeSlot(pub, BOX);
  try {
    const hash = await wallet.writeContract({ address: BOX, abi: BOX_ABI, functionName: 'pay', args: [payTo, over, BigInt(slot), '0x' + '00'.repeat(32)], gas: 120000n });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90000 });
    log(`refusal on chain: ${hash} status ${rc.status}`);
  } catch (e) { log('refusal tx: ' + refusalOf(e)); }
}
const end = await boxStatus(pub, BOX);
log(`after: ${usd(end.balance)} USDC in the box, ${end.paymentsLeftToday} payments left today`);
