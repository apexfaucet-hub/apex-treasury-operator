'use strict';
// PARKING GUARD for idle USDC on Arc (Circle Earn Kit + Morpho vaults). Written 2026-09-30, hardened the same day after a
// security review (audits: fable-review-vault-guard-2026-09-30).
//
// The operator may park idle float in a lending vault only inside these limits (limits/LIMITS.md, "Idle float"):
//   1. The vault is one Circle's Earn Kit lists on Arc and Earn Kit shows no warning on it (an API: its warnings can only
//      make us refuse MORE), and ON CHAIN its asset is USDC.
//   2. ON CHAIN, right now, the vault can pay out at least 20% of its deposits AND at least 10x what we would hold.
//   3. Caps: at most MAX_PARK_USD in any vault, and the wallet keeps RESERVE_USD after the amount AND the quoted gas.
//   4. Every transaction the SDK asks to send passes the SEND GATE before it reaches the chain (details at checkSigned).
//   5. EXIT: if a vault we hold stops being LIQUID, or could no longer pay us out twice over, we withdraw what we can.
const fs = require('fs');
const { checkVault, earnKitVaults, idleOnChain } = require('./vault-check.js');
const { parseTransaction, decodeFunctionData, parseAbi, custom, http, createWalletClient } = require('viem');

const ARC_CHAIN_ID = 5042;
const USDC = '0x3600000000000000000000000000000000000000';            // Arc's USDC ERC-20 view (6 decimals)
const EARN_ADAPTER = '0x7fb8c7260b63934d8da38af902f87ae6e284a845';    // ADAPTER_CONTRACT_EVM_MAINNET in @circle-fin/earn-kit 1.8.0
const LIMITS = { MAX_PARK_USD: 5, RESERVE_USD: 1.0, MIN_PARK_USD: 0.1, MIN_WITHDRAWABLE_PCT: 20, MIN_COVER_X: 10, EXIT_COVER_X: 2, MAX_FEE_PCT: 1 };
const lc = (a) => String(a || '').toLowerCase();

// Limits 1-3: may we park `amountUsd` in `vault`, given what we already hold there? `gasUsd` = the quote's gas estimate.
async function decidePark({ vault, amountUsd, heldUsd = 0, walletUsd, gasUsd = 0 }) {
  const no = [];
  const listed = (await earnKitVaults()).find((v) => v.address === lc(vault));
  if (!listed) no.push('not a vault Circle Earn Kit lists on Arc');
  else if (listed.warnings.length) no.push('Earn Kit warns: ' + listed.warnings.join(', '));
  if (!(amountUsd >= LIMITS.MIN_PARK_USD)) no.push('amount below ' + LIMITS.MIN_PARK_USD + ' USDC');
  if (heldUsd + amountUsd > LIMITS.MAX_PARK_USD) no.push('would hold ' + (heldUsd + amountUsd).toFixed(2) + ' > cap ' + LIMITS.MAX_PARK_USD + ' USDC');
  if (walletUsd != null && walletUsd - amountUsd - gasUsd < LIMITS.RESERVE_USD) no.push('wallet would fall under the ' + LIMITS.RESERVE_USD + ' USDC reserve (amount + gas)');
  let chain = null;
  try { chain = await checkVault(vault); } catch (e) { no.push('on-chain read failed: ' + (e.shortMessage || e.message)); }
  if (chain) {
    if (lc(chain.assetAddress) !== USDC) no.push('on-chain asset ' + chain.assetAddress + ' is not USDC');
    if (!(chain.withdrawableNowPct >= LIMITS.MIN_WITHDRAWABLE_PCT)) no.push('on chain only ' + chain.withdrawableNowPct + '% of deposits can be withdrawn now (need ' + LIMITS.MIN_WITHDRAWABLE_PCT + '%)');
    if (!(chain.withdrawableNow >= LIMITS.MIN_COVER_X * (heldUsd + amountUsd))) no.push('on chain ' + chain.withdrawableNow.toFixed(2) + ' USDC withdrawable now, need ' + LIMITS.MIN_COVER_X + 'x our ' + (heldUsd + amountUsd).toFixed(2));
  }
  return { ok: no.length === 0, refusals: no, earnKit: listed || null, chain };
}

// Limit 5: should we leave a vault we hold `heldUsd` in? If the full read fails (e.g. Morpho's API is down) we still
// know the vault's idle USDC from the chain alone, so an exit never depends on an API.
async function decideExit({ vault, heldUsd }) {
  let chain;
  try { chain = await checkVault(vault); } catch (e) {
    let idle = 0; try { idle = await idleOnChain(vault); } catch (_) {}
    return { exit: true, why: 'full read failed, treat as unsafe: ' + (e.shortMessage || e.message), withdrawableNow: idle, fallback: 'idle only, read on chain' };
  }
  if (chain.verdict !== 'LIQUID') return { exit: true, why: 'vault is ' + chain.verdict, chain, withdrawableNow: chain.withdrawableNow };
  if (chain.withdrawableNow < LIMITS.EXIT_COVER_X * heldUsd) return { exit: true, why: 'withdrawable now ' + chain.withdrawableNow.toFixed(2) + ' < ' + LIMITS.EXIT_COVER_X + 'x our ' + heldUsd.toFixed(2), chain, withdrawableNow: chain.withdrawableNow };
  return { exit: false, chain, withdrawableNow: chain.withdrawableNow };
}

// ── Limit 4: the SEND GATE ──────────────────────────────────────────────────────────────────────────────────────────
// `plan` = { vault, me, dry, maxApproveUnits (USDC, 6 decimals), usdcAllowance, maxShareApprove (null on a park),
//            shareAllowance, maxFeeUnits } - allowances are read on chain before the run.
// A signed transaction passes only if: chain 5042; no native value; a plain type (no EIP-7702 authorisations, no blobs);
// and it is one of
//   - USDC approve/increaseAllowance to Circle's Earn adapter, with the resulting allowance within the plan;
//   - vault-share approve/increaseAllowance to the Earn adapter, within the shares we hold (+1 unit, the SDK's residual);
//   - the Earn adapter's execute(), decoded: one tokenInput without a permit that pulls at most the plan, every output
//     token sent to us, exactly one deposit/withdraw/redeem on THIS vault for us, USDC out on a withdraw, and a fee only on
//     a withdraw and at most MAX_FEE_PCT.
// Anything else is refused and nothing is broadcast.
const ERC20 = parseAbi(['function approve(address spender, uint256 amount)', 'function increaseAllowance(address spender, uint256 addedValue)']);
// approve() SETS the allowance; increaseAllowance() ADDS to it. The running total lives in the plan, so a second
// allowance call in one run is measured on top of the first.
function allowanceAfter(d, current) { return d.functionName === 'approve' ? d.args[1] : (current || 0n) + d.args[1]; }
const EXEC = parseAbi([
  'struct Instruction { address target; bytes data; uint256 value; address tokenIn; uint256 amountToApprove; address tokenOut; uint256 minTokenOut; }',
  'struct TokenRecipient { address token; address beneficiary; }',
  'struct ExecutionParams { Instruction[] instructions; TokenRecipient[] tokens; uint256 execId; uint256 deadline; bytes metadata; }',
  'struct TokenInput { uint8 permitType; address token; uint256 amount; bytes permitCalldata; }',
  'function execute(ExecutionParams params, TokenInput[] tokenInputs, bytes signature) payable',
]);
const INNER = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function takeFeeERC20(address token, address beneficiary, uint256 fee, bytes8 kitType)',
]);
function checkExecute(tx, plan) {
  const bad = (why) => ({ ok: false, why, tx });
  let d; try { d = decodeFunctionData({ abi: EXEC, data: tx.data }); } catch (_) { return bad('adapter call is not execute() (selector ' + String(tx.data || '').slice(0, 10) + ')'); }
  const [p, inputs] = d.args, me = lc(plan.me), vault = lc(plan.vault);
  const park = plan.maxShareApprove == null, pull = park ? USDC : vault, cap = park ? plan.maxApproveUnits : plan.maxShareApprove;
  if (inputs.length !== 1) return bad('expected one tokenInput, got ' + inputs.length);
  const t = inputs[0];
  if (Number(t.permitType) !== 0 || t.permitCalldata !== '0x') return bad('tokenInput carries a permit');
  if (lc(t.token) !== pull || t.amount > cap) return bad('tokenInput pulls ' + t.amount + ' of ' + t.token + ' (cap ' + cap + ' of ' + pull + ')');
  for (const r of p.tokens) if (lc(r.beneficiary) !== me) return bad('token ' + r.token + ' would be sent to ' + r.beneficiary + ', not us');
  // When the adapter itself receives the vault's output, an output entry for it must name us, or the adapter keeps it.
  const outToken = park ? vault : USDC;
  const outToUs = p.tokens.some((r) => lc(r.token) === outToken && lc(r.beneficiary) === me);
  let primary = 0;
  for (const ins of p.instructions) {
    if (ins.value !== 0n) return bad('instruction to ' + ins.target + ' carries value ' + ins.value);
    let f; try { f = decodeFunctionData({ abi: INNER, data: ins.data }); } catch (_) { return bad('unknown instruction ' + String(ins.data).slice(0, 10) + ' to ' + ins.target); }
    if (f.functionName === 'takeFeeERC20') { if (park || lc(f.args[0]) !== USDC || f.args[2] > plan.maxFeeUnits) return bad('fee ' + f.args[2] + ' of ' + f.args[0] + ' to ' + f.args[1]); continue; }
    if (lc(ins.target) !== vault) return bad(f.functionName + ' targets ' + ins.target + ', not the vault');
    // receiver may be the adapter only because every output token must go to us (tokens[].beneficiary, checked above)
    if (![me, EARN_ADAPTER].includes(lc(f.args[1]))) return bad(f.functionName + ' receiver ' + f.args[1] + ' is not us');
    if (lc(f.args[1]) === EARN_ADAPTER && !outToUs) return bad(f.functionName + ' pays the adapter, but no output of ' + outToken + ' is routed to us');
    if (f.functionName === 'deposit') { if (!park || f.args[0] > plan.maxApproveUnits) return bad('deposit of ' + f.args[0] + ' outside the plan'); }
    else {
      if (park || lc(ins.tokenOut) !== USDC) return bad(f.functionName + ' outside a withdraw plan or tokenOut ' + ins.tokenOut + ' is not USDC');
      if (f.functionName === 'redeem' && f.args[0] > plan.maxShareApprove) return bad('redeem of ' + f.args[0] + ' > shares held');
    }
    primary++;
  }
  if (primary !== 1) return bad('expected exactly one deposit/withdraw/redeem, got ' + primary);
  return { ok: true, what: (park ? 'deposit' : 'withdraw') + ' via Earn adapter, pulls ' + t.amount + ' of ' + t.token + ', receiver ok, beneficiary ok', tx, pulled: t.amount,
    decoded: { tokens: p.tokens, instructions: p.instructions.map((i) => ({ target: i.target, data: i.data, tokenOut: i.tokenOut, minTokenOut: String(i.minTokenOut) })) } };
}
function checkAllowance(tx, plan, token) {
  const isShares = token !== USDC;
  let d; try { d = decodeFunctionData({ abi: ERC20, data: tx.data }); } catch (_) { return { ok: false, why: (isShares ? 'vault' : 'USDC') + ' call that is not an allowance call (selector ' + String(tx.data || '').slice(0, 10) + ')', tx }; }
  if (lc(d.args[0]) !== EARN_ADAPTER) return { ok: false, why: (isShares ? 'share ' : '') + d.functionName + ' to ' + d.args[0] + ', not the Earn adapter', tx };
  const total = allowanceAfter(d, isShares ? plan.shareAllowance : plan.usdcAllowance);
  const cap = isShares ? plan.maxShareApprove : plan.maxApproveUnits;
  if (cap == null || total > cap) return { ok: false, why: (isShares ? 'share' : 'USDC') + ' allowance would be ' + total + ' > ' + (isShares ? 'shares we hold +1 ' : 'planned ') + cap, tx };
  return { ok: true, what: d.functionName + ' Earn adapter, ' + (isShares ? 'share' : 'USDC') + ' allowance -> ' + total, tx, allowanceTotal: total, allowanceKind: isShares ? 'shareAllowance' : 'usdcAllowance' };
}
function checkSigned(raw, plan) {
  const tx = parseTransaction(raw);
  const to = lc(tx.to);
  if (tx.chainId !== ARC_CHAIN_ID) return { ok: false, why: 'wrong chain ' + tx.chainId, tx };
  if (!['eip1559', 'legacy'].includes(tx.type) || (tx.authorizationList && tx.authorizationList.length) || tx.blobVersionedHashes) return { ok: false, why: 'transaction type ' + tx.type + ' is not allowed', tx };
  if (tx.value && tx.value > 0n) return { ok: false, why: 'carries native value ' + tx.value, tx };
  if (to === USDC) return checkAllowance(tx, plan, USDC);
  if (to === EARN_ADAPTER) return checkExecute(tx, plan);
  if (to === lc(plan.vault)) return checkAllowance(tx, plan, lc(plan.vault));   // a withdrawal first approves our shares
  return { ok: false, why: 'destination ' + tx.to + ' is not USDC, the vault or the Earn adapter', tx };
}

// Reads the SDK and viem may need. Everything else is refused, including methods a future viem adds.
const READ_OK = /^(eth_(chainId|blockNumber|call|estimateGas|gasPrice|maxPriorityFeePerGas|feeHistory|getBalance|getCode|getStorageAt|getTransactionCount|getTransactionReceipt|getTransactionByHash|getBlockByNumber|getBlockByHash|getLogs)|net_version|web3_clientVersion)$/;
function ledgerRow(plan, hash, r) {
  if (!plan.ledgerFile) return;
  // The accountant's shape (account-ingest reads data/ledger/*.ndjson): human units, 'arc:native' (Arc's USDC), amount > 0.
  // Allowance calls and withdrawals move no value out of this wallet, so only a deposit leg is written.
  if (!(r.pulled != null && plan.maxShareApprove == null)) return;
  const row = { at: new Date().toISOString(), chain: 'arc', tx: hash, wallet: plan.me, direction: 'out', asset_id: 'arc:native',
    amount: Number(r.pulled) / 1e6, counterparty: EARN_ADAPTER,
    category: plan.maxShareApprove == null ? 'treasury:park' : 'treasury:unpark', notes: r.what + ' (gas in native USDC: read it from the receipt)' };
  fs.appendFileSync(plan.ledgerFile, JSON.stringify(row) + '\n');
}
function gatedTransport(rpcUrl, plan, log) {
  const upstream = http(rpcUrl, { timeout: 30000 })({ chain: undefined, retryCount: 0 });
  return custom({
    async request({ method, params }) {
      if (method === 'eth_sendRawTransaction') {
        const r = checkSigned(params[0], plan);
        log({ gate: r.ok ? (plan.dry ? 'DRY-REFUSED' : 'PASS') : 'REFUSED', what: r.what || null, why: r.why || null, to: r.tx && r.tx.to, nonce: r.tx && r.tx.nonce, decoded: r.decoded || undefined });
        if (!r.ok) throw new Error('SEND GATE refused: ' + r.why);
        if (plan.dry) throw new Error('SEND GATE: dry run, nothing broadcast (' + r.what + ')');
        const hash = await upstream.request({ method, params });
        if (r.allowanceKind) plan[r.allowanceKind] = r.allowanceTotal;   // cumulative within this run
        log({ gate: 'SENT', hash, what: r.what });
        try { ledgerRow(plan, hash, r); } catch (e) { log({ gate: 'LEDGER-NOT-WRITTEN', hash, why: e.message }); }
        return hash;
      }
      if (!READ_OK.test(method)) { log({ gate: 'REFUSED', why: 'method ' + method + ' is not on the read allow-list' }); throw new Error('SEND GATE refused method ' + method); }
      return upstream.request({ method, params });
    },
  }, { retryCount: 0 });
}
// viem signs typed data and messages in-process with a local account, so the transport never sees them: block them on
// the account itself. Only transaction signing (which then meets the gate) is left.
function signingOnlyTransactions(account) {
  const no = (what) => async () => { throw new Error('SEND GATE: off-chain signing is never allowed (' + what + ')'); };
  return Object.assign({}, account, { signTypedData: no('signTypedData'), signMessage: no('signMessage'), signAuthorization: no('signAuthorization'), sign: no('sign') });
}
function gatedWalletClient({ chain, account, rpcUrl, plan, log }) {
  return createWalletClient({ chain, account: signingOnlyTransactions(account), transport: gatedTransport(rpcUrl, plan, log) });
}

module.exports = { decidePark, decideExit, checkSigned, checkExecute, gatedTransport, gatedWalletClient, signingOnlyTransactions, LIMITS, USDC, EARN_ADAPTER, ARC_CHAIN_ID, READ_OK };
