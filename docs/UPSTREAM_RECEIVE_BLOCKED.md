# Upstream issue draft: receive blocked for ten minutes

Reproduced once in four runs. The two candidate causes we could name have both been ruled out, so this now reports a symptom without a theory — which is fine to file, as long as it does not claim one. Read [PAYMENT_TEST_FRAMEWORK.md](PAYMENT_TEST_FRAMEWORK.md) before posting. Everything below the line is the issue text.

---

## Title

`receive` can block for ~10 minutes and then fail with `response waiter expired`

## Summary

We saw one `receive` call block for 602,812 ms — ten minutes — and then fail with `code = Internal`. It reproduced once in four runs of the same procedure on the same wallet against the same operator.

We are not claiming a cause, and we are not claiming the round caused it. The block happened while a cooperative exit was outstanding, which is how we came to be watching, but three runs of the same procedure executed rounds with receive untouched.

We tried two explanations and ruled both out:

- **not round execution.** The block happened with a cooperative exit outstanding, but the three clean runs also executed rounds end to end, one of them across 172 invoices
- **not a slow or degraded operator.** The third and fourth runs took 1,006 and 1,655 seconds, both longer than the blocked run's round could have been, and no call exceeded 3,341 ms

So this is a symptom report. A `receive` can hang for ten minutes and return an untyped internal error, and we cannot predict when.

We are reporting it because that shape is unusable from a client regardless of cause, and because the failing step is deep enough in the stack that we cannot diagnose it from the public source.

## Environment

- `wavelength` v0.1.0, tag commit `6ff371852ff93044ffeab201fbb61a87520ef67e`
- `@lightninglabs/wavelength-react` 0.1.0, `@lightninglabs/wavelength-react-native` 0.1.0
- React Native 0.81.5, React 19.1.0, Expo 54.0.25, New Architecture
- iOS 18.6 simulator (iPhone 11), macOS 26.5.2
- signet, one operator
- Wallet held 7,738 sats across 6 VTXOs at the start of the run

## What happens

1. Create three Lightning invoices with nothing else in flight, to establish a baseline. Each takes 1.4 to 1.8 seconds.
2. Start a cooperative exit of one 1,000 sat VTXO — `exitBatch({ mode: 'cooperative', outpoints: [outpoint] })`. It returns in under 0.1 seconds, having queued the outpoint into the next round.
3. Keep creating a Lightning invoice every ten seconds, timing each one.

Run 1, timeline measured from the moment the exit was queued. Idle baseline 1,417 to 1,848 ms.

| Offset | Result |
| --- | --- |
| +0s to +243s | 22 invoices, 1,222 to 2,421 ms. Indistinguishable from the baseline |
| +255s | One invoice blocks for **602,812 ms** — ten minutes three seconds — then fails |
| +857s | `pending_out_sat` is first seen back at zero: the exit had settled, so the round executed at some point after +255s |
| +867s to +913s | 5 invoices, 1,233 to 1,722 ms. Fully recovered |

One caveat on that third row, since it would otherwise read as the block ending exactly when the round did. Our probe checked the balance only after an invoice call returned, and no call returned between +255s and +858s, so it could not have observed settlement any earlier than it did. The round settled somewhere in that window. We are not claiming the two events coincided.

Runs 2 to 4, same procedure, same wallet. Runs 2 and 3 followed later the same afternoon; run 4 was four days later.

| | Run 2 | Run 3 | Run 4 |
| --- | --- | --- | --- |
| Round settled | +94s | +1,006s | +1,655s |
| In-round calls | 14 | 97 | 172 |
| Worst call | 1,854 ms | 2,652 ms | 3,341 ms |
| Failures | 0 | 0 | 0 |

Runs 3 and 4 also ran a control on a second wallet — separate app container, separate daemon, same operator — probing continuously with no round of its own. Run 4's pairing is the tightest data we have: 172 calls on the wallet in the round at a median of 1,661 ms, against 183 calls on the control at 1,635 ms. Being in a round does not measurably slow `receive`. Since neither run blocked, the control does not localise anything yet; we mention it so you know the comparison is available on the next reproduction.

One incidental detail that may help you locate the failure. Every successful `receive` writes a `receive_swaps` row in `swaps.db` stamped with `created_at_unix`, and run 1's rows line up with our timings exactly. The blocked call wrote no row at all, so it failed before any swap state was persisted.

## The error

```
create receive invoice: rpc error: code = Internal desc = start receive:
rpc error: code = Internal desc = start receive swap: allocate claim
receive script: create receive script: rpc error: code = Internal desc =
unable to create OOR receive script: register receive script:
response waiter expired
```

The failing step is the OOR receive-script registration. `response waiter expired` suggests a wait on a response that never arrived rather than a local mutex, and the ~600 second duration suggests the wait is bounded but very loosely.

## What we expected

Whatever the cause, a ten-minute block ending in `code = Internal` is not something a client can present to a user. We would expect either the call to keep working, or to fail fast with a typed, retryable error naming the reason.

## Questions

1. Is a ten-minute `response waiter` expiry intended for the OOR receive-script registration? Is it configurable?
2. Which component holds that wait — the client, `waved`, or the swap server? We could not tell from the public source, and the swap server is not in this repository.
3. What else can make `register receive script` wait? We have ruled out the two conditions we could control for, so we are asking what a client could be doing — or what operator state could exist — that leaves that registration unanswered.
4. Is there a way to distinguish an unresponsive operator from a busy one at the client? Right now both surface as an untyped `code = Internal` after ten minutes.
5. Does the automatic VTXO refresh path share this code path? We could not trigger a refresh on demand to test it, which is the first item below.

## Related, smaller

Two things made this harder to investigate than it needed to be. Happy to file either separately if you would prefer.

**No way to trigger or observe a round from a client.** The client surface has no refresh RPC, so the only round work we could start on demand was a cooperative exit, which costs a VTXO each time. The automatic refresh at the needs_refresh threshold cannot be triggered at all, so we cannot confirm whether it hits the same block. Some way to observe round state would make this class of problem far easier to report accurately.

**`ServerInfo` exposes one of eleven operator policy values.** `OperatorTerms` carries `DustLimit`, `MinVTXOAmount`, `MinBoardingAmount`, `MaxVTXOAmount`, `MaxUserBalance`, `FeeRate`, `MinOperatorFee`, `MinConfirmations`, `FreeRefreshWindowBlocks`, `MaxOORLineageVBytes` and `VTXOExitDelay`, but the SDK's `ServerInfo` surfaces only `freeRefreshWindowBlocks` (`generated.d.ts:273`). Without the VTXO floor a client cannot compute the true maximum sendable, so it cannot reject an impossible amount before the confirmation screen. Today we either hardcode per-operator values or discover the limits through failed payments.

## Reproduction harness

We built a small probe for this and can share it if useful: it takes baseline timings, starts the cooperative exit without awaiting it, then dispatches an invoice every ten seconds — on the clock, without waiting for the previous one — until `pending_out_sat` returns to its pre-exit level, plus a minute after. One run in four has shown the block, so expect to run it several times.

Dispatching without waiting is deliberate, and we would suggest it to anyone trying to reproduce this. Our first version awaited each call, so the ten-minute block was ten minutes in which nothing else was attempted, and the run cannot distinguish one call losing its response from every receive being blocked. The current version keeps issuing calls during a stall, capped at four outstanding. For reference, on a healthy wallet we measured 92 invoices with up to three in flight at 1.26 to 2.07 seconds each, against 1.36 to 2.08 seconds issued one at a time — concurrency alone does not slow this path.
