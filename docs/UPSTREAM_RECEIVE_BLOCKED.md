# Upstream report: receive blocked for ten minutes

Shelved on 28 July 2026, by the user's decision. The text below is finished and reviewed, but it is not going upstream yet and no agent should file it. Revisit once the forced reproduction has run, which may add or remove an ask.

Rewritten on 28 July 2026. The previous draft asked which component held the wait and said we could not tell from the public source. We can, and it is answered in [RECEIVE_BLOCK_ROOT_CAUSE.md](RECEIVE_BLOCK_ROOT_CAUSE.md): waved's own mailbox response registry, on the phone, waiting out `DefaultResponseWaiterTTL`.

That makes this the same root cause as [wavelength#1041](https://github.com/lightninglabs/wavelength/issues/1041), reached through a different RPC. Filing the old draft as a new issue would have been a duplicate with two wrong claims in it.

## Where to send it

Post as a comment on issue 1041 rather than opening a new issue. It is closed, but the report is a second manifestation of a cause that issue already names, and the maintainers who fixed it are subscribed there.

Open a separate issue only for the client-surface deadline, if at all. The question changed on 28 July 2026 after checking the SDK types: `receive()` takes no signal or timeout, so a wallet can stop waiting but cannot cancel the call. That gap matters more than the TTL's exact value — with a per-call deadline the 10-minute waiter becomes invisible plumbing, and without one it is the effective user-facing bound for anyone who does not hand-roll a race.

## What is new, and worth their time

Three things, and nothing else in the old draft is worth keeping:

- the same failure reaches a second path, `NewReceiveScript` to the indexer, not just credit admission
- it was hit from a mobile client on the released v0.1.0, which does not carry the fix
- the fix is main-only. There is no v0.1.1 and no backport of #1044 on `v0.1.x-branch`, so anyone building against the released tag still has an unprotected operator connection

Keep the tone in proportion. Twenty `backport-*-to-v0.1.x-branch` branches show a point-release process in motion, the whole 1041 fix chain shipped in about 48 hours, and we measured the server-side leg already deployed. They are on it. The comment reports and asks one design question; it does not chase a roadmap.

Everything below the line is the comment text.

---

We hit what looks like the same root cause as this issue, on a different RPC path, from a mobile client on the released v0.1.0. We are commenting here rather than opening a new issue because #1044 already names the mechanism.

One `receive` call blocked for 602,812 ms and then failed:

```text
create receive invoice: rpc error: code = Internal desc = start receive:
rpc error: code = Internal desc = start receive swap: allocate claim
receive script: create receive script: rpc error: code = Internal desc =
unable to create OOR receive script: register receive script:
response waiter expired
```

The failing hop is `RegisterReceiveScriptTaproot` (`waved/receive_script.go:477`) on the indexer client, which rides the operator mailbox (`indexer/client.go:173`). waved's `AwaitRPC` waited for a reply from lumosd that never arrived — the same sentence as #1044, on the OOR receive-script path instead of `CreateCredit`. The duration is `DefaultResponseWaiterTTL` plus the lazy prune in `pruneStaleLocked`.

It happened once in 5 runs of the same procedure: signet, `signet.wavelength.lightning.finance`, 24 July 2026, blocked call about 14:05:21 to 14:15:45 UTC. The other 4 runs were clean: 337 invoices, worst call 3,341 ms. The blocked call wrote no `receive_swaps` row, so it died before writing any swap state. Client: v0.1.0 (`ff510b11`), `wavelength-react-native` 0.1.0, React Native 0.81.5, iOS 18.6 simulator.

Two observations that may help:

- #1044 has no `backport-1044-to-v0.1.x-branch` yet, while many neighbouring PRs do. We flag it in case that is an oversight rather than a decision
- the signet operator now accepts streamless 30-second pings. We sent 6 in a row over raw HTTP/2 and all were acked with no `GOAWAY`, so the lumos#699 leg looks live. This answers the deployment concern raised in the #1044 review

One question, when someone has a moment. Is a per-call deadline or cancellation planned for the client surface? `receive()` takes no signal or timeout today, so the 10-minute `DefaultResponseWaiterTTL` is the effective bound on a lost response. A JS-side race abandons the call without cancelling it. A deadline, plus a typed error that separates a retryable network failure from a real one, would let a wallet keep this away from users entirely. No urgency — we are reporting more than requesting.
