# APEX Treasury Operator

**An AI agent that runs a real business's money on Arc, inside written limits, several of them enforced in code.**

Built for the Tameion Agents Hackathon (Canteen x Circle x Arc), RFB 04 "Autonomous Business Operator".
Live: https://apexfaucet.xyz

---

## What it is
APEX Faucet is a live business on Arc and X1: a free USDC faucet for people, and paid on-chain data for AI agents. It has one human founder. **An AI agent (Claude) operates it day to day.** It:
- **Earns:** sells data per call over x402 (90 paid products on 8 Oct; USDC on Arc and Base, Circle Gateway nanopayments, Solana, BNB, X1), with an MCP server of 153 tools, plus a $5 card pass for agents without a wallet.
- **Holds and moves funds:**
  - its Arc trader pays half of every winning close into the faucet (in batches, since 24 Sep);
  - it bridges with CCTP and prices its own products;
  - it buys services from other Arc agents, paid out of last week's revenue, and rates them on chain with a public receipt (`operator/buy-and-rate.js`);
  - it tests yield with small, capped amounts: UBI on Arc bought for 19.50 USDC and held for that token's daily USDC payouts: 0.168 USDC received 1-7 Oct (the payout contract's own `claimed` total).
- **Pays out:** the Arc faucet pays USDC from a public contract with no withdraw function (`0x53fb2e89834050afaa9b3090a1fc9d1064615805`), three times a day per person.
- **Keeps books it cannot fake:**
  - A sandboxed accounting layer (no keys, allowlisted network only) reconciles every registered wallet every two hours and records an alert on any outflow nobody recorded. Its exit tests, planted faults and September backtests, all pass on 8 Oct.
  - A shared payment recorder writes down what each sender sent, from the transaction it signed; 17 sending code paths use it, and a nightly check fails any new sender that does not.
  - A central send gate (`/etc/apex/send-gate.json`, root-owned) puts per-payment and per-day caps on every value send on Arc and Base, and a fixed list of destinations on most of them: 16 senders, all enforced.
  - A second model reviews new contracts and changes with real money at stake before they go live.

**New, 7 Oct: [Arc Mandate](https://github.com/apexfaucet-hub/arc-mandate)**, the same idea made on chain for anyone: a spending box with rules for AI agents. The owner puts USDC in and sets the agent, the most per payment, payments per UTC day, payees and an end date; the contract checks every payment, by standard x402 (EIP-3009 with the box as payer, approved through EIP-1271) or directly. No admin, no fee. Live at [apexfaucet.xyz/arc/mandate/](https://apexfaucet.xyz/arc/mandate/), source-verified on the Arc explorer, with an x402 payment, a direct payment and an over-limit refusal on mainnet.

The limits are in [`limits/LIMITS.md`](limits/LIMITS.md). The code that enforces them is below.

## Traction (read 8 Oct 2026, ~04:00 UTC; small, and stated as it is)
- **464 paid calls from 13 outside wallets**, $2.08 in total ($0.11 refunded). Every one of our own wallets is excluded.
- **Our first repeat agent customer** was an autonomous trading agent on Arc that bought our Arc new-launch feed again and again; it stopped on 2-3 Oct when its own balance ran out (we name no customer).
- **246 USDC claims paid** by the Arc faucet contract (6.96 USDC); the X1 faucet has paid 7,185 claims to 1,307 wallets since 25 Nov 2025.
- **Registry:**
  - We are ERC-8004 agent #1 in Arc's identity registry; since 30 Sep its wallet is the address our revenue lands in.
  - Our Watchtower (#211) checks every registered Arc agent every hour: 2,306 registered, 1,113 answering, 81 payable on Arc (7 Oct).
- **Circle's seller readiness check** reported 100/100 on 30 Sep.

## Circle tools used
- **Circle Gateway:** gasless nanopayments accepted on Arc and Base.
- **USDC as gas on Arc:** EIP-3009 settlement.
- **CCTP:** bridging.
- **Circle's x402 seller spec:** our OpenAPI carries `x-guidance`.
- **Earn Kit (Arc mainnet):**
  - vault discovery and quotes;
  - a guard that checks on chain whether a vault can actually pay out before any float is parked (`operator/vault-guard.js`);
  - a send gate that decodes and checks every transaction the SDK asks to sign.

## Repository map
| Path | What it does |
|---|---|
| `accounting/lib`, `accounting/tools` | The accounting layer: wallet registry, balance snapshots on 4 chains, verification, a ledger read from the senders' records, reconciliation of each balance change (by transaction hash, with fees and rent), alerts recorded in a summary, the readiness count, and the safety sweep that must pass before each cycle. It runs as its own user, with no keys and no network except an allowlisted proxy (`account-run.src.sh`). |
| `operator/ledger-log.js` | The shared recorder: a sender records the native value that left each wallet (transfers, account rent, program escrow) from the transaction it built and signed. It never mirrors a wallet's history, because a copied history would "explain" a drain too. Reviewed on 29 Sep; six findings are open, and no sender uses it yet. |
| `operator/sweep-ledger-coverage.js` | Fails the nightly check when a new sender file skips the recorder. It stops new files, not a new send added inside a file that is already listed. |
| `operator/deploy-gate.sh` | Syntax check; refusal while the accounting cycle runs or within 10 minutes of it; a backup with a one-line undo; then a health check. |
| `operator/data-pass.js` | The $5 card pass: the key is derived and never stored; one payment is one pass; refunds and disputes revoke it; a call we fail to answer is not charged. |
| `operator/prices.js` | One price list for every payment rail and every public surface. |
| `operator/vault-guard.js`, `operator/park-float.js`, `operator/vault-check.js`, `tools/vault-board.js` | Idle float with Circle Earn Kit. On-chain payout check (idle funds plus the vault's own withdraw market), a send gate that decodes every transaction, an exit rule, and a board of every Arc USDC vault. **On 30 Sep no vault passed every rule** (`data/vault-board-2026-09-30.json`): 22 failed the liquidity checks or carry Circle's own warnings; 2 passed the on-chain checks, but earn less than their gas at any size within our 5 USDC cap. |
| `operator/buy-and-rate.js` | The purchase workflow (RFB 04: revenue in, pay for a service, record it). It spends at most last week's outside revenue. It buys one real x402 call from another Arc agent, proves the settlement of its own authorization on chain, grades delivery (not taste), and writes an ERC-8004 rating with a public receipt. |
| `operator/arc-send-gate.js`, `operator/send-gate.example.json` | One gate every value sender on Arc and Base asks first: per-payment and per-day caps, a destination list checked on chain, a kill file, shadow then enforce, fail closed. |
| `operator/ledger-log-evm.js` | The recorder for Arc and Base. It reads the value that left from the receipt (on Arc, the native USDC log), bounded by what the sender meant to move. More, or an asset it did not name, is not recorded, so the books alarm. |
| `operator/arc-gas-refill.js` | Keeps the Arc operator's gas topped up from our own receive wallet, through the gate and the recorder, once per 24 hours, with a drain stop. |
| `operator/bsc-facilitator.js` | x402 on BNB Smart Chain: USD1 and U by EIP-3009, signing domains proven on chain at boot, the payer's balance read before we spend gas, minimum $0.01. |
| `checks/arc-outflow-watch.js`, `checks/check-send-gate.js`, `checks/check-account-status.js`, `checks/check-fee-wallets.js` | The alarms: money leaving to a stranger with no record, a gate refusal, the books stopping or finding something new, a gas wallet running low. |
| `accounting/lib/annotation-filter.js`, `accounting/tools/account-retract.js` | Hand notes may never carry fees and may never overwrite each other; alerts created by a hand-run method error can be retracted only with a stored reason. |
| `tests/*.test.js` | Planted faults for each control (the recorder replays real Arc transactions into a scratch ledger). |
| `tests/vault-guard.test.js` | 45 checks: planted forbidden transactions (wrong receiver, stranger as beneficiary, permits, unlimited approvals, fees, exotic transaction types, non-read RPC methods, off-chain signing) must be refused, the legitimate shapes must pass, and three real vaults must be refused. Needs the network. |
| `checks/bundle-check.js` | The method behind one of our paid checks, published deliberately: was this Arc launch bundled? It reads the launch transaction, the first two minutes of buys, and where each early buyer's USDC came from. It needs our Arc pool index and exit probe (not included) to run. |
| `operator/hand-gate.js` | 7 Oct: the hand-run money tools (buyback, APEX sale, liquidity, CCTP Arc to Base, Solana to Arc relay) ask the send gate before they sign and record what they sent. Refused means exit 4 and nothing signed. |
| `accounting/tools/account-explain.js` | 7 Oct: closes old, tiny unrecorded-outflow alerts by a recorded decision that says what they were (max $0.05 each, raised before a cutoff, inside the sandbox). It never writes ledger rows from chain history. |
| `operator/refund-base.js` | 7 Oct: refunds a paid call we charged and did not deliver. The payer and amount are read from the payment transaction on chain; a double refund or more than 0.05 USDC is refused; the send asks the gate (sender `base-refund`). First use: a payment prober was charged $0.003 for a call that had no parameters and got a 400; refunded the same hour. |
| `checks/check-blank-paid-calls.js` | 7 Oct: every paid endpoint must refuse a call that is missing its inputs BEFORE it takes money. The check fails when a blank paid call would be charged and then refused. |
| `checks/sweep-live-senders.js` | 7 Oct: follows every running service, timer and cron line into the code it loads, and fails when a sender there can sign for a watched wallet and records nothing. |

First live run, 30 Sep: Argos Bot (#304) was paid 0.007 USDC, delivered, and rated 100. Three agents answered 402 to the official client's payment; nothing settled, so nothing was rated (reported to their maintainer). Reviewed by Fable: 7 must-fixes, all in.

## How to verify us (no trust needed)
- Paid endpoints and prices: https://apexfaucet.xyz/.well-known/x402
- OpenAPI with agent guidance: https://apexfaucet.xyz/openapi.json
- Every Arc agent, checked hourly: https://apexfaucet.xyz/arc/agents/
- Faucet contract on the Arc explorer: `0x53fb2e89834050afaa9b3090a1fc9d1064615805`
- The card pass: https://apexfaucet.xyz/pass/

## Honest limits
- **Revenue is tiny.** The recurring x402 market on Arc is small.
- **This is the operator's control layer,** not a one-click app. It contains no keys.
- **The copies differ from live in two ways.** They were taken from the live tree on 30 Sep 2026 and updated on 6 Oct 2026, and the live tree is the source of truth.
  - **Secret paths:** where the live code names the secret paths on our server (`assert-sandboxed.js`, `sweep-account-safety.js`), these copies read them from an unpublished config instead (`accounting/secret-paths.example.json` shows its shape).
  - **Personal details redacted:**
    - comments reworded in `registry.js`, `extract.js` and `account-snapshot.js`;
    - one test in `account-exit-tests.js` checks the founder's wallets by class instead of by address;
    - the one-off registry seeding tool is not published.
- **The accounting layer is an alarm, not a certificate.** It runs every 2 hours and raises an alert for any balance change nobody wrote down. On 6 Oct, Arc and Base were fully explained; 14 small X1 fees from older bots are still open.
- **No money has been parked in a vault yet.** The live probe waits until the accounting layer is ready, so a new kind of outflow never lands while the books are still being proven.

## Running
`npm install`, then `npm test`. The test needs network access to Earn Kit's vault list, Morpho's public API and an Arc RPC.

## License
MIT
