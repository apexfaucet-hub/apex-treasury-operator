# Arc services (added 7 Oct 2026)

Live at apexfaucet.xyz. Everything here reads Arc mainnet (chain 5042) directly; numbers on the pages come from the chain, rates from Circle Earn Kit.

| file | what it does |
|---|---|
| `arc-yield.js` | Every vault Circle Earn Kit lists on Arc, with rate, size and **how much can be withdrawn right now** (idle USDC + the free supply of the market the vault's withdraw path draws from, read from Morpho Blue). Writes the board behind `/api/x402/arc-yield` and the page `/arc/earn/`, every 15 minutes. |
| `earn.js` | The page's deposit/withdraw from the visitor's **own wallet**: approve the exact amount, `deposit(assets, wallet)`, `redeem(shares, wallet, wallet)` on the Morpho Vault V2. Receiver is always the connected wallet (re-checked before every send); deposits larger than what could come back out right now are refused; every call is simulated first. |
| `arc-earn-test.js` | The round trip we ran with our own 0.02 USDC before any user saw the button (approve `0x65420be7…`, deposit `0x45efa1e0…`, redeem `0x763f53ca…`). |
| `fair-score.js` | The watchtower's published 0-100 rubric (`apex-watch-v1`): file readable, endpoints, answered hourly checks, Arc payment verified, domain verified, speed, outside payers. Points only for what was verified. |
| `fair-rate.js` | Writes that score to the ERC-8004 reputation registry from agent #211 (tag `score`/`apex-watch-v1`, evidence hashed on chain). Skips every agent owned by our wallets; at most 60 writes a day; only after 6+ measured hours. |
| `rate.js` | "Rate on Arc": any visitor rates any agent from their own wallet; the project's own wallets are refused (hashed list). |
| `check-arc-ratings.js` | Nightly check: our agents' on-chain reputation, the rater's gas, failed writes. |
| `arc-watchtower-gas.js` | Tops up the rater's gas between our own wallets through the send gate (1 USDC a day cap). |

We never write a rating about ourselves, and nothing is given in return for a rating.

## The operator's hour (operator/treasury-tick.js)

Runs every hour on our server. If the treasury holds a vault position it runs the exit rule (`park-float.js check`); otherwise
it picks the best-paying USDC vault that `vault-guard.js` allows and runs `park-float.js park`, which still refuses unless the
books are sure (latest cycle complete, no open Arc/Base alert), 30 days of yield pay for the gas in and out, the central send
gate (`SEND_GATE_LIB`, sender `arc-treasury-park`: our UBI wallet, Circle's Earn adapter only, 1 USDC per send, 2 a day) and
the transaction-shape gate all pass. Every hour's decision and its reasons are written down, including "did nothing". On
7 Oct the guard allowed one vault for 0.46 USDC and the economics rule refused it (30-day yield 0.00065 USDC < 0.020 gas).
