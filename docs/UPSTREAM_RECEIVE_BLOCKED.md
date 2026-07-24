# Upstream issue draft: receive blocked for ten minutes

Not ready to file. It reproduced once in two runs, and the second run points at a different cause. Read [PAYMENT_TEST_FRAMEWORK.md](PAYMENT_TEST_FRAMEWORK.md) before posting this, and get a third run first. Everything below the line is the issue text as it currently stands.

---

## Title

`receive` can block for ~10 minutes and then fail with `response waiter expired`

## Summary

We saw one `receive` call block for 602,812 ms and then fail with `code = Internal`. It happened while a cooperative exit was outstanding, on a run where the round took 857 seconds to settle. A second run half an hour later, where the round settled in 94 seconds, showed nothing at all: fourteen invoices during the round, all between 1,220 and 1,854 ms.

So we cannot tell you this is caused by round execution, and we are not claiming it is. The honest summary is that a single `receive` can hang for ten minutes and then return an internal error, and that on the run where it happened the operator also appeared slow — the round took nine times longer than on the clean run. Operator degradation would explain both symptoms with one cause.

We are reporting it because a ten-minute `receive` ending in `code = Internal` looks wrong regardless of which of those it is, and because the failing step is deep enough in the stack that we cannot diagnose it from the public source.

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
| +857s | `pending_out_sat` returns to zero: the exit has settled, so the round executed |
| +867s to +913s | 5 invoices, 1,233 to 1,722 ms. Fully recovered |

Run 2, same procedure, 32 minutes later. Idle baseline 1,372 to 2,129 ms.

| Offset | Result |
| --- | --- |
| +0s to +93s | 9 invoices, 1,232 to 1,854 ms |
| +94s | The exit settled: the round executed |
| +104s to +149s | 5 invoices, 1,220 to 1,821 ms |

Nothing anomalous in run 2. Its worst in-round call was faster than its worst idle call.

The difference we can see between the runs is round duration: 857 seconds against 94.

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
3. Is `receive` expected to contend with round execution at all, or does an outstanding round have no bearing on it? If it has none, the slow round on our failing run is a coincidence and we should be looking at operator health instead.
4. Is there a way to distinguish an unresponsive operator from a busy one at the client? Right now both surface as an untyped `code = Internal` after ten minutes.
5. Does the automatic VTXO refresh path share this code path? We could not trigger a refresh on demand to test it, which is the first item below.

## Related, smaller

Two things made this harder to investigate than it needed to be. Happy to file either separately if you would prefer.

**No way to trigger or observe a round from a client.** The client surface has no refresh RPC, so the only round work we could start on demand was a cooperative exit, which costs a VTXO each time. The automatic refresh at the needs_refresh threshold cannot be triggered at all, so we cannot confirm whether it hits the same block. Some way to observe round state would make this class of problem far easier to report accurately.

**`ServerInfo` exposes one of eleven operator policy values.** `OperatorTerms` carries `DustLimit`, `MinVTXOAmount`, `MinBoardingAmount`, `MaxVTXOAmount`, `MaxUserBalance`, `FeeRate`, `MinOperatorFee`, `MinConfirmations`, `FreeRefreshWindowBlocks`, `MaxOORLineageVBytes` and `VTXOExitDelay`, but the SDK's `ServerInfo` surfaces only `freeRefreshWindowBlocks` (`generated.d.ts:273`). Without the VTXO floor a client cannot compute the true maximum sendable, so it cannot reject an impossible amount before the confirmation screen. Today we either hardcode per-operator values or discover the limits through failed payments.

## Reproduction harness

We built a small probe for this and can share it if useful: it takes baseline timings, starts the cooperative exit without awaiting it, then times an invoice every ten seconds until `pending_out_sat` returns to its pre-exit level, plus a minute after. One in two runs so far has shown the block, so expect to run it several times.
