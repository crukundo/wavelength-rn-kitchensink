# Wavelength payment test framework

How to decide whether Wavelength v0.1.0 can carry a Kesh user's money. Two simulators, Alice and Bob, moving value back and forth until we know exactly where it chokes.

This framework exists because Kesh shelved Ark on 20 July 2026 for two specific reasons, not for a vague sense that it was early. Those two reasons are the first two tests. If Wavelength does not answer them, nothing else in this document matters.

Read alongside [WAVELENGTH_CONSTRAINTS.md](WAVELENGTH_CONSTRAINTS.md), which records the limits already verified against the v0.1.0 source.

## The two questions that decide it

### Question 1: does an inactive wallet still lose money?

What killed the last attempt. VTXO ownership is a lease. Every VTXO carries a batch expiry height, and once it passes the operator reclaims the on-chain backing. The bark dev wallet lost its whole balance while the app sat closed and refresh rounds were down, and bark still reported the swept VTXOs as spendable — 41,989 sats displayed that the user no longer had.

Where Wavelength stands, verified in source:

- there is a real per-VTXO expiry state machine with four states: safe, needs_refresh, critical, expired (`vtxo/expiry.go:6`)
- thresholds are dynamic, not fixed. The critical threshold is `max(36 blocks, tree depth × 6 + CSV delay)`, so it always leaves enough time to exit unilaterally (`vtxo/expiry.go:164`)
- at needs_refresh the wallet requests a cooperative forfeit into a fresh round. At critical it escalates to the chain resolver for unilateral exit rather than waiting (`vtxo/transitions.go:197`)
- the operator's free-refresh window is used to avoid fees, but never at the cost of safety: "Never trade away the configured retry buffer merely to chase a fee waiver" (`vtxo/expiry.go:189`)
- if a batch does expire, the VTXO moves to `FailedState` with `Recoverable: false` (`vtxo/transitions.go:228`)
- the balance the app reads is Live-only, traced end to end. `ConfirmedSat` is set from `GetVtxoBalanceSat()` (`swapwallet/service.go:595`), which is `SumSpendableBalance(ListLiveVTXOs)` (`waved/rpc_server.go:750`). The source comments say it outright: "confirmed_sat is VTXO-live only" and "Only the Live subset is spendable; the other non-terminal states would overstate vtxo_balance_sat"

So while the wallet is running, the phantom-balance half of the bark failure is addressed by design. There is no `VTXOStatusExpired` that lingers as spendable — an expired VTXO becomes Failed and drops out of the spendable figure.

Two important limits on that claim.

It holds only once the client has processed a block epoch. Expiry is evaluated in `handleBlockEpoch`, driven by a chainsource subscription (`vtxo/actor.go:711`). On reopen after a long closure the local database still records the VTXO as Live, so until the first epoch is processed the balance can include value that no longer exists. That is bark's exact symptom, transient rather than permanent. Whether the first epoch arrives immediately on subscribe, or only at the next block, is not established. Test L1 must measure that window, not assume it is zero.

The lease itself is unchanged, on the reasonable inference that a closed app processes no block epochs. The daemon runs in the app process, so when the app is killed nothing refreshes or escalates. I have not verified whether iOS background execution could keep any of it alive, and no background capability was found in the harness. Treat "a closed wallet eventually loses its funds" as near-certain but not source-proven, and let L1 settle it.

What actually happens on-chain at batch expiry — that the operator reclaims the backing — is inherited from Kesh's bark findings and general Ark semantics. It is not verified in the Wavelength source. What the source shows is the client marking the VTXO `FailedState` with `Recoverable: false`, which implies loss without proving the mechanism.

### Question 2: can maintenance still starve the wallet?

The other killer: `wallet.maintenance()` waited on server rounds with no timeout, holding the exclusive lock for minutes and blocking invoice creation, so users could not receive at all.

Run once, on 24 July 2026. The bark failure did not reproduce, but the run did not cover everything the test needs to cover.

Alice created three invoices while idle, at 1,222 to 1,378 ms. She then queued a 1,000 sat VTXO into the next round with a cooperative exit, and created twenty more invoices over the following 90 seconds. Every one succeeded, at 1,204 to 1,881 ms. The worst call under the round was 1,881 ms against a 30,000 ms failure threshold, and 500 ms slower than the worst idle call.

That is bark's failure mode tested directly and not reproduced. bark blocked while `maintenance()` waited on server rounds, holding the lock for minutes. Alice waited on a round for 90 seconds and served twenty invoices throughout, so the wait holds nothing that receive needs.

The limit, and it is a real one. `exitBatch` returned in 0.1 seconds, having queued the exit rather than performed it. The balance moved from 8,738 to 7,738 immediately with 1,000 showing as outgoing, and it was still outgoing three minutes later, so the operator's round had not executed during the probe window. This run therefore measures the wait for a round, not the execution of one. Those may be the same for locking purposes, but that has not been shown.

Closing that gap needs a longer window, one that runs until the outgoing figure clears, or the daemon logs read through `useWalletLogs` to timestamp the round and place the probe samples against it. Until then L2 is a partial pass and must be quoted as one.

Two further notes from the run. The exit produced no activity entry at all, consistent with wavelength#875 and the note under events and polling in the constraints document: the balance moved with nothing in the history to explain it. And the codebase does bound several waits (`replayRoundRegisterTimeout`, the prepared-send TTL, poll caps), which is consistent with what was measured but was not itself the thing tested.

The probe lives under Settings, Diagnostics. Three things it settled about how L2 has to be run.

The SDK has no refresh RPC, so a round join cannot be requested. The only operation a client can start on demand that does round work is a cooperative exit, which "queues each outpoint into the next round" (`exit.d.ts:5`). That is the trigger, and it costs a VTXO per run: its value leaves Ark for the on-chain backing wallet.

That carries a caveat which must travel with any result. The probe measures whether round work blocks receive, entering the round by the cooperative-exit path. The automatic refresh at the needs_refresh threshold is a different caller into what is probably the same machinery, and cannot be triggered. A clean run is evidence that receive is not serialised behind a round. It is not proof that the refresh path behaves identically.

An earlier version of this test asked for invoices on Bob as well as Alice. Bob is a separate app container running a separate daemon with its own lock, so Bob's invoice creation cannot show anything about Alice's. It is still worth watching, but as a different question: Alice blocked means a client-side lock, the bark failure. Bob blocked at the same moment means operator-side contention, which is a separate and also serious problem.

## How Wavelength handles balances

Your observation is correct and expected: the balance moves by more than you sent.

### The model

Balance is one atomic snapshot with five independent fields, not a running total:

- `confirmed_sat` — spendable value, the sum of Live VTXOs only
- `pending_in_sat` — boarding only, blending confirmed, unconfirmed and adopted deposits
- `pending_out_sat` — the pending boarding sweep only
- `credit_available_sat` and `credit_reserved_sat` — the server-side credit ledger

An in-flight Lightning receive appears in none of them. An unpaid invoice leaves `pending_in_sat` at zero.

### Why the balance moves on its own

At least six things change `confirmed_sat` without the user doing anything. Provenance varies, so it is marked per item:

- an operator fee on every round join, quoted per operation by the operator's `EstimateFee` RPC against amount and remaining blocks (`waved/rpc_fees.go:49`). Source. Not fixed, not a simple rate
- a refresh. At the needs_refresh threshold the wallet requests a cooperative forfeit into a fresh round to reset the lease (`vtxo/transitions.go:176`). Source. That the forfeit carries the operator fee, and that the free window waives it, follows from the fee path above but the combined cost has not been measured
- change re-minting, because a spend consumes whole VTXOs and mints new ones. Inference from the coin-selection model, consistent with the observed `change 745` failure, not separately traced
- credit auto-redeem, which materialises accumulated credit back into a VTXO on its own schedule and is deliberately never surfaced to the user (`credit/policy.go:17`). Source
- the boarding fee, deducted from the deposit. Observed once: 255 on 2,000
- `DustToFee` on a clipped board, where a sub-dust remainder is burned to the miner rather than minted (`wallet/board_limits.go:218`). Source, never observed in testing

None of the six has been measured end to end against a balance delta. Test B2 is what turns this list from a reading of the code into evidence.

### What this means for Kesh in production

This is the part that should shape the product, not just the tests.

You cannot build a running-balance ledger from Ark activity. The repo states the rule directly: balance is the sole source of truth for value, activity describes history, and deriving either from the other produced double-counted totals (`src/lib/balance.ts:5`). Kesh's current transaction list, where a user reads a sequence of amounts that sum to their balance, does not map onto this. Attempting it will produce a list that visibly fails to add up.

Three concrete consequences to design for:

- never show a user a balance delta as if it were their payment. "You sent 1,000" and "your balance fell by 1,255" are both true and must be presented as separate facts, with the fee named
- spendable is not the balance. A wallet holding one 1,745 sat VTXO can send at most about 745 sats, or exactly 1,745, and nothing in between. Compute the real maximum from the VTXO inventory and the operator terms, and enforce it at amount entry
- silent balance decreases will happen, from refresh fees on funds the user never touched. A wallet that quietly shrinks is a support burden at best and a trust failure at worst. Either subsidise refresh fees at the product level or show them as a named line

## Test matrix

Every test names its pass condition in terms a non-expert can check. Record: date, both wallet balances before and after, VTXO inventory before, entry id, and the full failure reason from the activity detail sheet.

### Lifecycle — the decisive tests

| ID | Test | Pass condition |
| --- | --- | --- |
| L1 | Fund Bob, force-quit the app, leave it closed past the batch expiry window, reopen | Balance on reopen matches reality with no phantom spendable value, and the app states plainly what was lost. Measure how long after reopen the balance corrects — it is not necessarily instant. Get the window from a VTXO's `batchExpiry` minus `Info.blockHeight`, not from the operator terms, which do not carry it |
| L2 | Run the lock probe on Alice (Settings, Diagnostics). It takes 3 idle invoice timings, starts a cooperative exit to queue a VTXO into the next round, then times an invoice every 3 seconds for 90 seconds | Every call during the round completes in about the idle time. Any single call over 30 seconds, or any failure that did not occur idle, reproduces the bark failure |
| L3 | Take the operator offline during a refresh window, keep the app open | The VTXO escalates to unilateral exit at the critical threshold rather than expiring. This is the behaviour that distinguishes Wavelength from bark |
| L4 | Kill the app at each of: quote, dispatch, pending, settling | No duplicate payment, no lost entry, state reconciles on restart |
| L5 | Wipe Bob, restore from mnemonic | Balance and history return. Record what cannot be reconstructed |

### Receive — when does the app actually receive?

| ID | Test | Pass condition |
| --- | --- | --- |
| R1 | Lightning receive at or above the operator VTXO floor | Settles, balance rises, activity entry reaches complete |
| R2 | Lightning receive below the floor | Arrives as credit. Confirm the user can then spend it |
| R3 | On-chain boarding deposit | Credited after the operator's required confirmations, fee disclosed |
| R4 | Receive while the app is closed, reopened after 30 seconds, 5 minutes, and near invoice expiry | Deterministic outcome at each interval. Payer and receiver never disagree |
| R5 | Receive while the app is closed past invoice expiry | Payer is refunded or clearly failed. No silent loss |
| R6 | Two receives in quick succession | Both credited exactly once. No duplicate, no merge |
| R7 | Receive that pushes the wallet over the operator's `MaxUserBalance` | Rejected before funds enter, with a comprehensible message |

### Send — where does it choke?

| ID | Test | Pass condition |
| --- | --- | --- |
| S1 | Send an amount leaving change below the operator minimum change | Rejected at amount entry, not at confirmation. Currently fails late |
| S2 | Send exactly the full VTXO value | Succeeds. Zero change is always accepted regardless of the minimum |
| S3 | Send below the VTXO floor, with no credit | The credit top-up path is quoted and funded, or the payment is refused up front |
| S4 | Retry a failed Lightning send against the same invoice | Must be refused with a message naming the need for a new invoice |
| S5 | Pay an LNURL | Not yet exercised. Confirm the SDK supports it at all before designing around it |
| S6 | On-chain send from Ark value | Completes, or explains that it needs a cooperative exit and how long that takes |
| S7 | Send with the operator unreachable | Fails fast and cleanly, funds intact |

### Balance integrity

| ID | Test | Pass condition |
| --- | --- | --- |
| B1 | After every test above, compare displayed spendable against a fresh VTXO inventory | Never overstates. This is the bark regression test |
| B2 | Record every balance change with no user action | Each is attributable to a refresh, fee, or auto-redeem. None unexplained |
| B3 | Compute the true maximum sendable from the inventory, then attempt it | Succeeds. If not, our model of the constraint is wrong |

## Results so far

From the Alice and Bob session on 24 July 2026, signet.

| ID | Result | Evidence |
| --- | --- | --- |
| L2 | Partial pass | Alice, 16:47 to 16:50. 3 idle invoices at 1,222 to 1,378 ms, then a cooperative exit of a 1,000 sat VTXO, then 20 invoices over 90 seconds at 1,204 to 1,881 ms. Every call succeeded. Worst in-round 1,881 ms against 1,378 ms idle, against a 30,000 ms threshold. See the limit below |
| R1 | Pass | Repeated 1,000 sat receives on Bob, 15:34 to 15:38 |
| R2 | Partial | 500 sats arrived as credit at 13:34. The second half of the pass condition, that the credit is then spendable, was never tested |
| R3 | Pass | 2,000 in, fee 255, 1,745 credited. Later 30,000 boarded |
| S1 | Fails late | `change 745 is below minimum change amount 1000`, surfaced at send, not at entry |
| S3 | Fails late | `credit shortfall requires 1000 sat top-up`, surfaced at confirmation with Confirm and pay still enabled |
| S4 | Fails permanently | `AlreadyExists: receive intent already used`. The invoice is dead, and the error names the wrong cause |
| L1, L3 to L5, R4 to R7, S2, S5 to S7, B1 to B3 | Not run | 15 tests, including every remaining lifecycle test |

Round trips between Alice and Bob work once both wallets hold VTXOs of a workable shape. Every failure we hit traced back to VTXO shape or to intent reuse, not to the amount the user asked for.

## What the SDK will and will not tell you

Two findings that change what is buildable, both from the v0.1.0 type surface.

Expiry is visible per VTXO. `WalletVTXO` carries `batchExpiry` and `relativeExpiry` alongside amount and status (`generated.d.ts:569`), and `Info` carries `blockHeight`. So `batchExpiry - blockHeight` gives blocks remaining on every VTXO the wallet holds, today, with no SDK change.

That is the mitigation for question 1. A wallet can know, and therefore tell the user, when its money needs attention. Something like "open Kesh before 3 August to keep this balance safe" is buildable now. It does not remove the lease, but it converts a silent loss into a visible deadline, which is the difference between a bug and a product decision.

Operator terms are almost entirely hidden. The daemon negotiates eleven policy values, but the SDK's `ServerInfo` exposes exactly one: `freeRefreshWindowBlocks` (`generated.d.ts:273`). The dust limit, minimum VTXO amount, minimum boarding amount, maximum VTXO amount, maximum user balance, operator fee and required confirmations are all resolved internally and never surfaced.

This blocks the enforcement recommended above. A client cannot compute the true maximum sendable without the VTXO floor, so it cannot reliably reject an impossible amount at entry. Today the options are to hardcode per-operator values, which the constraints doc warns against, or to keep discovering the limits through failed payments, which is what happened to us. Getting these onto the SDK facade is the single highest-value upstream ask.

## Instrumentation

What we learned the hard way about capturing evidence.

- the activity detail sheet now shows the full failure reason, payment hash, preimage, txid, VTXO outpoint and both timestamps. Before it existed, the real cause of a failure was only readable through the accessibility tree
- `progress.preimage` was empty on a completed Lightning send. Proof of payment is not yet demonstrated
- created against last update on an entry gives the true settle time. One send took 45 seconds
- dump the operator terms before any test run. Every threshold is operator policy, so results are only meaningful against a recorded set

## Confidence register

Audited on 24 July 2026 against the v0.1.0 source. Everything in this document falls into one of these three buckets. Do not let anything move up a bucket without a citation.

Verified in source, safe to build on:

- the expiry state machine, its four states and its dynamic thresholds (`vtxo/expiry.go`), and that `DefaultExpiryConfig()` is actually wired in (`waved/server.go:656`, `vtxo/manager.go:199`) rather than merely defined
- the refresh and critical transitions, and `FailedState` with `Recoverable: false` on expiry (`vtxo/transitions.go:176`, `:197`, `:228`)
- the balance chain end to end: `ConfirmedSat` ← `GetVtxoBalanceSat()` ← `SumSpendableBalance(ListLiveVTXOs)`
- `WalletVTXO` carrying `batchExpiry` and `relativeExpiry`, `Info` carrying `blockHeight`, and the app already reading the inventory via `list({ view: 'vtxos' })` (`src/screens/exit/ExitScreen.tsx:149`). The expiry-deadline mitigation is buildable today
- the SDK's `ServerInfo` exposing only `freeRefreshWindowBlocks`
- that no client RPC triggers a round, that `useWalletRefresh` is only a data re-fetch, and that a cooperative exit queues into the next round (`client.d.ts`, `hooks.d.ts:157`, `exit.d.ts:5`)
- the 5 minute send-intent TTL and the deliberate burn on dispatch failure

Observed once on signet, not generalisable:

- every number in the results table. One operator, one afternoon, one build
- the L2 timings. Twenty-three invoice creations against one operator on one signet afternoon, with the round not yet executed
- the boarding fee of 255 on 2,000 sats
- `progress.preimage` empty on a completed Lightning send. This may be a path-specific gap rather than a missing feature

Inference or inherited, must not be quoted as fact:

- that a closed app processes no block epochs, and therefore that an inactive wallet loses funds. Strongly implied by the daemon running in-process, never tested, and no background capability was looked for in the harness
- that the operator reclaims the on-chain backing at batch expiry. Inherited from Kesh's bark findings and general Ark semantics. The Wavelength source shows the client marking the VTXO failed, not what the operator does
- that change re-minting moves the balance. Consistent with the coin-selection model and with the failure we saw, not separately traced
- the reading that a failed send burns the payee's receive intent. The error comes from the swap server, which is not in the public repository
- that Wavelength answers Kesh's second killer. L2 has run once and the bark failure did not reproduce, but the round had not executed by the end of the window, so waiting for a round is what was tested, not running one. Do not report the maintenance lock as cleared on this evidence

Known gaps in the matrix itself: of 22 tests, six have results and one of those is partial. The other 16 have never been run, and every lifecycle test is among them.

## Before the next attempt

What would need to be true for this to carry real user money.

- an answer to L1 that does not depend on the user opening the app. Background refresh, a delegated server-side agent, or an explicit product limit on how long value may sit in Ark
- L2 clean, or receive is unreliable under load
- a spendable-amount model enforced at entry, so users never reach a confirmation screen for a payment that cannot succeed
- a balance presentation that survives fees and refreshes moving the number on its own
- LNURL confirmed as supported, since it is in the Kesh requirement and is not yet demonstrated here

The honest summary today: Wavelength is a substantially more careful implementation than bark on exactly the axis that killed the last attempt, and the phantom-balance failure looks designed out. The lease itself is unchanged, and it is the thing that decides whether a consumer wallet can hold value in Ark at all.
