# arc-mandate

[![tests](https://github.com/apexfaucet-hub/arc-mandate/actions/workflows/test.yml/badge.svg)](https://github.com/apexfaucet-hub/arc-mandate/actions/workflows/test.yml)

**A spending box with rules for an AI agent, on Arc.**
The owner puts USDC in and writes the rules. The agent pays for things by itself, but only inside those rules, and the
contract checks every payment. The owner can stop the agent, change the rules or take everything back at any time. Nobody
else can: there is no admin, no fee and no upgrade.

Built by [apexfaucet.xyz](https://apexfaucet.xyz/arc/) (agent #1 in Arc's ERC-8004 registry). Page:
[apexfaucet.xyz/arc/mandate/](https://apexfaucet.xyz/arc/mandate/). MIT licensed.

## The rules a box enforces

| rule | how |
|---|---|
| which agent may spend | `agent`: an EOA or a smart-wallet (EIP-1271) agent |
| the most one payment may move | `maxPerPayment` (USDC, 6 decimals) |
| how many payments per UTC day | `maxPaymentsPerDay`: each payment uses one of today's numbered slots |
| who may be paid | a payee list, or `anyPayee` |
| until when | `expiresAt` |
| stop button | `setPaused(true)`: also voids payments the agent already signed but nobody settled yet |
| owner's money back | `withdraw`, `withdrawAll`, `withdrawToken`, at any time, paused or not, expired or not |

So today's spend is at most `maxPaymentsPerDay × maxPerPayment`, only to the list, and never after `expiresAt`, whatever the
agent does: a buggy agent, a leaked agent key or a bad prompt cannot move more.

## Two ways for the agent to pay, one set of rules

1. **Standard x402** (`exact`, EIP-3009). The agent signs a normal `TransferWithAuthorization` with `from = box`. Arc's
   USDC (FiatToken v2.2 at `0x3600…0000`) asks the box through EIP-1271 whether to allow it. The box says yes only if the
   transfer is exactly the one the agent signed, the agent is the current agent, and the transfer fits the rules *at the
   moment it settles*. Any seller whose facilitator checks the payer with EIP-1271 and settles with the bytes-signature overload can take it, gasless for the
   agent. (Checked on Arc mainnet: a contract answering `0x1626ba7e` passes, one answering `0xffffffff` reverts with
   `FiatTokenV2: invalid signature`.)
2. **Direct**: the agent calls `pay(to, value, slot, ref)` and the box sends USDC. Any seller that accepts a plain Arc USDC
   transfer (replaying the transaction hash) can take it.

Both paths draw from the same daily slots. A slot is a USDC authorization nonce
`keccak256(abi.encode(box, utcDay, slot))`. Arc's USDC records a slot spent through x402 (`authorizationState`), the box records
a slot spent through `pay()` (`usedByPay`), and each path checks both records, so no slot is used twice. Outside readers
should ask the box (`slotUsed`), not USDC alone.

The signature an x402 payment carries is the box's envelope:
`abi.encode(to, value, validAfter, validBefore, slot, agentSignature)`, where `agentSignature` is the agent's EIP-712
signature over the same transfer. Any other digest asking the box for a signature (a permit, a cancel, another token,
another chain, another protocol) is refused, because it cannot equal the USDC transfer digest the box rebuilds.

## Use it as an agent

```js
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Fetch, payDirect, boxStatus } from './sdk/mandate.mjs';

const pub = createPublicClient({ transport: http('https://rpc.mainnet.arc.io') });
const agent = privateKeyToAccount(process.env.AGENT_KEY);
const box = '0x…';                                  // the box its owner created for this agent

console.log(await boxStatus(pub, box));            // rules, balance, payments left today
const res = await x402Fetch('https://apexfaucet.xyz/api/x402/arc-gold', { pub, account: agent, box, maxUsd: 0.01 });
```

The SDK finds a free slot, signs, and asks the box (`explain`) before anything leaves, so a payment the box would refuse
fails locally with its reason (`over the per-payment limit`, `payee not on the list`, `paused by the owner`, …).

## Create one as an owner

From the page, or directly: `MandateFactory.create(salt, agent, maxPerPayment, maxPaymentsPerDay, expiresAt, anyPayee,
payees)` with native USDC as `msg.value`. One transaction creates the box (an EIP-1167 clone) and funds it. The caller is
the owner. `predict(owner, salt)` gives the address in advance; `isMandate(box)` lets a seller check a payer is a real box.

## Tests

```bash
forge test                       # 36 unit + fuzz tests (2,000 random runs of everything an agent can try in a day)
forge build && node test/arc/run.mjs          # the whole story on Arc mainnet's REAL USDC, inside one eth_call (nothing broadcast)
node test/arc/run.mjs --plant                 # a stranger's signature presented as the agent's: must be refused by USDC + box
node test/sdk/fork.mjs                        # SDK against an anvil fork of Arc (reads, signing, the box's verdicts)
sudo env NODE_PATH=… node test/web/e2e-fork.cjs   # the page in headless Chrome with a stand-in wallet on a fork
```

Arc's USDC moves balances through a native module that local forks cannot execute, so money movement is proven against a
real Arc node with `eth_call` and a state override (`test/arc/`); forks are used for reads and signatures only.

Every rule was also checked the other way round: 18 deliberate faults planted in the contract (payee check removed, digest
check removed, cap removed, slot not recorded, pause ignored, day dropped from the nonce, …) and each one made a test fail.

## Honest limits

- The daily limit counts payments: at most `maxPaymentsPerDay` of at most `maxPerPayment` each. It is not a running sum.
- Days are UTC. An x402 authorization signed for one day is refused after midnight UTC (the SDK never signs past it).
- Circle Gateway nanopayments are not supported: they need a signature from a Gateway depositor, not an EIP-3009 one.
- The seller's facilitator must check the payer with EIP-1271 and settle with the bytes-signature overload of
  `transferWithAuthorization`; one that only runs `ecrecover` on a 65-byte signature will turn a box payment away.
- The owner is fixed: there is no owner rotation. A lost owner key cannot change rules or withdraw (the agent can still
  spend inside the rules until `expiresAt`); a stolen owner key controls the box.
- `setRules` rewrites all five rules at once: check the agent address every time you change a limit.
- A signed x402 authorization that nobody settled yet can be voided only by pausing, changing the rules, or spending
  its slot; the box refuses USDC `cancelAuthorization` digests like every other foreign digest.
- Circle, as USDC's issuer, can pause USDC or block an address; that stops the agent and the owner alike.
- Send money to a box, never to the factory or the implementation: neither has anyone who could take it out.
- Reviewed by its own tests, 18 planted faults and an independent AI review (Fable, 7 Oct 2026: nothing above low; the
  four low findings are fixed); not audited by a security firm. Put in what you would give the agent anyway.

## Contracts on Arc mainnet (chain 5042)

| | address |
|---|---|
| MandateFactory | [`0x69e444f722666e13e171181efe054a93e0976b26`](https://explorer.arc.io/address/0x69e444f722666e13e171181efe054a93e0976b26) (block 24,802,686) |
| MandateBox implementation (clones run this code) | [`0xb380369c90918baaebadd48b26e2d12def74ef9b`](https://explorer.arc.io/address/0xb380369c90918baaebadd48b26e2d12def74ef9b) |
| Our own demo box (our money) | [`0xe879dcb80336363ff3b24f6504ffcbaca6bf50e8`](https://explorer.arc.io/address/0xe879dcb80336363ff3b24f6504ffcbaca6bf50e8) |

The deployed factory's runtime code equals this repository's build (solc 0.8.28, optimizer 200, cancun) with immutables
masked, and both contracts are source-verified on the Arc explorer (8 Oct 2026); every box shows there as an EIP-1167
clone of the verified MandateBox. Live proof, 7 Oct 2026, from `examples/demo-agent.mjs`:
[x402 payment approved by the box](https://explorer.arc.io/tx/0x3eecb7ff6d3a026c73c02405395e3a11ef2f3bc8ebfed90375cdbdac8dd17df7),
[direct payment](https://explorer.arc.io/tx/0xff60c87d8dd8a688fe25996418c3a735bbdb640350d5aa2f964734e0c0fda627),
[over-limit payment refused on chain](https://explorer.arc.io/tx/0x2a2e7114306e5c4dcd4cc930a305478d65d2eb9e09460055de14cad404161bd2) (`Refused(6)`).
