# Upstream report: receive blocked for ten minutes

Shelved on 28 July 2026, by the user's decision. The text below is finished and reviewed, but it is not going upstream yet and no agent should file it. Revisit once the forced reproduction has run, which may add or remove an ask.

Rewritten on 28 July 2026. The previous draft asked which component held the wait and said we could not tell from the public source. We can, and it is answered in [RECEIVE_BLOCK_ROOT_CAUSE.md](RECEIVE_BLOCK_ROOT_CAUSE.md): waved's own mailbox response registry, on the phone, waiting out `DefaultResponseWaiterTTL`.

That makes this the same root cause as [wavelength#1041](https://github.com/lightninglabs/wavelength/issues/1041), reached through a different RPC. Filing the old draft as a new issue would have been a duplicate with two wrong claims in it.

## Where to send it

Post as a comment on issue 1041 rather than opening a new issue. It is closed, but the report is a second manifestation of a cause that issue already names, and the maintainers who fixed it are subscribed there.

Open a separate issue only for the client-surface deadline, if at all. The question changed on 28 July 2026 after checking the SDK types: `receive()` takes no signal or timeout, so a wallet can stop waiting but cannot cancel the call. That gap matters more than the TTL's exact value — with a per-call deadline the 10-minute waiter becomes invisible plumbing, and without one it is the effective user-facing bound for anyone who does not hand-roll a race.

## Deliberately minimal

The comment is 2 paragraphs by the user's decision on 28 July 2026: the incident in 2 sentences, then the one question. Everything else was cut because the maintainers already know it — the mechanism is theirs, the backport process is visible in their branch list, and the ping deployment is their own infrastructure. Twenty `backport-*` branches and a 48-hour fix chain say they are on it; the comment does not chase a roadmap.

If they ask for detail, the full fingerprint is in [RECEIVE_BLOCK_ROOT_CAUSE.md](RECEIVE_BLOCK_ROOT_CAUSE.md): the error chain with citations, UTC timestamps to the second from `swaps.db`, the run table, and the keepalive measurement.

Everything below the line is the comment text.

---

Some context first. While evaluating v0.1.0 from a React Native wallet on signet, we hit what looks like this same failure on another path: one `receive` blocked for 602,812 ms and failed with `unable to create OOR receive script: register receive script: response waiter expired` — the indexer registration riding the operator mailbox. It happened once in 5 runs; the other 337 calls stayed under 3.4 seconds.

One question, when someone has a moment. Is a per-call deadline or cancellation planned for the client surface? `receive()` takes no signal or timeout today, so the 10-minute `DefaultResponseWaiterTTL` is the effective bound on a lost response. A JS-side race abandons the call without cancelling it. A deadline, plus a typed error that separates a retryable network failure from a real one, would let a wallet keep this away from users entirely. No urgency — we are reporting more than requesting.
