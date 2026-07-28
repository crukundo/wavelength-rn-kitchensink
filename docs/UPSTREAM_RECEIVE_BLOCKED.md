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

We hit what looks like the same root cause as this issue, on a different RPC path, from a mobile client on the released v0.1.0. Commenting here rather than opening a new issue since #1044 already names the mechanism.

One `receive` call blocked for 602,812 ms and then failed:

```text
create receive invoice: rpc error: code = Internal desc = start receive:
rpc error: code = Internal desc = start receive swap: allocate claim
receive script: create receive script: rpc error: code = Internal desc =
unable to create OOR receive script: register receive script:
response waiter expired
```

The failing hop is `RegisterReceiveScriptTaproot` (`waved/receive_script.go:477`) on the indexer client, which rides the operator mailbox (`indexer/client.go:173`). So it is waved's `AwaitRPC` blocked on a reply from lumosd that never arrived — the same sentence as #1044, on the OOR receive-script path instead of `CreateCredit`. The duration is `DefaultResponseWaiterTTL` plus the lazy prune in `pruneStaleLocked`.

It happened once in five runs of the same procedure: signet, `signet.wavelength.lightning.finance`, 24 July 2026, blocked call about 14:05:21 to 14:15:45 UTC. The other four runs were clean, worst call 3,341 ms across 337 invoices. The blocked call wrote no `receive_swaps` row, so it failed before any swap state was persisted. Client: v0.1.0 (`ff510b11`) via `wavelength-react-native` 0.1.0, React Native 0.81.5, iOS 18.6 simulator.

Two questions:

1. v0.1.0 does not carry #1044 and `v0.1.x-branch` has no backport. Is a v0.1.1 planned, or should integrators build from main? On the concern in the #1044 review: the signet operator now accepts streamless 30s pings — we sent six in a row over raw HTTP/2 and all were acked with no `GOAWAY`, so lumos#699 looks deployed.
2. Keepalive bounds the common case but not the waiter. `mailbox/` and `serverconn/` are unchanged on main, so a lost response still strands the caller for ten minutes, and nothing exposes `ResponseWaiterTTL`. Is ten minutes intended as the outer bound for a user-facing call? We can add our own context deadline, but a typed, retryable error at expiry would help — `code = Internal` after ten minutes is not something a wallet can show someone waiting to be paid.
