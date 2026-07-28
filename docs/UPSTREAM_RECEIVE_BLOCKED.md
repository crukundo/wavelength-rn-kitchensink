# Upstream report: receive blocked for ten minutes

Shelved on 28 July 2026, by the user's decision. The text below is finished and reviewed, but it is not going upstream yet and no agent should file it. Revisit once the forced reproduction has run, which may add or remove an ask.

Rewritten on 28 July 2026. The previous draft asked which component held the wait and said we could not tell from the public source. We can, and it is answered in [RECEIVE_BLOCK_ROOT_CAUSE.md](RECEIVE_BLOCK_ROOT_CAUSE.md): waved's own mailbox response registry, on the phone, waiting out `DefaultResponseWaiterTTL`.

That makes this the same root cause as [wavelength#1041](https://github.com/lightninglabs/wavelength/issues/1041), reached through a different RPC. Filing the old draft as a new issue would have been a duplicate with two wrong claims in it.

## Where to send it

Post as a comment on issue 1041 rather than opening a new issue. It is closed, but the report is a second manifestation of a cause that issue already names, and the maintainers who fixed it are subscribed there.

Open a separate issue only for the waiter TTL, if at all. That is a design question rather than an incident, and it stands on its own: even with keepalive, a lost response strands a user-facing call for ten minutes.

## What is new, and worth their time

Three things, and nothing else in the old draft is worth keeping:

- the same failure reaches a second path, `NewReceiveScript` to the indexer, not just credit admission
- it was hit from a mobile client on the released v0.1.0, which does not carry the fix
- the fix is main-only. There is no v0.1.1 and no backport on `v0.1.x-branch`, so anyone building against the released tag still has an unprotected operator connection

Everything below the line is the comment text.

---

We hit what looks like the same root cause as this issue, on a different RPC path, from a mobile client. Reporting it here rather than opening a new issue since #1044 already names the mechanism.

## What we saw

One `receive` call blocked for 602,812 ms and then failed:

```text
create receive invoice: rpc error: code = Internal desc = start receive:
rpc error: code = Internal desc = start receive swap: allocate claim
receive script: create receive script: rpc error: code = Internal desc =
unable to create OOR receive script: register receive script:
response waiter expired
```

It reproduced once in five runs of the same procedure, on signet, against the public operator. The other four runs were clean, including 172 invoices in one run with a worst call of 3,341 ms.

The failing hop is `RegisterReceiveScriptTaproot` (`waved/receive_script.go:477`) on an `indexer.Client`, which rides `mailboxrpc.RPCClient` (`indexer/client.go:173`). So it is waved's `AwaitRPC` blocked on a reply from lumosd that never arrived — the same sentence as #1044, on the OOR receive-script path instead of `CreateCredit`.

602,812 ms is `DefaultResponseWaiterTTL` plus the lazy prune. `pruneStaleLocked` only runs inside `RegisterWaiter`, `HasWaiter` and `DeliverResponse`, so the caller wakes on the next mailbox activity after the TTL rather than at the TTL.

## Environment

- `wavelength` v0.1.0, commit `ff510b1130640bc43746259d6a742cd4bad6abf3`
- `@lightninglabs/wavelength-react` 0.1.0, `@lightninglabs/wavelength-react-native` 0.1.0
- React Native 0.81.5, React 19.1.0, Expo 54.0.25, New Architecture
- iOS 18.6 simulator, macOS 26.5.2
- signet, `signet.wavelength.lightning.finance`
- 24 July 2026. The blocked call started at about 14:05:21 UTC and failed at about 14:15:45 UTC

Those two stamps are the gap in our `swaps.db` rows: 22 successful receives ended at 14:05:21 UTC, nothing was written for ten minutes, and the next row is at 14:15:45 UTC. The blocked call wrote no row at all.

The daemon had been running for some hours on one connection, which is consistent with the stale-connection story in #1044.

## Why we are posting it

Two asks, both small.

First, v0.1.0 does not have #1044. It is tagged at `ff510b11` from 21 July and the fix merged on 23 July; `v0.1.x-branch` has no backport and v0.1.0 is the only release. Anyone building a client against the released tag still dials the operator with no keepalive. Is a v0.1.1 planned, or should integrators build from main?

Second, keepalive bounds the common case but not the waiter. `mailbox/` and `serverconn/` are unchanged between v0.1.0 and main, so a response lost for any other reason still strands the caller for ten minutes. Is a ten-minute TTL intended as the outer bound for a user-facing call, or is it a safety net that was never meant to be reached? From a client we cannot set it — `ResponseWaiterTTL` takes the default everywhere and nothing exposes it.

We can bound our own calls with a context deadline, and we will. But `code = Internal` after ten minutes is not something a wallet can show someone waiting to be paid, so a typed, retryable error at the point the wait gives up would help.

## One incidental detail

Every successful `receive` writes a `receive_swaps` row in `swaps.db` stamped `created_at_unix`, and ours line up with our probe timings exactly. The blocked call wrote no row at all, so it failed before any swap state was persisted.
