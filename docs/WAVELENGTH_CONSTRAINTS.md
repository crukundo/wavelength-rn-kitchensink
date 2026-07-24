# Wavelength v0.1.0 verified constraints

Constraints confirmed against the Wavelength source, and what each one means for wallet design. The goal is to stop rediscovering the same limits through failed payments.

Verified against `github.com/lightninglabs/wavelength` at tag `v0.1.0`, commit `6ff371852ff93044ffeab201fbb61a87520ef67e`. File and line references point at that tag. The repository is public and MIT licensed.

## Provenance

Every entry carries one of three levels. Do not add anything without one.

- Source — read in the v0.1.0 Go source, cited by file and line. Treat as final
- Observed — reproduced in this harness on signet, with evidence recorded
- Unverified — inferred, or produced by a service outside this repository. Treat as a hypothesis

Comments in the SDK type definitions and in this repo are not evidence. Several were accurate, but they were checked, not trusted.

## The headline finding: almost nothing is a fixed constant

Most limits come from `OperatorTerms`, negotiated from the operator at connect time (`waved/operator_negotiation.go:69`). The struct carries 13 fields; these 11 are the policy-bearing ones, alongside `PubKey` and `BoardingExitDelay`. Source, `lib/types/boarding.go:34`:

- `DustLimit` — minimum output value for boarding and funding flows
- `MinVTXOAmount` — operator-advertised minimum VTXO output
- `MinBoardingAmount` — minimum a client must contribute
- `MaxVTXOAmount` — cap per VTXO, applied to boarding, round outputs and OOR recipient outputs
- `MaxUserBalance` — cap on total balance one user may hold, enforced client-side before funds enter
- `FeeRate` — operator target package feerate in sat/vByte
- `MinOperatorFee` — minimum fee per join request
- `MinConfirmations` — minimum confirmations on boarding inputs
- `FreeRefreshWindowBlocks` — blocks before batch expiry where a refresh is free
- `MaxOORLineageVBytes` — cap on cumulative on-chain vBytes to claim an OOR VTXO
- `VTXOExitDelay` — minimum CSV delay on VTXO outputs

Design implication. Numbers observed on signet are one operator's policy, not the protocol. A wallet must read the terms and render its limits from them. Any hardcoded threshold in a client is a bug waiting for a different operator.

## Minimum change on VTXO selection

The 1,000 sats we hit is the operator's advertised minimum, not a client constant.

Source. `waved/rpc_server.go:3104` sets `MinChangeAmount: terms.MinVTXOAmountFloor()`. That floor is `max(MinVTXOAmount, DustLimit)` — the advertised VTXO minimum wins when above dust, dust is the fallback for older or misconfigured operators (`lib/types/boarding.go:95`).

Selection semantics, source `coinselect/selector.go:53`:

- zero change is always accepted, whatever `MinChange` is
- a covering selection whose non-zero change falls below `MinChange` is rejected, and selection keeps accumulating inputs
- if no covering selection clears it, `ErrChangeBelowMin`

Observed, 24 July 2026, signet. A wallet holding a single 1,745 sat VTXO failed a 1,000 sat payment with `change 745 is below minimum change amount 1000`.

Design implication. Spendable is not the same as held, and the gap depends on VTXO shape, not just balance. Compute the real maximum from the inventory and the terms, and reject at amount entry. Exact-change spends always work, so a "send max" that consumes a VTXO whole is a genuine escape hatch worth offering.

Correction. An earlier version of this doc recorded 1,000 as a fixed minimum change amount. It is operator policy and will differ per deployment.

## A separate 330 sat floor exists — do not confuse the two

`minChangeFloor = btcutil.Amount(330)` is a client constant, but it applies only to the on-chain change output produced by a clipped board when the operator advertises no dust limit. It matches the P2TR dust threshold. Source, `wallet/board_limits.go:14`.

It has nothing to do with VTXO selection change. Two different floors, two different paths.

## Boarding

Confirmations are operator policy. The round actor uses `OperatorTerms.MinConfirmations` (`round/actor.go:1343`, `round/transitions.go:2902`). The client constant `MinBoardingConfs = 1` (`wallet/wallet.go:37`) governs the on-chain wallet's `ListUnspent` and confirmation notifier minimum, not the boarding policy.

Correction. An earlier version recorded "one confirmation" as the rule. One confirmation is what this signet operator asked for, and what the client uses as its own floor. Another operator can require more.

The fee is quoted per operation, not fixed. The client calls the operator's `EstimateFee` RPC with `(amountSat, isBoarding, remainingBlocks)` and deducts the returned total from the VTXO output so the server's `validateOperatorFee` accepts the submission. Source, `waved/rpc_fees.go:49`. If the operator is unreachable the client falls back to the flat `terms.MinOperatorFee` so boarding still works in a degraded mode (`rpc_fees.go:36`). A zero schedule reduces to the pre-fee flow.

Observed: 2,000 sats in, fee 255, 1,745 credited, signet, 24 July 2026. That is one point on a server-side schedule that varies with amount and remaining blocks. Do not extrapolate from it.

Correction. An earlier version asked whether the fee was fixed or fee-rate driven. It is neither — it is an operator fee quote per operation.

A board can be clipped, and sub-dust remainders are burned to the miner fee. `clampBoardingAmount` divides the confirmed balance against the per-VTXO maximum and the balance cap. When the amount cannot be divided into whole pieces within `[floor, maxVTXO]`, the leftover becomes `DustToFee` — provably below the floor, so it could never have been spendable, but it is still value the user loses. Source, `wallet/board_limits.go:104`, specifically lines 218 to 234.

Boarding can be refused outright, with four distinct errors: `ErrBoardingCapReached`, `ErrBoardAmountBelowFloor`, `ErrTooManyBoardOutputs`, `ErrMaxVTXOBelowFloor`. Source, `wallet/board_limits.go:29`. The first is a real user state — the operator's `MaxUserBalance` leaves no headroom. The last two only trip on operator misconfiguration.

`maxBoardOutputs = 1000` caps how many VTXOs one board may split into, guarding against a pathologically small advertised per-VTXO maximum. Source, `wallet/board_limits.go:27`.

Design implication. Tell the user the fee before they send the deposit, since the client can quote it. Surface the balance cap as headroom, not as a failure at boarding time. And a deposit that will lose value to `DustToFee` should say so up front.

## Settlement rails

`SendRail` is one of `unspecified`, `offchain_unknown`, `in_ark`, `lightning`, `onchain`, `credit`, `mixed`. SDK types, `wavelength-core/dist/generated.d.ts:385`.

The destination does not determine the rail. An invoice may quote as any of them. SDK, `wavelength-core/dist/destination.d.ts:5`.

Observed: a 500 sat BOLT11 send quoted on the credit rail on a wallet holding only Ark VTXOs.

Design implication. The rail is an output of the quote. No screen before the quote may promise one.

## A client cannot ask for a round

There is no refresh RPC. The whole client surface is `ready`, `start`, `stop`, `getInfo`, `status`, `balance`, `createWallet`, `unlockWallet`, `openWalletFromPasskey`, `deposit`, `receive`, `prepareSend`, `sendPrepared`, `send`, `list`, `exit`, `exitStatus`, `exitSummary`, `getExitPlan`, `sweepWallet`, `isRunning`, `subscribe`, `startActivity`, `stopActivity`, `dispose`. Source, `wavelength-core/dist/client.d.ts`.

`useWalletRefresh` in the React package is not a VTXO refresh. It re-fetches info, balance and activity. Source, `wavelength-react/dist/hooks.d.ts:157`. Anyone testing round behaviour will reach for it first and measure nothing.

Two client-startable operations do round work:

- a cooperative exit. "A cooperative batch queues each outpoint into the next round", and again, "On the cooperative path it queues each outpoint into the next round". Source, `wavelength-core/dist/exit.d.ts:5` and `:86`. This is startable on demand, which makes it the only usable trigger for a timed test
- boarding a deposit, which is gated on the operator's required confirmations and so cannot be timed

The automatic refresh at the needs_refresh threshold fires on a block epoch near expiry and cannot be requested.

Design implication. The wallet's own refresh schedule is unobservable and untriggerable from the client. A test that needs a round in flight must use a cooperative exit and accept that it is a different caller into the round machinery. See test L2 in [PAYMENT_TEST_FRAMEWORK.md](PAYMENT_TEST_FRAMEWORK.md).

## Receive dies while a round executes

Observed, 24 July 2026, signet. With a cooperative exit queued into a round, invoice creation on the same wallet hung for 602,812 ms and then failed:

```
create receive invoice: rpc error: code = Internal desc = start receive:
rpc error: code = Internal desc = start receive swap: allocate claim
receive script: create receive script: rpc error: code = Internal desc =
unable to create OOR receive script: register receive script:
response waiter expired
```

The block ran from 255 to about 858 seconds after the exit was queued. The round settled at 857 seconds. Before and after that window, invoice creation took 1.2 to 2.4 seconds. See test L2 in [PAYMENT_TEST_FRAMEWORK.md](PAYMENT_TEST_FRAMEWORK.md) for the full timeline.

The failing step is the OOR receive-script registration that the receive path needs. `response waiter expired` is a wait on a response that never arrived, not the local mutex bark held, so the mechanism is not the same even though the symptom is. The wait expired at about ten minutes, which is a bound but not a useful one.

Unverified. Which component holds the wait. The error crosses the client, the daemon and the swap server, and the swap server is not in this repository.

Design implication. There is no client-side workaround. Rounds are automatic, driven by the wallet's own expiry schedule, and a user waiting to be paid cannot know one is running. Any product built on this needs the wait bounded and the error made recoverable upstream first.

## A cooperative exit costs more than it looks

Observed, 24 July 2026, signet. A 1,000 sat VTXO exited cooperatively arrived in the backing on-chain wallet as 743 sats. The 257 sats went to fees, a quarter of the value.

Timing, same run: queued at 16:48 and settled between 16:51 and 16:59, and on a second run 857 seconds after queueing. Call it about ten to fifteen minutes to leave Ark cooperatively.

One point on an operator fee schedule that varies with amount and remaining blocks, so do not extrapolate the rate. Note only how badly a flat-ish fee scales down: 255 on a 2,000 sat board, 257 on a 1,000 sat exit.

Design implication. Small VTXOs are close to unexitable in economic terms. A wallet holding many small VTXOs cannot leave Ark without losing a large fraction, and the user should be told the cost per VTXO before boarding into that shape.

## Credit

The credit numbers are server-quoted, not computed locally. The client copies `creditTopupSat`, `creditAppliedSat`, `creditShortfallSat` and `arkFundingSat` straight out of the swap server's `QuotePay` response, and builds the warning string from them. Source, `swapwallet/router.go:777`.

Observed: `credit shortfall requires 1000 sat top-up` on a 500 sat send.

The 1,000 sat top-up and the 1,000 sat minimum change are not the same parameter. One is the operator's `MinVTXOAmountFloor` reaching the client through `MinChangeAmount`, the other is a number the swap server returned in a quote. Two independent values that happened to match on signet.

A credit-rail quote can legitimately report a total outflow of zero. `expectedTotalOutflowSat` is set from `quote.GetAmountSat()` (`swapwallet/router.go:790`), and the server reports zero when nothing leaves the Ark balance. The top-up is a real cost that is not in that figure.

This harness ignores `creditPreview` entirely and renders only `quote.warning` (`src/screens/send/QuoteReview.tsx:191`).

Design implication. A 500 sat payment showing a total of 0 is not comprehensible. Show the four credit numbers, and define total as total cost to the user including any top-up.

## Intents are single-use, and the burn is deliberate

`sendIntentTTL = 5 * time.Minute`, a client constant. Source, `swapwallet/send_intents.go:15`. It is stamped into `ExpiresAtUnix` on the prepare response (`send_intents.go:180`), which is what the countdown renders. Observed countdown starting near 5 minutes, consistent.

The burn is intentional, and the source says so plainly. From `consume`, `send_intents.go:92`:

> Send calls this before dispatching to the backend, so any dispatch failure intentionally burns the intent and requires the caller to prepare again.

Expired intents are pruned on every put and consume.

Unverified. The payee-side failure we hit, `AlreadyExists: receive intent already used`, is not produced by this codebase — the string appears only in tests here, so it originates in the swap server, which is not in this repository. Our reading is that the payer's first failed attempt consumed the receive intent backing the payee's invoice, killing that invoice permanently. That matches the observed behaviour but cannot be confirmed from source.

Design implication. After a failed Lightning send the payer must prepare again, and on the evidence the payee must issue a new invoice too. Do not offer a retry control that reuses either. This was the most confusing failure we hit, because the second error masked the first and pointed at the wrong cause.

## Quotes

Quotes expire in 5 minutes, per the section above. Source.

`prepareSend` can be accepted and never answered, leaving the UI stuck with no error. Repo, `src/screens/send/SendScreen.tsx:33`, which bounds it at 60 seconds client-side. Not yet traced to a source-side cause.

Design implication. Bound the quote call, show the countdown, and always give the user a way back from a hung quote.

## Events and polling

The activity stream pushes swap-backed and send-side entries only. Boarding deposits and exits emit no lifecycle event. Repo, `src/lib/usePollWhileWaiting.ts:42`, tracking wavelength#875.

Observed: a confirmed boarding deposit did not appear in the receiving wallet until a manual pull-to-refresh.

The app-wide poll only activates once something is already pending (`src/WalletApp.tsx:64`), which leaves a gap before first detection. Two screen-scoped polls cover it (`HomeScreen.tsx:519`, `ReceiveScreen.tsx:153`). Poll runs are capped at 200 ticks at 3 seconds, about 10 minutes (`usePollWhileWaiting.ts:34`), and signet blocks average about 10 minutes, so a poll can expire before the confirmation it waits for.

Design implication. Screen-scoped polling is not a foundation for a real wallet. Reconcile on foreground and on a background schedule. An empty wallet waiting for its first deposit must still expose a refresh control — this harness hides it, because the refresh icon lives in the funded balance card.

## Balance semantics

Balance is the only source of truth for value. Never sum activity entries. Repo, `src/lib/balance.ts:5`.

Spendable balance is Live-VTXO only, traced end to end. `ConfirmedSat` is set from `GetVtxoBalanceSat()` (`swapwallet/service.go:595`), which is `SumSpendableBalance(ListLiveVTXOs)` (`waved/rpc_server.go:750`). The source is explicit that mapping the conflated total onto `confirmed_sat` "would tell the user they have spendable balance immediately after a faucet deposit, before any round commit". Source.

Note the evaluation point: an expired VTXO only leaves Live once the client processes a block epoch (`vtxo/actor.go:711`), so a wallet reopened after a long closure can briefly report value it no longer holds. See the confidence register in [PAYMENT_TEST_FRAMEWORK.md](PAYMENT_TEST_FRAMEWORK.md).

`confirmed_sat` rises and `pending_in_sat` clears in the same atomic read. Repo, same comment. Observed: spendable balance and spendability changed together, with no intermediate state.

`pending_in_sat` covers boarding only — confirmed, unconfirmed and adopted totals. An unpaid invoice leaves it at zero. Repo, `balance.ts:47`.

`pending_out_sat` does carry a cooperative exit, contrary to the repo comment at `balance.ts:57` which says only the pending boarding sweep reaches it. Observed, 24 July 2026: with no boarding sweep in flight, a cooperative exit of a 1,000 sat VTXO moved `confirmed_sat` from 8,738 to 7,738 and raised `pending_out_sat` to exactly 1,000, which returned to zero when the exit settled. The comment may still be right about sends, which were not tested. The lock probe relies on this behaviour to detect settlement.

The Balance snapshot excludes the backing on-chain wallet. This repo reads that figure by previewing a wallet sweep with `broadcast: false`. Repo, `src/screens/home/OnChainBalance.tsx`.

Note. The receive pre-flight and the boarding headroom check deliberately count the current balance differently — boarding excludes the confirmed balance it is converting, receive counts every bucket. Source, `wallet/board_limits.go:320`. Anything computing headroom must pick the right one.

Design implication. Pending means different things per rail and is silent on the two users ask about most. Do not label a single generic pending figure.

## Exits

`ExitInfeasibilityReason` is one of `sweep_below_dust`, `uneconomical`, `wallet_underfunded`, `wallet_too_few_inputs`. SDK, `generated.d.ts:873`. The first two are structural and can never be made exitable; the last two are funding shortfalls the wallet can cover, reflected in `fundingShortfallSat`. SDK, `generated.d.ts:849`.

Unilateral exit needs fee UTXOs in the backing wallet, at a required count and confirmation depth. SDK, `generated.d.ts:841`.

Force unroll requires the literal acknowledgement `I_KNOW_WHAT_I_AM_DOING`. SDK, `generated.d.ts:620`.

Design implication. A wallet can hold funds it cannot unilaterally exit. That is a hole in the self-custody claim, and the user needs to know at deposit time, not exit time.

## Failure classification

`EntryFailureCode` is one of `timed_out`, `expired`, `refunded`, `needs_intervention`, `failed`. SDK, `generated.d.ts:1172`. `needs_intervention` means an anomalous state requiring manual recovery (`generated.d.ts:1189`).

Design implication. Switch on the code, never on error strings. `needs_intervention` is the one code meaning the wallet cannot fix itself, and it needs a real recovery path.

## Runtime lifecycle

Create exactly one `WalletEngine` at module scope. A Metro reload can outlive the native daemon and produce `wavelength mobile already started`; force-quit and relaunch. Repo, README.

## Still open

- why an on-chain send sat at `request created` from 12:26 on 24 July 2026 without broadcasting, while a second send from the same wallet reached `settling`
- whether the payee's receive intent is always burned by a failed payer attempt, or only once vHTLC funding has started. Needs the swap server source or a controlled regtest repro
- what this signet operator actually advertises. Every number we observed is one operator's policy. Note the SDK does not expose them: `ServerInfo` on the wallet facade carries only `freeRefreshWindowBlocks` (`generated.d.ts:273`), so the dust limit, VTXO floor, balance cap, operator fee and required confirmations cannot be read by a client. They would have to be recovered from the daemon directly or asked for upstream. See [PAYMENT_TEST_FRAMEWORK.md](PAYMENT_TEST_FRAMEWORK.md)
- whether `prepareSend` hanging past 60 seconds has a source-side cause

## Keeping this current

Re-verify against the tag when the pinned Wavelength version changes. The three corrections in this document all came from treating an observed number as a constant. Prefer reading the operator terms at runtime over recording any threshold here.
