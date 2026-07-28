# Session handoff — 28 July 2026

Where the Wavelength evaluation stands, and what to pick up next. Written to be read cold. Supersedes the 24 July handoff.

## Why this work exists

Kesh removed its Bitcoin integration on 20 July 2026 (`/Users/rukundo/Desktop/kesh/docs/bitcoin-shelved.md`). Ark via the bark SDK was judged too early for two specific reasons:

- VTXO expiry silently swept funds from an inactive wallet, and bark still reported the swept VTXOs as spendable — 41,989 sats displayed that the user no longer had
- `wallet.maintenance()` waited on server rounds with no timeout, holding the wallet lock and blocking invoice creation, so users could not receive

This repo is the harness for deciding whether Lightning Labs' Wavelength answers those two failures well enough to carry Kesh user money. The two failures are tests L1 and L2 in the framework below.

## Headline: where the two questions stand

- L1, the phantom balance, is answered by design while the wallet runs. A per-VTXO expiry state machine, spendable traced as Live-only. Not yet tested through a real closure. See the confidence register.
- L2, the maintenance block, is the live thread and is not settled. On one run of three, receive blocked for ten minutes and failed with an internal error — the same user-visible failure that shelved Ark. The other two runs were clean. We have ruled out two candidate causes and do not yet know the trigger.

If you read nothing else, read the L2 section of [PAYMENT_TEST_FRAMEWORK.md](PAYMENT_TEST_FRAMEWORK.md) and the "next step" at the end of this handoff.

## Read these first

- [PAYMENT_TEST_FRAMEWORK.md](PAYMENT_TEST_FRAMEWORK.md) — the two decisive questions, the balance model, the 22-test matrix, and all three L2 runs
- [WAVELENGTH_CONSTRAINTS.md](WAVELENGTH_CONSTRAINTS.md) — every limit verified against source, with provenance markers
- [UPSTREAM_RECEIVE_BLOCKED.md](UPSTREAM_RECEIVE_BLOCKED.md) — the draft GitHub issue for the L2 block, ready to file

Do not trust any constraint not marked Source. The confidence register in the test framework is the authoritative list of what is verified, seen once, or inferred. Read it before quoting any finding.

## The L2 lock probe

Built this session. It lives in the app at Settings, Diagnostics, Lock probe (`src/screens/diagnostics/LockProbeScreen.tsx`).

Why it exists: the SDK has no refresh RPC, so a round cannot be requested. The only round work a client can start on demand is a cooperative exit, which "queues each outpoint into the next round" (`wavelength-core exit.d.ts:5`). The probe uses that as its trigger.

What it does: takes 3 idle invoice timings, starts the exit without awaiting it, then dispatches an invoice on a fixed interval and watches `pending_out_sat` on a separate 5-second poll to detect when the round settles.

Calls are dispatched on the clock and not awaited, up to 4 outstanding at once. That is the discrimination the probe exists for. If a call stalls and the calls started during it are still served, one response was lost. If they all stall, receive was held wallet-wide, which is the bark failure. The serial version could say neither, which is why run 1 proves less than it appears to.

That change landed on 28 July 2026 and is verified on both wallets, without spending anything. Two control runs at the 3-second interval ran 33 calls each with no failures and exactly 3.0s spacing. A forced-overlap run at a temporary 1-second interval ran 92 calls on Alice with up to 3 in flight, no failures, 1.26 to 2.07 seconds each against 1.36 to 2.08 seconds for the same calls one at a time. Concurrent receives do not slow each other on a healthy wallet, which is what makes a joint stall meaningful.

Three modes:

- Fast: 3s interval, 90s window. Do not trust it alone — with a 1-in-3 failure rate no single short run proves anything.
- Long: 10s interval, runs until the exit settles plus a minute. This is the real test. A round takes 2 to 17 minutes to execute, so budget 15 to 20 minutes per run.
- Control: joins no round, spends no VTXO. Run it on the second wallet at the same time as a real run on the first. Both hit the same operator, but each has its own daemon and lock. If only the round wallet blocks, the wait is inside that wallet. If both block together, it is the operator.

Each exit costs one whole VTXO, which leaves Ark for the on-chain backing wallet. The unpaid probe invoices cost nothing and expire on their own.

### Reading a run out cleanly

A 15-minute run produces far more data than is readable by scrolling the phone. The probe publishes the whole run on `globalThis.__l2probe`, so pull it over the Metro debugger instead of transcribing screenshots.

```
debugger-connect  (see logicalDeviceIds below)
debugger-evaluate: globalThis.__l2probe
```

The object carries `mode`, `control`, `phase`, `joinAt`, `settledAt`, `joinNote`, `samples`, the schedule it ran (`intervalMs`, `maxInFlight`, `settlePollMs`), what it actually did (`maxInFlightSeen`, `skipped`), and captured SDK `logs`. Stamp offsets as `(sample.t - joinAt)/1000`.

Each sample is `{id, t, ms, ok, detail, overlap}`. `t` is when the call started, `overlap` is how many calls were already outstanding when it started, and `ms` and `ok` are `null` while a call is still in flight — so a stall is readable while it is happening, not only after it ends. `skipped` counts slots dropped at the concurrency cap; a run that reports any is one where the wallet was already saturated.

## The three L2 runs

All 24 July 2026, signet, one operator. 1,000 sat VTXO exited each time.

| | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Round settled | between +255s and +858s | +94s | +1,006s |
| In-round calls | 28 | 14 | 97 |
| Worst call | 602,812 ms, failed | 1,854 ms | 2,652 ms |
| Verdict | blocked | clean | clean |

Run 1's round was never measured. The old serial sampler only checked settlement after a call returned, and nothing returned for ten minutes, so its recorded +857s is an upper bound stamped when the block cleared. Read the L2 section of the test framework before quoting it: the apparent coincidence between the block clearing and the round settling was the instrument.

Ruled out as the trigger:

- round execution — runs 2 and 3 both executed rounds with receive untouched
- round duration — run 3's round was longer than run 1's could have been, and stayed clean

Run 3 carried a control (Bob): 99 overlapping calls, worst 1,803 ms, no failures. Because run 3 did not block, the control localised nothing this time. It stays in place for the next run.

The failure, when it happened:

```
create receive invoice: ... unable to create OOR receive script:
register receive script: response waiter expired
```

## Instrumentation facts, learned the hard way

- Daemon logs are unreachable from this harness. `useWalletLogs` carries only SDK-level diagnostics, not daemon output. The Go daemon logs to neither that buffer, nor os_log, nor any file in its data directory. Do not spend time re-checking this.
- `swaps.db` is the evidence source. Every `receive` writes a `receive_swaps` row stamped `created_at_unix`. In run 1 the rows matched the probe to the second, and the blocked call wrote no row at all — it died before any swap state was persisted. Path: `<app container>/Library/Application Support/wavelength/data/signet/swaps.db`.
- VTXO inventory and states are in `waved.db`, table `vtxos`, column `amount`, `status` 0 = Live, `spent` flag. Handy for reading balance composition without the UI.
- `pending_out_sat` does carry a cooperative exit, contrary to the code comment at `balance.ts:57`. The probe relies on this to detect settlement.
- Raising `debugLevel` to `trace` needs a runtime restart, which lands on the unlock screen. The wallets are password-protected; the password is held by the user, not recorded here. Ask before any restart, or you risk locking a funded wallet.

## Environment

Two iOS simulators, both renamed, both running the same dev build against one Metro on port 8081.

| Name | Device | UDID | Metro logicalDeviceId | Theme |
| --- | --- | --- | --- | --- |
| Alice | iPhone 11, iOS 18.6 | `29C47385-6C57-4ADC-B257-4D46F3029302` | `f122f9f24b2934a972fb8f0556c824d9dc974dc4` | light |
| Bob | iPhone 16 Pro, iOS 18.6 | `E1A6CCCF-3B55-4A2A-B509-1B41ED3F2E42` | `486eac1574ec81c4b3616f7e13083c03d686eb9b` | dark |

The Metro logicalDeviceId is what `debugger-connect` needs — the UDID is rejected when two devices share one Metro.

Balances at 13:27 on 28 July 2026, signet. They move on their own from refresh fees, so read them from the app, do not trust these:

- Alice: 4,482 spendable across 3 live VTXOs (2,238, 1,500, 744), 500 credit, 2,972 on-chain backing. The 744 is below the 1,000 operator floor, so it can only leave by an exact-value exit. That gives about two more probe runs before Alice needs reboarding.
- Bob: 26,990 spendable, 500 credit. Untouched since it was the control.

Both wallets are password wallets. Separate simulators give separate app containers, so each wallet has its own dataDir, seed and node identity.

To add another wallet, install the existing build rather than rebuilding:

```sh
xcrun simctl install <udid> \
  ~/Library/Developer/Xcode/DerivedData/WavelengthKitchenSink-*/Build/Products/Debug-iphonesimulator/WavelengthKitchenSink.app
```

Then launch it and pick `http://localhost:8081` in the dev launcher.

## Git state

Everything is committed. Branch `main`, nothing pushed. Remote is `crukundo/wavelength-rn-kitchensink`; pushing is the user's call.

Commits this session, newest first:

```
36b52ba Probe through a stall instead of stopping at it
6b836f1 Update session handoff for the L2 investigation
9cdcff6 Run 3 rules out slow rounds; trigger unknown
15f0a9b Add control mode so a second wallet can discriminate the cause
9cc1c41 Capture SDK logs, and record that daemon logs are unreachable
6e36f49 L2 did not reproduce on the second run
d9124a4 L2 fails: receive dies for ten minutes while a round executes
cdc2fa2 Record the first L2 run
f2236e8 Add the L2 lock probe
7ea1307 Record the Wavelength v0.1.0 evaluation
70ff8a1 Add activity detail sheet
```

`fed4910` is the original build. `bun run check` passes: typecheck, architecture lock, all 17 expo-doctor checks.

## The source clone is gone

Most findings came from reading the Wavelength Go source. It was cloned to a scratchpad that does not persist. Re-clone it:

```sh
git clone --depth 1 --branch v0.1.0 https://github.com/lightninglabs/wavelength.git
```

Tag `v0.1.0` is commit `6ff371852ff93044ffeab201fbb61a87520ef67e`. Every file and line reference in the docs points at that commit.

## The next step

Run the long probe on Alice with the control running on Bob, repeatedly, until the block reproduces. Then read both `__l2probe` objects immediately.

Two questions get answered, in this order. First, from Alice alone: did the calls that started during the stall still get served? If they did, one response was lost. If they all stalled, receive was held wallet-wide, which is the bark failure. Second, from Bob: if Alice stalled wallet-wide, did Bob stall at the same moment? Alice alone means the wait is inside that wallet — Lightning Labs' bug. Both together means it is the operator — a different report to a different place.

The first question is new, and it is the one run 1 could not answer. The probe now reports its own answer on screen, so a reproduction is readable without exporting anything.

Practical notes for the run:

- Alice has about two runs of VTXO left. When she runs dry, reboard from her 2,972 on-chain backing, or swap roles and probe from Bob.
- The `trace` debugLevel route is the fallback if the control stays ambiguous. It needs a runtime restart and the wallet password. Ask the user first.

## Also open, lower priority

- L1, the phantom balance through a real closure. Read a VTXO's `batchExpiry` minus `Info.blockHeight` first to size the window.
- LNURL. The SDK's `classifyDestination` returns only `empty`, `invoice`, `address` — no LNURL awareness. An LNURL string falls through as `address` to the daemon. S5 is one send attempt to see if the daemon accepts it.
- The operator-terms upstream ask. `ServerInfo` exposes 1 of 11 operator policy values, so a client cannot compute the true maximum sendable. Folded into the upstream draft as a secondary item.
- `progress.preimage` was empty on a completed Lightning send, so proof of payment is not yet demonstrated.

## Loose ends

- An on-chain send sat at `request created` from 12:26 on 24 July without broadcasting, while a second send from the same wallet reached `settling`. Never diagnosed.
- `AlreadyExists: receive intent already used` originates in the swap server, not in the public repo. Our reading of the invoice burn matches observed behaviour but is unverified.
- The Argent update to 0.17.0 was applied on 24 July. No update is pending.
