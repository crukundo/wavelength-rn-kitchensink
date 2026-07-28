# Session handoff — 28 July 2026

Where the Wavelength evaluation stands, and what to pick up next. Written to be read cold. Supersedes the 24 July handoff.

## Why this work exists

Kesh removed its Bitcoin integration on 20 July 2026 (`/Users/rukundo/Desktop/kesh/docs/bitcoin-shelved.md`). Ark via the bark SDK was judged too early for two specific reasons:

- VTXO expiry silently swept funds from an inactive wallet, and bark still reported the swept VTXOs as spendable — 41,989 sats displayed that the user no longer had
- `wallet.maintenance()` waited on server rounds with no timeout, holding the wallet lock and blocking invoice creation, so users could not receive

This repo is the harness for deciding whether Lightning Labs' Wavelength answers those two failures well enough to carry Kesh user money. The two failures are tests L1 and L2 in the framework below.

## Headline: where the two questions stand

- L1, the phantom balance, is answered by design while the wallet runs. A per-VTXO expiry state machine, spendable traced as Live-only. Not yet tested through a real closure. See the confidence register.
- L2, the maintenance block, has a root cause as of 28 July 2026. The ten-minute block is `DefaultResponseWaiterTTL`, a constant in waved's mailbox response registry. The wait happens on the phone, in our own daemon, on a response from the operator that never arrived. Lightning Labs diagnosed the same root cause on a different RPC in wavelength#1041 and fixed it in PR 1044 — which is not in v0.1.0, the build we run.

If you read nothing else, read [RECEIVE_BLOCK_ROOT_CAUSE.md](RECEIVE_BLOCK_ROOT_CAUSE.md) and the "next step" at the end of this handoff.

## Read these first

- [RECEIVE_BLOCK_ROOT_CAUSE.md](RECEIVE_BLOCK_ROOT_CAUSE.md) — where the L2 block waits, why it lasts ten minutes, the upstream issue and fix, and how to reproduce it on demand
- [PAYMENT_TEST_FRAMEWORK.md](PAYMENT_TEST_FRAMEWORK.md) — the two decisive questions, the balance model, the 22-test matrix, and all five L2 runs
- [WAVELENGTH_CONSTRAINTS.md](WAVELENGTH_CONSTRAINTS.md) — every limit verified against source, with provenance markers
- [UPSTREAM_RECEIVE_BLOCKED.md](UPSTREAM_RECEIVE_BLOCKED.md) — the upstream report, rewritten on 28 July as a comment on wavelength#1041. Shelved, not filed. Do not post it; the user decides when and files it

Do not trust any constraint not marked Source. The confidence register in the test framework is the authoritative list of what is verified, seen once, or inferred. Read it before quoting any finding.

## The L2 lock probe

Built on 24 July 2026 and rebuilt on 28 July around concurrent sampling. It lives in the app at Settings, Diagnostics, Lock probe (`src/screens/diagnostics/LockProbeScreen.tsx`).

Why it exists: the SDK has no refresh RPC, so a round cannot be requested. The only round work a client can start on demand is a cooperative exit, which "queues each outpoint into the next round" (`wavelength-core exit.d.ts:5`). The probe uses that as its trigger.

What it does: takes 3 idle invoice timings, starts the exit without awaiting it, then dispatches an invoice on a fixed interval and watches `pending_out_sat` on a separate 5-second poll to detect when the round settles.

Calls are dispatched on the clock and not awaited, up to 4 outstanding at once. That is the discrimination the probe exists for. If a call stalls and the calls started during it are still served, one response was lost. If they all stall, receive was held wallet-wide, which is the bark failure. The serial version could say neither, which is why run 1 proves less than it appears to.

That change landed on 28 July 2026 and is verified on both wallets, without spending anything. Two control runs at the 3-second interval ran 33 calls each with no failures and exactly 3.0s spacing. A forced-overlap run at a temporary 1-second interval ran 92 calls on Alice with up to 3 in flight, no failures, 1.26 to 2.07 seconds each against 1.36 to 2.08 seconds for the same calls one at a time. Concurrent receives do not slow each other on a healthy wallet, which is what makes a joint stall meaningful.

Three modes:

- Fast: 3s interval, 90s window. Do not trust it alone — at one block in five runs, no single short run proves anything.
- Long: 10s interval, runs until the exit settles plus a minute, giving up at 45. This is the real test. Measured rounds have taken 1.6, 7.9, 16.8 and 27.6 minutes, so budget half an hour and do not be surprised by either end.
- Control: joins no round, spends no VTXO. Run it on the second wallet at the same time as a real run on the first. Both hit the same operator, but each has its own daemon and lock. If only the round wallet blocks, the wait is inside that wallet. If both block together, it is the operator.

Each exit costs one whole VTXO, which leaves Ark for the on-chain backing wallet. The unpaid probe invoices cost nothing and expire on their own.

### Reading a run out cleanly

A long run produces far more data than is readable by scrolling the phone. The probe publishes the whole run on `globalThis.__l2probe`, so pull it over the Metro debugger instead of transcribing screenshots.

```
debugger-connect  (see logicalDeviceIds below)
debugger-evaluate: globalThis.__l2probe
```

The object carries `mode`, `control`, `phase`, `joinAt`, `settledAt`, `joinNote`, `samples`, the schedule it ran (`intervalMs`, `maxInFlight`, `settlePollMs`), what it actually did (`maxInFlightSeen`, `skipped`), and captured SDK `logs`. Stamp offsets as `(sample.t - joinAt)/1000`.

Each sample is `{id, t, ms, ok, detail, overlap}`. `t` is when the call started, `overlap` is how many calls were already outstanding when it started, and `ms` and `ok` are `null` while a call is still in flight — so a stall is readable while it is happening, not only after it ends. `skipped` counts slots dropped at the concurrency cap; a run that reports any is one where the wallet was already saturated.

## The five L2 runs

Runs 1 to 3 on 24 July 2026, runs 4 and 5 on 28 July. Signet, one operator. A 1,000 sat VTXO exited each time except run 4, which used the 744, and run 5, which used the 1,500.

| | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
| --- | --- | --- | --- | --- | --- |
| Round settled | between +255s and +858s | +94s | +1,006s | +1,655s | +476s |
| In-round calls | 28 | 14 | 97 | 172 | 54 |
| Worst call | 602,812 ms, failed | 1,854 ms | 2,652 ms | 3,341 ms | 3,225 ms |
| Verdict | blocked | clean | clean | clean | clean |

Run 1's round was never measured. The old serial sampler only checked settlement after a call returned, and nothing returned for ten minutes, so its recorded +857s is an upper bound stamped when the block cleared. Read the L2 section of the test framework before quoting it: the apparent coincidence between the block clearing and the round settling was the instrument.

Ruled out as the trigger:

- round execution — runs 2 to 5 all executed rounds with receive untouched
- round duration — runs 3 and 4 both ran longer rounds than run 1 could have had, and both stayed clean. Run 4's was 1,655 seconds. Measured rounds now span 94 to 1,655 seconds with no pattern

The source reading of 28 July supersedes the search for a trigger among round properties. The round now looks like a coincidence: what the failure needs is a request that reaches the operator and a response that cannot get back. See [RECEIVE_BLOCK_ROOT_CAUSE.md](RECEIVE_BLOCK_ROOT_CAUSE.md).

Runs 3, 4 and 5 carried a control on Bob. Run 3: 99 overlapping calls, worst 1,803 ms. Run 4: 180 in-round calls, median 1,635 ms against Alice's 1,661 ms. Run 5: 79 in-round calls, median 1,654 ms against Alice's 1,630 ms. None localised anything, because none of those runs blocked. The control stays in place.

Runs 4 and 5 are the first of the concurrent sampler, and nothing stalled in either, so the overlap discrimination has still never fired. Peak in flight was 1 on both wallets, since calls take about 1.6 seconds against a 10-second interval. The instrument works; it has yet to meet a block.

The failure, when it happened:

```
create receive invoice: ... unable to create OOR receive script:
register receive script: response waiter expired
```

## Instrumentation facts, learned the hard way

- Daemon logs are unreachable from this harness. `useWalletLogs` carries only SDK-level diagnostics, not daemon output. The Go daemon logs to neither that buffer, nor os_log, nor any file in its data directory. Do not spend time re-checking this.
- `swaps.db` is the evidence source. Every `receive` writes a `receive_swaps` row stamped `created_at_unix`. In run 1 the rows matched the probe to the second, and the blocked call wrote no row at all — it died before any swap state was persisted. Path: `<app container>/Library/Application Support/wavelength/data/signet/swaps.db`.
- VTXO inventory and states are in `waved.db`, table `vtxos`, columns `amount`, `status` and `spent`. Handy for reading balance composition without the UI, and safe to read mid-run: copy the file and its `-wal` to the scratchpad and query the copy. Status 0 is Live. Watching the run 4 exit move showed 0 to 2 while the round executed, then 3 once it settled, with `spent` still 0. Rows spent in ordinary sends sit at status 4 with `spent` = 1, so status 3 means exited from Ark rather than spent.
- Do not navigate away from the probe screen during a run. The screen owns the run state, so leaving it remounts the component and the mount effect republishes an empty `__l2probe`, losing the data.
- `pending_out_sat` does carry a cooperative exit, contrary to the code comment at `balance.ts:57`. The probe relies on this to detect settlement.
- Raising `debugLevel` to `trace` needs a runtime restart, which lands on the unlock screen. The wallets are password-protected; the password is held by the user, not recorded here. Ask before any restart, or you risk locking a funded wallet.

## Environment

Two iOS simulators, both renamed, both running the same dev build against one Metro on port 8081.

| Name | Device | UDID | Metro logicalDeviceId | Theme |
| --- | --- | --- | --- | --- |
| Alice | iPhone 11, iOS 18.6 | `29C47385-6C57-4ADC-B257-4D46F3029302` | `f122f9f24b2934a972fb8f0556c824d9dc974dc4` | light |
| Bob | iPhone 16 Pro, iOS 18.6 | `E1A6CCCF-3B55-4A2A-B509-1B41ED3F2E42` | `486eac1574ec81c4b3616f7e13083c03d686eb9b` | dark |

The Metro logicalDeviceId is what `debugger-connect` needs — the UDID is rejected when two devices share one Metro.

Balances after run 5 on 28 July 2026, signet. They move on their own from refresh fees, so read them from the app, do not trust these:

- Alice: 2,238 spendable in a single live VTXO, 500 credit. On 28 July the user sent her 30,000 on-chain; it confirmed, the boarding intent reached `adopted`, and it was still in the round 28 minutes later — longer than any round we have measured. Check whether it landed before planning a run.
- Bob: 26,990 spendable, 500 credit. Unspent — he has only ever run controls.

Boarding takes the operator's required confirmations plus one full round. Detection is not the wait: the wallet checks the tip every second (`wallet/wallet.go:54`) and `eagerRoundJoin` makes a confirmed deposit join the next round with no user action. The round is the wait, and rounds run 94 to 1,655 seconds. `MinConfirmations` is not exposed by the SDK, so the app cannot show how many confirmations remain.

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
97d5de1 Audit every citation against a fresh clone; fix four
685b572 Run 5 is clean; measured rounds now span 94 to 1,655 seconds
d827fac Read the give-up time from the config, not the copy
760a6fd Give long runs 45 minutes, not 30
1672cc2 Run 4 is clean across the longest round yet
29fee03 Correct run 1's round timing: it was never measured
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

Tag `v0.1.0` resolves to commit `ff510b1130640bc43746259d6a742cd4bad6abf3`. The hash `6ff3718...` recorded here until 28 July 2026 is the annotated tag object, not the commit — `git ls-remote --tags` shows both. Every file and line reference in the docs points at `ff510b11`.

## The next step

Force the failure instead of waiting for it. That is the change of 28 July: the root cause reading says the block needs a request that reaches the operator and a response that cannot return, so a blackhole on the operator connection reproduces it deliberately. It costs no VTXO and takes minutes.

The procedure and the predicted outcomes are in the reproduction section of [RECEIVE_BLOCK_ROOT_CAUSE.md](RECEIVE_BLOCK_ROOT_CAUSE.md). In short: start the probe on Alice in fast mode with no exit, run `sudo scripts/operator-blackhole.sh window 0 60`, then read `__l2probe`.

The headline result to look for is a call that hangs the full ten minutes even though the network came back after one. If that happens, one minute of network trouble produces a ten-minute user-visible hang, which is the product argument in a single line. If instead the call recovers when the network returns, the response was durable and redelivered, and run 1's was lost for some other reason — which is a genuinely new finding.

Two cautions. The blackhole is host-wide, so Bob is not a valid control while it is on. And it changes the host firewall: check `status` and run `off` afterwards.

Filing upstream is shelved by the user's decision on 28 July 2026. The report is finished in [UPSTREAM_RECEIVE_BLOCKED.md](UPSTREAM_RECEIVE_BLOCKED.md), aimed at wavelength#1041 rather than at a new issue. Do not post it.

The unforced run still has a place, because the forced one proves the mechanism rather than the incident. If you run it, the questions are unchanged. First, from Alice alone: did the calls that started during the stall still get served? If they did, one response was lost. If they all stalled, receive was held wallet-wide, which is the bark shape. Second, from Bob: if Alice stalled wallet-wide, did Bob stall at the same moment?

Practical notes for a run:

- Alice's 30,000 boarded on 28 July, so VTXO supply is no longer the constraint it was.
- Budget the wall clock honestly. Run 4's round took 27.6 minutes against what was then a 30-minute cap. The cap is now 45 minutes, but a round can still outrun it.
- Scroll the start control into view before tapping it. The accessibility tree reports frames for content below the viewport, and a tap at that coordinate lands on the tab bar instead — which navigates away, remounting the screen. Harmless before a run, fatal during one.
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
