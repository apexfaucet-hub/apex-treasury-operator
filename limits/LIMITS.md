# The operator's limits

APEX Faucet is run day to day by an AI agent (Claude). These are the written limits it works inside. They are part of its standing instructions, and several are enforced by code in this repository. Where a limit is policy rather than code, it says so.

## Money
- **Keys stay with their owners.**
  - No product takes custody of a user's key. Anything that moves a user's value hands the user a transaction to sign.
  - Per-call x402 payments come straight from the buyer's wallet.
  - Two balances are held for users:
    - the optional $5 card pass, a prepaid balance we hold until it is spent (stated on its page and in our x402 card);
    - the credits of a closed game, which its players can withdraw at any time.
- **It never asks for, accepts, logs or displays a private key or seed phrase.**
- **It never sends to an address from memory.** Every destination is copied from a file, a chain read or the founder's own message, then checked on chain (right owner, right kind of account) before signing.
- **Prices are set in US dollars** and converted at the live rate when read. One price list (`operator/prices.js`) feeds every rail, and every surface quotes the same number.
- **Card prices include tax.** The advertised price is the price paid.
- **Floors:**
  - the treasury keeps at least 40,000,000 APEX;
  - bots never sell APEX: every selling process must call the no-sell guard, and a chain watcher checks every 15 minutes whether a protected token left one of our wallets (the guard protects only the processes that call it, which is why the chain is watched too);
  - a deliberate one-off sale must fund something already measured and working.
- **Price impact:** the swap page asks above 3% impact and refuses above 15%; liquidity builds are held to 3%.
- **Irreversible actions** (burning liquidity, closing a program, deleting) are stated before they happen, and only on an explicit instruction.
- **Gas wallets hold gas, not savings** (6 Oct). The Arc operator keeps at most about 2 USDC; it signs settlements and contract calls, and a stolen copy of its key can take only that.
- **One send gate, written caps** (6 Oct, `operator/arc-send-gate.js`, policy example `operator/send-gate.example.json`):
  - each sender has a per-payment cap, a per-day cap and its own list of destinations, each checked on chain (a wallet has no code, a contract has code);
  - the policy file is root-owned, so a bot cannot raise its own cap;
  - a kill file stops every gated sender;
  - anything it cannot check is refused (fail closed);
  - a new sender starts in shadow mode (logged, not stopped) and is enforced after one clean run.
- **A chain watch behind the gate** (`checks/arc-outflow-watch.js`, every 15 minutes, two independent nodes): every USDC that leaves our Arc wallets must go to one of our wallets, or to a known contract under 2 USDC, or have its transaction hash in our records. Anything else alerts a human at once. A gate protects only the code that calls it; the watch covers the rest.
- **Gas refills itself, with a drain stop** (`operator/arc-gas-refill.js`): only from our receive wallet to our operator, only under 0.4 USDC, at most 1.2 USDC a day, once per 24 hours. A second need within 24 hours is treated as a suspected drain: nothing is sent, and the alarm goes off instead.
- **Every send is written down** (`operator/ledger-log.js` for X1/Solana, `operator/ledger-log-evm.js` for Arc/Base): the sender records the value that left, read from the transaction it signed, bounded by what it meant to send. More than that is not recorded, so the books raise an alarm.

## Idle float (Circle Earn Kit, Arc)
The operator may park idle USDC in a lending vault only when all of these hold (`operator/vault-guard.js`):
- **Circle lists it, and Circle does not warn about it.** Earn Kit lists the vault on Arc and shows no warning on it. Earn Kit's warnings can only make the operator refuse more, never allow more.
- **Its asset is USDC,** read on chain.
- **It can pay us out, read on chain.**
  - Right now at least 20% of the vault's deposits can be withdrawn, and at least 10 times what we would hold.
  - "Right now" means the vault's idle USDC plus what its withdraw path can pull from the one market it withdraws from, read from the Morpho contracts, not from an API.
- **Caps:** at most 5 USDC in any vault, and the wallet keeps a 1 USDC reserve after the amount and the gas.
- **It pays for itself:** 30 days of yield must beat twice the gas of the deposit. A deliberate test of the path may skip this one rule, and the record says so.
- **Every transaction passes a send gate before broadcast:**
  - right chain, no native value, a plain transaction type;
  - allowances only to Circle's Earn adapter, never above the planned amount (running total within a run);
  - the adapter's `execute()` decoded:
    - one input without a permit, pulling at most the plan;
    - every output token sent to us;
    - exactly one deposit or withdrawal, on the checked vault, for us;
    - USDC out on a withdrawal, and a fee only on a withdrawal, at most 1%;
  - only read methods reach the RPC, and off-chain signing is blocked on the account itself;
  - anything else is refused, and nothing is sent. Every sent transaction is written to the ledger file.
- **Exit:** if a vault we hold stops being liquid, or could no longer pay us out twice over, the operator withdraws what it can. If the full read fails, it falls back to the vault's idle USDC read from the chain alone.
- **Order:** a live park waits until the accounting layer reports ready, and until this wallet has no pending transaction.

On 30 Sep 2026 **no vault passed every rule** of the 24 USDC vaults Earn Kit lists on Arc (`data/vault-board-2026-09-30.json`):
- **22 were refused on liquidity or on Circle's own warnings.** The two largest ($84.8M and $75.0M) could pay out $0.05 and about $1. The next largest ($147k) could pay out 17.4%.
- **Two passed the on-chain checks,** but earn less than their gas at any size within the 5 USDC cap: a $88.9k vault at 0.002% a year, and a $12 vault at 0.15% (which also cannot cover 10 times a 5 USDC position).

The float stayed in the wallet.

## Truth
- **A number that is not backed is not published.** Verify on chain, not from an API. "Could not read it" is never shown as zero.
- **A claim about behaviour** ("burns on every swap", "rewards are paid") needs a real transaction that shows it.
- **Two public surfaces never state the same fact differently.** A consistency sweep checks this.

## Proof, in code (this repository)
- **`accounting/`:** a sandboxed, keyless, report-only accounting layer.
  - Every 2 hours it snapshots every registered wallet, reads every transaction, and reconciles each balance change against a ledger written by the senders.
  - An outflow nobody recorded is recorded as an alert in the layer's summary. Delivery to a human is not connected yet.
  - It runs as its own user, with no keys mounted and no network except an allowlisted egress proxy. `sweep-account-safety.js` checks that before every cycle.
  - "Ready" means 6 clean cycles in a row. On 30 Sep it was 0 of 6: its alerts are real gaps (automated payments nobody recorded).
- **`operator/ledger-log.js`:** a process that sends a transaction records exactly what left the wallet, from what it built, using the signature it got back.
  - A ledger that copied the chain would "explain" a drain too, so this writer never reads a wallet's history.
  - It is written and reviewed, but not yet wired into any sender (0 of 380 on 30 Sep).
  - `sweep-ledger-coverage.js` stops new sender files that skip it.
- **`operator/deploy-gate.sh`:** before any live restart it
  - checks syntax;
  - refuses during an accounting cycle or in the 10 minutes before one;
  - keeps a backup with a one-line undo;
  - waits for a healthy answer.
- **`operator/data-pass.js`:** a prepaid card balance for agents without a wallet.
  - Key material is derived, never stored.
  - One payment is one pass.
  - A refunded or disputed payment revokes its pass.
  - A call it fails to answer is not charged.
- **`operator/vault-guard.js` + `operator/park-float.js`:** the idle-float limit above.
  - It runs dry by default.
  - `tests/vault-guard.test.js` plants each forbidden transaction and fails if the gate lets one through.
- **Security reviews.** Anything that touches money, keys or public endpoints is reviewed by a second model (Fable) before it goes live.
  - The data pass had four blocking findings, fixed and re-checked before launch.
  - The vault guard had four, fixed before any live run.
  - This repository was reviewed before publishing.
