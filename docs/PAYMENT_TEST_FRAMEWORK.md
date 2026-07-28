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

Once in five runs. The failure is real and severe, and nothing we have measured predicts when it happens.

Runs 1 to 3 on 24 July 2026, runs 4 and 5 on 28 July, all on signet: three idle invoices, then a VTXO queued into the next round by cooperative exit, then an invoice every ten seconds until the exit settled and for a minute after.

| | Run 1, 17:00 | Run 2, 17:32 | Run 3, 18:16 | Run 4, 14:24 | Run 5, 15:40 |
| --- | --- | --- | --- | --- | --- |
| Idle worst | 1,848 ms | 2,129 ms | 1,700 ms | 2,093 ms | 2,141 ms |
| Round settled | between +255s and +858s | +94s | +1,006s | +1,655s | +476s |
| In-round worst | 602,812 ms, failed | 1,854 ms | 2,652 ms | 3,341 ms | 3,225 ms |
| In-round calls | 28 | 14 | 97 | 172 | 54 |
| Failures | 1 | 0 | 0 | 0 | 0 |
| Verdict | blocked | clean | clean | clean | clean |

Run 3 was designed to test the explanation that run 2 suggested — that the block goes with a slow round. It does not. Run 3's round took 1,006 seconds, longer than run 1's round could possibly have been, and 97 invoices went through it without one exceeding 2.7 seconds. Round duration does not predict the block.

Run 4 puts that beyond argument. Its round took 1,655 seconds, at least twice anything run 1 could have had, and 172 invoices went through it with a worst call of 3.3 seconds. It also exited a 744 sat VTXO rather than a 1,000, so a below-floor VTXO joins a round the same way.

Run 5 came back the other way, settling in 476 seconds, so the four measured rounds now run 94, 476, 1,006 and 1,655 seconds with no pattern to them and every one of them clean.

Runs 3, 4 and 5 all carried a control, and the two wallets come out near indistinguishable each time. Run 4: median 1,661 ms in the round against 1,635 ms on the control. Run 5: 1,630 ms against 1,654 ms, with the round wallet the faster of the two. Across those two pairings that is roughly 500 calls and a difference of about 25 ms either way. Joining a round does not make receive measurably slower. The control remains what localises the fault when a block next reproduces, and on a clean run it settles nothing.

Run 1 blocked. Timeline from the moment the exit was queued:

| Window | What happened |
| --- | --- |
| +0s to +243s | 22 invoices, 1,222 to 2,421 ms. Indistinguishable from idle |
| +255s | One invoice hung for 602,812 ms — ten minutes and three seconds — then failed |
| +857s | The probe first saw the exit settled. The round had executed at some point since +255s |
| +867s to +913s | Five invoices, 1,233 to 1,722 ms. Fully recovered |

The failure, in full:

```
create receive invoice: rpc error: code = Internal desc = start receive:
rpc error: code = Internal desc = start receive swap: allocate claim
receive script: create receive script: rpc error: code = Internal desc =
unable to create OOR receive script: register receive script:
response waiter expired
```

Within run 1 the timing looked striking, and it was an artifact. The block began at +255s and cleared at about +858s, and the probe recorded the round settling at +857s — one second earlier. That reads as the block ending the moment the round did. It cannot mean that. The probe checked `pending_out_sat` only after a sample returned, and no sample returned between +255s and +858s, so the earliest it could possibly have stamped settlement was the moment the block cleared. The round settled somewhere between +255s and +858s and we do not know where.

This was found on 28 July 2026, reading the probe source rather than the data. The instrument has since been fixed: settlement now runs on its own five-second poll, independent of the samples. Nothing in runs 2 and 3 is affected, because neither had a call long enough to starve the check.

What it costs us is the only thing that tied the block to the round at all. What remains is that the block happened while a round was outstanding, which two clean runs show is not sufficient on its own. Nothing was wrong before it and nothing was wrong after it.

Two hypotheses came out of that, and run 3 killed both of the simple ones.

Rounds block receive: no. Runs 2 and 3 both executed a round end to end with receive untouched, run 3 across 97 calls.

Slow rounds block receive: no. This was the better story after run 2, since run 1's round appeared to take 857 seconds against run 2's 94, and one unresponsive operator would explain both the long round and the lost response. Two things kill it. Run 3's round took 1,006 seconds, longer than run 1's round could have been, and stayed clean throughout. And run 1's 857 seconds was never a measurement, as noted above, so the premise was weak to begin with.

So the trigger is not round execution, not round duration, and not anything else we have instrumented. What is established is narrower and still serious: a single `receive` call can block for ten minutes and then fail with `code = Internal`, it happened once in five attempts, and we cannot yet say when it will happen again.

`swaps.db` adds one fact about where it broke. Every `receive` writes a `receive_swaps` row stamped with `created_at_unix`, and run 1's rows line up with the probe exactly — 22 in-round rows from 17:01:18 to 17:05:21, then nothing until 17:15:45, which matches the probe's recovery sample to the second. The blocked call wrote no row at all, so it died before any swap state was persisted, consistent with failing where the error says it did: registering the receive script.

Note what this does to the first, 90 second run of L2. That run stopped at +90s and read as a clean pass. Runs 2 to 5 also pass cleanly, so a short window is not inherently wrong. The reason to distrust it is simpler than "it stopped too early": with a 1-in-5 failure rate, no single run of any length proves anything.

One difference from bark worth keeping straight. bark held a local lock. This error says `response waiter expired`, a wait on a response that never came, in the OOR receive-script registration the receive path needs. Whether that wait is in the client, the daemon or the swap server is not established, and the swap server is not in the public repository.

What this means for Kesh. A one-in-five chance is the wrong way to read it, because we do not know the denominator: five runs is five, and the trigger is unidentified. But the shape of the failure is already disqualifying on its own terms. A user waiting to be paid gets a screen that hangs for ten minutes and then shows an internal error, with no warning beforehand and no way to predict it. Whether that fires on 1 receive in 3 or 1 in 300, it needs a bound and a typed error before this carries user money.

The next step is not another blind run. It is to reproduce the block with an instrument that can say what was blocked. Two discriminators are now in place, and they answer different questions. Within the wallet, the probe keeps issuing invoices while one is stalled: if the overlapping calls are still served, one response was lost, and if they all stall, receive was held wallet-wide, which is the bark shape. Between wallets, the control says whether a wallet-wide stall is the wallet's own or the operator's. Run 1 could answer neither, because the serial sampler attempted nothing during the ten minutes it was stuck.

Two further notes from the earlier short run. The exit produced no activity entry at all, consistent with wavelength#875 and the note under events and polling in the constraints document: the balance moved with nothing in the history to explain it. And the codebase does bound several waits (`replayRoundRegisterTimeout`, the prepared-send TTL, poll caps), which is consistent with what was measured but was not itself the thing tested.

The probe lives under Settings, Diagnostics. Four things it settled about how L2 has to be run.

The SDK has no refresh RPC, so a round join cannot be requested. The only operation a client can start on demand that does round work is a cooperative exit, which "queues each outpoint into the next round" (`exit.d.ts:5`). That is the trigger, and it costs a VTXO per run: its value leaves Ark for the on-chain backing wallet.

That carries a caveat which must travel with any result. The probe measures whether round work blocks receive, entering the round by the cooperative-exit path. The automatic refresh at the needs_refresh threshold is a different caller into what is probably the same machinery, and cannot be triggered. A clean run is evidence that receive is not serialised behind a round. It is not proof that the refresh path behaves identically.

An earlier version of this test asked for invoices on Bob as well as Alice. Bob is a separate app container running a separate daemon with its own lock, so Bob's invoice creation cannot show anything about Alice's. It is still worth watching, but as a different question: Alice blocked means a client-side lock, the bark failure. Bob blocked at the same moment means operator-side contention, which is a separate and also serious problem.

Calls must not wait for each other. This is the correction of 28 July 2026. The probe used to await each invoice before starting the next, which is why run 1 spent ten minutes attempting nothing and why its settlement time is an upper bound rather than a measurement. It now dispatches on the clock, up to four calls outstanding, so a stall is measured while it is happening. The cap matters: at a ten-second interval an unbounded loop would leave sixty calls outstanding across a ten-minute stall, and the probe would be load-testing the daemon rather than timing it.

That change also produced a baseline worth recording. On 28 July, at a temporary one-second interval, 92 invoices ran on Alice with up to three outstanding at once: 1.26 to 2.07 seconds each, against 1.36 to 2.08 seconds for the same calls issued one at a time. Concurrent receives do not slow each other here, so if overlapping calls ever do stall together, that is a real change of behaviour and not the probe's own load.

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
| L2 | Run the lock probe on Alice (Settings, Diagnostics) in long mode. It takes 3 idle invoice timings, starts a cooperative exit to queue a VTXO into the next round, then times an invoice every 10 seconds until the exit settles and for a minute after. Long mode is not optional: the round takes about 14 minutes to execute, and a short window ends before it | Every call completes in about the idle time, including across the settlement. Any single call over 30 seconds, or any failure that did not occur idle, reproduces the bark failure |
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
| L2 | Inconclusive, 1 block in 4 runs | Run 1, 17:00: one invoice hung 602,812 ms and failed with `response waiter expired`, with a round outstanding that settled at some point between +255s and +858s. Run 2, 17:32: round +94s, clean. Run 3, 18:16: round +1,006s, 97 calls, worst 2,652 ms, clean, with a second-wallet control also clean across 99 overlapping calls. Run 4, 28 July 14:24: round +1,655s, the longest yet, 172 calls, worst 3,341 ms, clean, control clean across 183 calls at a near-identical median. No measured variable predicts the block |
| L2 (first attempt) | Void | Alice, 16:47, 90 second window. Cannot distinguish a fast round from a slow one, so it proves nothing either way |
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
- the L2 timings. Five runs, one operator, two signet afternoons. The ten-minute block happened once. Round execution and round duration have both been ruled out as the trigger, and no replacement hypothesis has been tested, so the cause is simply unknown
- that a wallet in a round performs the same as one outside it. Runs 4 and 5 measured medians about 25 ms apart, in opposite directions, across roughly 500 calls. Two pairings, one operator, one afternoon
- run 1's round duration is not one of these. It was never measured. The probe could not have stamped settlement before the block cleared, so all that is known is that the round settled between +255s and +858s
- the boarding fee of 255 on 2,000 sats
- `progress.preimage` empty on a completed Lightning send. This may be a path-specific gap rather than a missing feature

Inference or inherited, must not be quoted as fact:

- that a closed app processes no block epochs, and therefore that an inactive wallet loses funds. Strongly implied by the daemon running in-process, never tested, and no background capability was looked for in the harness
- that the operator reclaims the on-chain backing at batch expiry. Inherited from Kesh's bark findings and general Ark semantics. The Wavelength source shows the client marking the VTXO failed, not what the operator does
- that change re-minting moves the balance. Consistent with the coin-selection model and with the failure we saw, not separately traced
- the reading that a failed send burns the payee's receive intent. The error comes from the swap server, which is not in the public repository
- where the ten-minute receive block in L2 actually lives. The error is `response waiter expired` on an OOR receive-script registration, which is a wait on a response rather than the local mutex bark held. The client, the daemon and the swap server are all candidates, and the swap server is not in the public repository. What is observed is one call blocking while a round was outstanding; the mechanism is not
- that the block has anything to do with the round beyond happening during one. The apparent coincidence of the block clearing as the round settled was the serial sampler, not the system. Two of three runs executed rounds with receive untouched

Known gaps in the matrix itself: of 22 tests, six have results and one of those is partial. The other 16 have never been run, and every lifecycle test is among them.

## Before the next attempt

What would need to be true for this to carry real user money.

- an answer to L1 that does not depend on the user opening the app. Background refresh, a delegated server-side agent, or an explicit product limit on how long value may sit in Ark
- L2 resolved one way or the other. Receive blocked for ten minutes and failed on one run of two. If that recurs it is disqualifying and needs an upstream fix, because rounds are automatic and no client can work around them. If it was operator degradation, the ask is smaller but real: bound the wait and return a typed, retryable error instead of `code = Internal`
- a spendable-amount model enforced at entry, so users never reach a confirmation screen for a payment that cannot succeed
- a balance presentation that survives fees and refreshes moving the number on its own
- LNURL confirmed as supported, since it is in the Kesh requirement and is not yet demonstrated here

The honest summary today. Of the two failures that shelved Ark, Wavelength answers one and reproduces the other.

The phantom balance looks designed out. There is a real per-VTXO expiry state machine, the spendable figure is Live-only end to end, and the code is markedly more careful than bark on exactly that axis.

The maintenance block is open, and it is the most urgent thing here. On one run of three, Alice could not receive for ten minutes and the attempt failed with an internal error — the same user-visible failure that shelved Ark. The other two runs were clean, including one whose round ran longer than the blocked one. Rounds do not cause it and slow rounds do not cause it; we do not know what does.

The lease itself is unchanged, and it still decides whether a consumer wallet can hold value in Ark at all. But L2 now outranks it in sequence, not because it is settled but because it is cheap to settle and a wallet that cannot reliably receive is not shippable regardless of how the expiry question resolves.
