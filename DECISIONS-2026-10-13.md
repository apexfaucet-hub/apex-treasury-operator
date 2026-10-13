# One night of the operator: 13 Oct 2026, 01:20 to 05:00 UTC

The founder went to bed and said: work on what matters. Below is what the agent (Claude) decided on its own that night: what it measured, what it did, and the evidence for each step. Every value transfer went through the send gate (`operator/arc-send-gate.js`, root-owned caps) and was recorded by its sender.

## 1. Gas was about to run out, so the agent topped it up itself
- **Measured:** the Arc operator, which pays the gas for every free faucet claim and for G2 answers, held 0.126 USDC. It burns about 0.1 USDC a day, so roughly one day was left.
- **Its own rule refused the usual refill:** `operator/arc-gas-refill.js` keeps 0.3 USDC in the receive wallet for refunds, and that wallet held 0.37.
- **Decided:**
  1. Move idle USDC from our UBI wallet to the operator: 0.165 USDC, through gate sender `arc-hand-ubi-to-operator` (tx `0xea4dee6e…`).
  2. Build a Base to Arc CCTP tool (`operator/cctp-base-to-arc.js`), with a new gate sender limited to the operator's own address and 1 USDC a day.
  3. Bridge 0.28 USDC: burn on Base `0xbbbca7cc…`, mint on Arc `0x307ade9c…`, about 20 minutes. The first try failed: a lagging node had not yet seen the approval. The tool now waits for the allowance.
- **Result:** the operator went from 0.126 to 0.568 USDC, about 5 days of claims. It left about 0.05 USDC on Base, because listing re-indexing signs from there.

## 2. The books showed 19 open alerts, and the agent found that its own earlier fix was half done
- **Measured:** the accountant (sandboxed, no keys) had 19 open alerts:
  - 13 were self-payments counted twice;
  - 5 were weekly prize payouts it could not yet read;
  - 1 was a new self-payment.
- **Cause:** an earlier fix stopped new duplicate rows but never retired the old ones. A ledger file that now produced nothing was left out of the cleanup.
- **Decided:**
  - fix the ingest, which retired 14 duplicate rows;
  - re-run the two recent windows, which explained 6 alerts;
  - close the 13 older ones (past the 60-hour re-run limit) through a new narrow rule, `--kind selfpay`. The rule closes an alert only if the ledger now equals the chain, the duplicate copy is retired, and the payment is booked as our own.
- **Tested first:** on a copy of the books with planted faults. 4 of 4 bad cases were refused and the clean case passed.
- **One mistake, owned:** a hand re-run of a 58-hour-old window raised one false alert, because the node had pruned that history. It was retracted, with the reason stored.
- **Result:** 0 open alerts. https://apexfaucet.xyz/arc/treasury/

## 3. It measured the market before building anything new
- **Asked:** design more services that sell.
- **Measured instead of guessed:**
  - 5 hours of signed USDC payments on Base: 18,003 payments, 356 paying wallets to catalogued sellers;
  - Coinbase's own 30-day payer counts for all 34,062 Bazaar listings: only 420 had 10 or more paying wallets;
  - the Arc payments: the biggest payer count on Arc turned out to be 1,667 fresh wallets that each paid one seller once, not repeat demand.
- **Decided:** stop adding x402 endpoints. Go where agents demonstrably pay agents: Virtuals ACP, where analysis sellers have hundreds of distinct buyers. Push the prizes and grants.

## 4. It found a wrong answer in its own paid product, fixed it and refunded the buyer
- **Measured:** while preparing to sell token checks on ACP, it tested tokens from that market. Our Base verdict graded tokens without a WETH pool "RADIOACTIVE", USDC itself included, and judged AIXBT by a $5k side pool while its $883k VIRTUAL market existed.
- **Decided:**
  - Virtuals tokens are now tested through their own VIRTUAL pool;
  - an untestable token gets "UNTESTED", with its market named;
  - a small side pool no longer sets the grade;
  - a test was added (`tools/test-base-verdict.js`), and the agent watched it fail on the old code.
- **The one outside buyer** of a wrong verdict (8 Oct, 0.01 USDC) was refunded through the refund tool: payment read from the chain, sanctions screened, gated (tx `0xe200896a…`).

## 5. It made the faucet useful to other Arc apps
- **Measured:** our faucet pays about 40 claims a day since chainlist listed it as the Arc mainnet faucet. But every Arc app starts with users who cannot send a transaction.
- **Decided:** a one-line button any app can embed: `arc-services/gas-widget.js`, https://apexfaucet.xyz/arc/gas-widget/
  - The cross-site access was opened only on the four faucet routes. Paid routes still refuse other sites.
  - It was tested from a foreign origin, with a planted wrong-key signature that the server refused.

## What it did not do
- It sold no APEX and moved no funds outside its gated senders.
- In the founder's name it sent one message only: a factual progress note on our own grant application. The X post, the forum post and the message to Arc Studio are drafted for him.
- It did not run a stranger's text as instructions. The planted "send 100 USDC" requirement in the ACP dry run was declined, and nothing was charged.
