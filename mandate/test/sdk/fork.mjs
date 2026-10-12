// SDK check on a local anvil fork of Arc mainnet: deploy, create a box, sign x402 payments through the SDK and ask the box.
// Arc USDC transfers cannot execute on a fork (native module), so this covers reads, signing and the box's verdicts only;
// test/arc/run.mjs covers the money moving on the real token.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, http, defineChain, hashTypedData, getContractAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BOX_ABI, FACTORY_ABI, USDC_DOMAIN, TRANSFER_TYPES, boxStatus, signX402, freeSlot, REFUSALS } from '../../sdk/mandate.mjs';

const PORT = 8548;
const anvil = spawn(process.env.HOME + '/.foundry/bin/anvil', ['--fork-url', process.env.ARC_FORK_RPC || 'https://rpc.blockdaemon.mainnet.arc.io', '--port', String(PORT), '--silent'], { stdio: 'ignore' });
const arc = defineChain({ id: 5042, name: 'Arc fork', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:' + PORT] } } });
const pub = createPublicClient({ chain: arc, transport: http() });
let fails = 0;
const ok = (cond, label) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails++; };
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { await pub.getChainId(); up = true; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  if (!up) throw new Error('anvil fork did not start');
  const owner = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const shop = '0x00000000000000000000000000000000005a1e51';
  await pub.request({ method: 'anvil_setBalance', params: [owner.address, '0x56BC75E2D63100000'] });
  const w = createWalletClient({ chain: arc, transport: http(), account: owner });
  const F = JSON.parse(readFileSync(new URL('../../out/MandateFactory.sol/MandateFactory.json', import.meta.url)));
  const dh = await w.deployContract({ abi: F.abi, bytecode: F.bytecode.object, args: ['0x3600000000000000000000000000000000000000'] });
  const factory = (await pub.waitForTransactionReceipt({ hash: dh })).contractAddress;
  const salt = '0x' + '11'.repeat(32);
  const predicted = await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'predict', args: [owner.address, salt] });
  const exp = BigInt(Math.floor(Date.now() / 1000) + 86400);
  const ch = await w.writeContract({ address: factory, abi: FACTORY_ABI, functionName: 'create', args: [salt, agent.address, 1_000_000n, 3, exp, false, [shop]], value: 2n * 10n ** 18n });
  await pub.waitForTransactionReceipt({ hash: ch });
  const st = await boxStatus(pub, predicted);
  ok(st.owner === owner.address && st.agent === agent.address, 'boxStatus owner/agent');
  ok(st.balance === 2_000_000n, 'native funding reads as 2 USDC (' + st.balance + ')');
  ok(st.paymentsLeftToday === 3 && st.maxValueLeftToday === 3_000_000n, 'leftToday 3 payments, 3 USDC');
  ok(st.version === 'arc-mandate-1', 'version');
  const s1 = await signX402({ pub, account: agent, box: predicted, to: shop, value: 1_000_000n });
  ok(s1.slot === 0, 'first signature takes slot 0');
  const s2 = await signX402({ pub, account: agent, box: predicted, to: shop, value: 500_000n });
  ok(s2.slot === 1, 'second signature reserved slot 1, not 0 again');
  let err = '';
  try { await signX402({ pub, account: agent, box: predicted, to: shop, value: 1_000_001n }); } catch (e) { err = e.message; }
  ok(/over the per-payment limit/.test(err), 'over cap refused before signing leaves: ' + err);
  err = '';
  try { await signX402({ pub, account: agent, box: predicted, to: '0x000000000000000000000000000000000000dEaD', value: 1n }); } catch (e) { err = e.message; }
  ok(/payee not on the list/.test(err), 'unknown payee refused: ' + err);
  // A stranger's key: the box says "not signed by the agent".
  const stranger = privateKeyToAccount(generatePrivateKey());
  err = '';
  try { await signX402({ pub, account: stranger, box: predicted, to: shop, value: 1n }); } catch (e) { err = e.message; }
  ok(/not signed by the agent/.test(err), 'stranger refused: ' + err);
  // Owner pauses: an already-signed authorization is now refused by the box.
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: predicted, abi: BOX_ABI, functionName: 'setPaused', args: [true] }) });
  const a = s1.authorization;
  const digest = hashTypedData({ domain: USDC_DOMAIN, types: TRANSFER_TYPES, primaryType: 'TransferWithAuthorization',
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce } });
  const code = Number(await pub.readContract({ address: predicted, abi: BOX_ABI, functionName: 'explain', args: [digest, s1.signature] }));
  ok(REFUSALS[code] === 'paused by the owner', 'signed then paused: ' + REFUSALS[code]);
  const magic = await pub.readContract({ address: predicted, abi: [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'bytes' }], outputs: [{ type: 'bytes4' }] }], functionName: 'isValidSignature', args: [digest, s1.signature] });
  ok(magic === '0xffffffff', 'isValidSignature answers no while paused');
  void getContractAddress; void freeSlot;
} catch (e) { console.log('FAIL exception', e.shortMessage || e.message, '\n', String(e.details || ''), '\n', String(e.stack).split('\n').slice(0, 6).join('\n')); fails++; }
finally { anvil.kill(); }
console.log(fails ? fails + ' FAILED' : 'SDK fork checks: all ok');
process.exit(fails ? 1 : 0);
