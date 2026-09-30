'use strict';
// Plants each fault the SEND GATE exists to stop, signed by a throwaway key, and fails unless every one is refused and
// every legitimate shape passes. Then asks the guard about real vaults on Arc (needs the network: Earn Kit's vault list,
// Morpho's market list, an Arc RPC). Exit 1 on any miss. To see it fail, delete one rule in vault-guard.js and rerun.
const G = require('../operator/vault-guard.js');
const V = require('viem');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const acct = privateKeyToAccount(generatePrivateKey());
const ME = acct.address.toLowerCase();
const VAULT = '0xbeef0016cb2fd5c352ea7ca08a9f54739dfa7298', OTHER = '0x1111111111111111111111111111111111111111';
const ABI = V.parseAbi(['function approve(address,uint256)', 'function increaseAllowance(address,uint256)', 'function transfer(address,uint256)']);
const EXEC = V.parseAbi([
  'struct Instruction { address target; bytes data; uint256 value; address tokenIn; uint256 amountToApprove; address tokenOut; uint256 minTokenOut; }',
  'struct TokenRecipient { address token; address beneficiary; }',
  'struct ExecutionParams { Instruction[] instructions; TokenRecipient[] tokens; uint256 execId; uint256 deadline; bytes metadata; }',
  'struct TokenInput { uint8 permitType; address token; uint256 amount; bytes permitCalldata; }',
  'function execute(ExecutionParams params, TokenInput[] tokenInputs, bytes signature) payable',
]);
const INNER = V.parseAbi(['function deposit(uint256 assets, address receiver) returns (uint256)', 'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)', 'function takeFeeERC20(address token, address beneficiary, uint256 fee, bytes8 kitType)']);
const data = (fn, args) => V.encodeFunctionData({ abi: ABI, functionName: fn, args });
const inner = (fn, args) => V.encodeFunctionData({ abi: INNER, functionName: fn, args });
const exec = (instructions, tokens, tokenInputs) => V.encodeFunctionData({ abi: EXEC, functionName: 'execute', args: [{ instructions, tokens, execId: 1n, deadline: 9999999999n, metadata: '0x' }, tokenInputs, '0x' + 'ab'.repeat(65)] });
const ins = (o) => Object.assign({ target: VAULT, data: '0x', value: 0n, tokenIn: G.USDC, amountToApprove: 300000n, tokenOut: '0x0000000000000000000000000000000000000000', minTokenOut: 0n }, o);
const tin = (o) => Object.assign({ permitType: 0, token: G.USDC, amount: 300000n, permitCalldata: '0x' }, o);
const sign = (o) => { const t = Object.assign({ chainId: 5042, nonce: 1, gas: 300000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, value: 0n, type: 'eip1559' }, o); for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k]; return acct.signTransaction(t); };
const parkPlan = { me: ME, vault: VAULT, maxApproveUnits: 300001n, usdcAllowance: 0n, maxShareApprove: null, shareAllowance: 0n, maxFeeUnits: 0n };
const wdPlan = { me: ME, vault: VAULT, maxApproveUnits: 0n, usdcAllowance: 0n, maxShareApprove: 1001n, shareAllowance: 0n, maxFeeUnits: 3000n };
const parkExec = (o = {}) => exec([ins({ data: inner('deposit', [300000n, o.receiver || ME]), value: o.value || 0n })], [{ token: VAULT, beneficiary: o.beneficiary || ME }], [tin(o.tin || {})]);

const cases = [
  // allowances
  ['legit increaseAllowance to Earn adapter', parkPlan, true, { to: G.USDC, data: data('increaseAllowance', [G.EARN_ADAPTER, 300001n]) }],
  ['approve to a stranger', parkPlan, false, { to: G.USDC, data: data('approve', [OTHER, 1n]) }],
  ['approve more than planned', parkPlan, false, { to: G.USDC, data: data('approve', [G.EARN_ADAPTER, 300002n]) }],
  ['unlimited approve', parkPlan, false, { to: G.USDC, data: data('approve', [G.EARN_ADAPTER, 2n ** 256n - 1n]) }],
  ['USDC transfer out', parkPlan, false, { to: G.USDC, data: data('transfer', [OTHER, 1n]) }],
  ['increaseAllowance on top of a standing allowance', Object.assign({}, parkPlan, { usdcAllowance: 5n }), false, { to: G.USDC, data: data('increaseAllowance', [G.EARN_ADAPTER, 300001n]) }],
  ['share approve within shares held + 1', wdPlan, true, { to: VAULT, data: data('approve', [G.EARN_ADAPTER, 1001n]) }],
  ['share approve beyond shares held + 1', wdPlan, false, { to: VAULT, data: data('approve', [G.EARN_ADAPTER, 1002n]) }],
  // transaction shape
  ['wrong chain', parkPlan, false, { chainId: 1, to: G.USDC, data: data('increaseAllowance', [G.EARN_ADAPTER, 1n]) }],
  ['native value attached', parkPlan, false, { to: G.EARN_ADAPTER, value: 1n, data: parkExec() }],
  ['access-list transaction type', parkPlan, false, { type: 'eip2930', gasPrice: 1n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined, to: G.USDC, data: data('increaseAllowance', [G.EARN_ADAPTER, 1n]) }],
  ['unknown destination', parkPlan, false, { to: OTHER, data: '0x' }],
  // execute(), decoded
  ['park: deposit for us', parkPlan, true, { to: G.EARN_ADAPTER, data: parkExec() }],
  ['park: deposit for a stranger', parkPlan, false, { to: G.EARN_ADAPTER, data: parkExec({ receiver: OTHER }) }],
  ['park: output sent to a stranger', parkPlan, false, { to: G.EARN_ADAPTER, data: parkExec({ beneficiary: OTHER }) }],
  ['park: pulls more than planned', parkPlan, false, { to: G.EARN_ADAPTER, data: parkExec({ tin: { amount: 300002n } }) }],
  ['park: permit in tokenInput', parkPlan, false, { to: G.EARN_ADAPTER, data: parkExec({ tin: { permitType: 1, permitCalldata: '0x1234' } }) }],
  ['park: two tokenInputs', parkPlan, false, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('deposit', [300000n, ME]) })], [], [tin(), tin()]) }],
  ['park: fee on a park', parkPlan, false, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('deposit', [300000n, ME]) }), ins({ target: G.EARN_ADAPTER, data: inner('takeFeeERC20', [G.USDC, OTHER, 1n, '0x0000000000000001']) })], [], [tin()]) }],
  ['park: instruction carries value', parkPlan, false, { to: G.EARN_ADAPTER, data: parkExec({ value: 1n }) }],
  ['park: unknown inner call', parkPlan, false, { to: G.EARN_ADAPTER, data: exec([ins({ data: '0xdeadbeef' })], [], [tin()]) }],
  ['park: adapter call that is not execute()', parkPlan, false, { to: G.EARN_ADAPTER, data: '0x12345678' + VAULT.slice(2).padStart(64, '0') }],
  ['park: deposit to the adapter, no output routed to us', parkPlan, false, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('deposit', [300000n, G.EARN_ADAPTER]) })], [], [tin()]) }],
  ['park: deposit to the adapter, only USDC routed to us', parkPlan, false, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('deposit', [300000n, G.EARN_ADAPTER]) })], [{ token: G.USDC, beneficiary: ME }], [tin()]) }],
  ['withdraw: redeem to the adapter, nothing routed to us', wdPlan, false, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('redeem', [1000n, G.EARN_ADAPTER, G.EARN_ADAPTER]), tokenIn: VAULT, tokenOut: G.USDC })], [], [tin({ token: VAULT, amount: 1000n })]) }],
  ['withdraw: redeem all to us', wdPlan, true, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('redeem', [1000n, ME, G.EARN_ADAPTER]), tokenIn: VAULT, amountToApprove: 1000n, tokenOut: G.USDC, minTokenOut: 299000n })], [{ token: G.USDC, beneficiary: ME }], [tin({ token: VAULT, amount: 1000n })]) }],
  ['withdraw: redeem + 1% fee', wdPlan, true, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('redeem', [1000n, G.EARN_ADAPTER, G.EARN_ADAPTER]), tokenIn: VAULT, tokenOut: G.USDC }), ins({ target: G.EARN_ADAPTER, data: inner('takeFeeERC20', [G.USDC, OTHER, 3000n, '0x0000000000000001']) })], [{ token: G.USDC, beneficiary: ME }], [tin({ token: VAULT, amount: 1000n })]) }],
  ['withdraw: fee above 1%', wdPlan, false, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('redeem', [1000n, ME, G.EARN_ADAPTER]), tokenIn: VAULT, tokenOut: G.USDC }), ins({ target: G.EARN_ADAPTER, data: inner('takeFeeERC20', [G.USDC, OTHER, 3001n, '0x0000000000000001']) })], [], [tin({ token: VAULT, amount: 1000n })]) }],
  ['withdraw: redeem beyond shares', wdPlan, false, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('redeem', [1002n, ME, G.EARN_ADAPTER]), tokenIn: VAULT, tokenOut: G.USDC })], [], [tin({ token: VAULT, amount: 1000n })]) }],
  ['withdraw: receiver a stranger', wdPlan, false, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('withdraw', [300000n, OTHER, G.EARN_ADAPTER]), tokenIn: VAULT, tokenOut: G.USDC })], [], [tin({ token: VAULT, amount: 1000n })]) }],
  ['withdraw: tokenOut not USDC', wdPlan, false, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('withdraw', [300000n, ME, G.EARN_ADAPTER]), tokenIn: VAULT, tokenOut: OTHER })], [], [tin({ token: VAULT, amount: 1000n })]) }],
  ['withdraw: deposit inside a withdraw plan', wdPlan, false, { to: G.EARN_ADAPTER, data: exec([ins({ data: inner('deposit', [300000n, ME]) })], [], [tin({ token: VAULT, amount: 1000n })]) }],
];

(async () => {
  let bad = 0;
  const report = (good, name, r) => { if (!good) bad++; console.log((good ? 'ok   ' : 'MISS ') + name + ' -> ' + r); };
  for (const [name, plan, want, o] of cases) {
    const r = G.checkSigned(await sign(o), plan);
    report(r.ok === want, name, r.ok ? 'PASS' : 'REFUSED: ' + r.why);
  }
  // the transport refuses anything that is not a read, including methods a future viem adds
  for (const m of ['eth_sendRawTransactionSync', 'eth_sendTransaction', 'wallet_sendCalls', 'personal_sign', 'eth_signTypedData_v4']) report(!G.READ_OK.test(m), 'transport refuses ' + m, G.READ_OK.test(m) ? 'ALLOWED' : 'refused');
  for (const m of ['eth_call', 'eth_getTransactionCount', 'eth_estimateGas']) report(G.READ_OK.test(m), 'transport allows read ' + m, G.READ_OK.test(m) ? 'allowed' : 'REFUSED');
  // off-chain signing is blocked on the account itself (viem signs typed data in-process, the transport never sees it)
  const gated = G.signingOnlyTransactions(acct);
  let threw = false; try { await gated.signTypedData({ domain: {}, types: { A: [{ name: 'a', type: 'uint256' }] }, primaryType: 'A', message: { a: 1n } }); } catch (_) { threw = true; }
  report(threw, 'off-chain typed-data signing is blocked', threw ? 'blocked' : 'SIGNED');
  report(typeof gated.signTransaction === 'function', 'transaction signing still works (it meets the gate)', 'ok');
  // real vaults (network): the big two cannot pay out; Bitwise can pay out 17.4% on chain, under the 20% floor
  for (const [name, vault] of [['Galaxy USDC', '0x8e357432cc12ff425c36432f312968aeb16112af'], ['Keyrock Prime USDC', '0x5befab92a5a3d60f578cb51eeb4e4fd50a1e3123'], ['Bitwise Premium RWA USDC', '0x7610094b846657dcf166d59e42973db52c7015f9']]) {
    const d = await G.decidePark({ vault, amountUsd: 0.3, heldUsd: 0, walletUsd: 1.32 });
    report(!d.ok, 'park in ' + name, d.ok ? 'ALLOWED' : 'REFUSED: ' + d.refusals.join(' | '));
  }
  console.log(bad ? bad + ' MISSED' : 'all as expected');
  process.exit(bad ? 1 : 0);
})();
