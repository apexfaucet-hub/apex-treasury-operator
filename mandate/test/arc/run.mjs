// Runs test/arc/ArcHarness.sol against Arc mainnet's real USDC inside eth_call (state override, nothing broadcast).
//   forge build && node test/arc/run.mjs            -> expects "ALL OK"
//   node test/arc/run.mjs --plant                   -> feeds a stranger's signature as the good one; must FAIL
// Keys are generated fresh for each run and never written anywhere.
import { readFileSync } from 'node:fs';
import { createPublicClient, http, encodeAbiParameters, decodeFunctionResult, encodeFunctionData, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPCS = (process.env.ARC_RPC || 'https://rpc.blockdaemon.mainnet.arc.io,https://rpc.mainnet.arc.io,https://arc.drpc.org').split(',');
// Arc's official RPC reports its own throttle as "Request exceeds defined limit" / "Missing or invalid parameters": an
// unusable RPC, never a test result.
const THROTTLE = /exceeds defined limit|rate limit|too many requests|429|missing or invalid parameters|timed? ?out|fetch failed/i;
const USDC = '0x3600000000000000000000000000000000000000';
const SHOP = '0x00000000000000000000000000000000005a1e51';
const HARNESS = '0x00000000000000000000000000000000a4c4e55e';
const PLANT = process.argv.includes('--plant');

const art = JSON.parse(readFileSync(new URL('../../out/ArcHarness.sol/ArcHarness.json', import.meta.url)));
const abi = art.abi;
const code = art.deployedBytecode.object;
const stateOverride = [{ address: HARNESS, code, balance: 20n * 10n ** 18n, nonce: 1 }];

async function call(client, functionName, args = []) {
  const data = encodeFunctionData({ abi, functionName, args });
  const r = await client.call({ to: HARNESS, data, stateOverride, gas: 30_000_000n });
  return decodeFunctionResult({ abi, functionName, data: r.data });
}

const agent = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

let lastErr;
let prepared = false;
for (const rpc of RPCS) {
  const client = createPublicClient({ transport: http(rpc, { timeout: 30_000 }) });
  try {
    const chainId = await client.getChainId();
    if (chainId !== 5042) throw new Error('not Arc mainnet: chain id ' + chainId);
    const p = await call(client, 'prepare');
    prepared = true;
    const domain = { name: 'USDC', version: '2', chainId, verifyingContract: USDC };
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    };
    // Our domain must be USDC's own, or every signature below is meaningless.
    const ds = keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        keccak256(toHex('USDC')), keccak256(toHex('2')), BigInt(chainId), USDC]));
    if (ds !== p.domainSeparator) throw new Error('USDC domain mismatch: ours ' + ds + ' chain ' + p.domainSeparator);
    const vb = p.timestamp + 86400n;
    const sign = async (who, value, slot) => {
      const message = { from: p.box, to: SHOP, value, validAfter: 0n, validBefore: vb, nonce: p.nonces[slot] };
      const sig = await who.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message });
      return encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
        [SHOP, value, 0n, vb, BigInt(slot), sig],
      );
    };
    const okSlot1 = await sign(agent, 1_000_000n, 1);
    const overCap = await sign(agent, 2_000_000n, 2);
    const strangerSig = await sign(stranger, 1_000_000n, 2);
    const okSlot2 = await sign(agent, 1_000_000n, 2);
    console.log(`rpc ${rpc} | factory ${p.factory} | box ${p.box} | UTC day ${p.day} | block time ${p.timestamp}`);
    console.log(`USDC DOMAIN_SEPARATOR ${p.domainSeparator}`);
    const out = await call(client, 'run', [agent.address, vb, [PLANT ? await sign(stranger, 1_000_000n, 1) : okSlot1, overCap, strangerSig, okSlot2]]);
    console.log(PLANT ? 'PLANTED FAULT WAS ACCEPTED (bad):' : 'result:', out);
    process.exit(PLANT ? 1 : 0);
  } catch (e) {
    const msg = (e.shortMessage || e.message || String(e)).split('\n')[0];
    const detail = e.cause?.reason || e.details || '';
    if (prepared && !THROTTLE.test(msg + ' ' + detail)) {
      // The planted fault (a stranger's signature presented as the agent's) must be refused by USDC's own check,
      // i.e. by the box answering "no" to EIP-1271. Failing anywhere else does not count as catching it.
      const text = msg + ' ' + detail;
      const caught = PLANT && /invalid signature/i.test(text);
      console.log(caught ? 'planted fault refused by USDC + box (good):' : (PLANT ? 'PLANT RUN FAILED FOR ANOTHER REASON (bad):' : 'FAILED on Arc:'), text);
      process.exit(caught ? 0 : 1);
    }
    lastErr = e;
    prepared = false;
    console.log(`rpc ${rpc} unusable: ${msg}`);
  }
}
console.log('could not reach any Arc RPC:', lastErr?.message);
process.exit(2);
