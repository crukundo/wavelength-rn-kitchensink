# Why receive blocked for ten minutes

The ten-minute block in L2 run 1 is not a mystery. It is a named constant in the Wavelength source, the wait happens inside our own daemon on the phone, and Lightning Labs diagnosed the same root cause on a different RPC six days before we hit it.

Found on 28 July 2026 by reading the v0.1.0 source at `ff510b11`. Everything here is source-verified or quoted from an upstream pull request. Read it before quoting the L2 section of [PAYMENT_TEST_FRAMEWORK.md](PAYMENT_TEST_FRAMEWORK.md), which this supersedes on the question of where the wait lives.

## The ten minutes is a constant

`mailbox/conn/response_registry.go:16`:

```go
const DefaultResponseWaiterTTL = 10 * time.Minute
```

Line 20 defines the error we saw:

```go
var ErrWaiterExpired = fmt.Errorf("response waiter expired")
```

Our blocked call took 602,812 ms. The constant is 600,000 ms.

Nothing overrides it. `serverconn/types.go:336` takes `mailboxconn.DefaultResponseWaiterTTL` as the default and no flag, config file field or SDK option is wired to `ResponseWaiterTTL`. Grepping the tree finds two assignments, both the default.

The 2,812 ms of overshoot is explained too, and it corroborates the reading. `pruneStaleLocked` has no timer. It runs only inside `RegisterWaiter`, `HasWaiter` and `DeliverResponse` (`response_registry.go:111`, `:161`, `:207`). An expired waiter therefore sits past its TTL until the next mailbox activity trips the sweep.

## The wait is inside waved, on the phone

The whole error chain is in the public repository. None of it is the swap server.

| Frame in the error | Source |
| --- | --- |
| `create receive invoice` | `sdk/wavewalletdk/client.go:359` |
| `start receive` | `swapwallet/recv.go:96` |
| `allocate claim receive script` | `sdk/swaps/out_swap.go:652` |
| `create receive script` | `sdk/ark/client.go:629`, calling the daemon's `NewReceiveScript` |
| `unable to create OOR receive script` | `waved/rpc_oor_receive.go:74` |
| `register receive script` | `waved/receive_script.go:480`, wrapping `RegisterReceiveScriptTaproot` |
| `response waiter expired` | `mailbox/conn/response_registry.go:20` |

The last hop is the one that matters. `waved/receive_script.go:477` calls `registerClient.RegisterReceiveScriptTaproot`, where `registerClient` is an `indexer.Client`. That client is constructed over a `mailboxrpc.RPCClient` (`indexer/client.go:173`), which `serverconn/unary_facade.go` implements.

So the receive path registers a script with the operator's indexer over the mailbox transport. `SendRPC` registers a waiter keyed by correlation ID and sends the envelope. `AwaitRPC` then blocks on `future.Await(ctx)` (`unary_facade.go:169`) with the caller's context. Our call carried no deadline, so it waited for the TTL.

This answers a question the earlier upstream draft said could not be answered from the public source. The wait is not in the swap server and not a local mutex. It is waved's own mailbox response registry, running on the phone, waiting for a `KIND_RESPONSE` envelope from the operator that never arrived.

## Upstream found this on 22 July

Issue [wavelength#1041](https://github.com/lightninglabs/wavelength/issues/1041) is not a neighbouring bug. It is the same root cause reached through the credit path instead of the OOR receive-script path. It was filed by levmi on 22 July 2026 and closed on 23 July with the comment "Resolved with PRs to timeout sooner, an a bigger fix on the backend."

The client-side PR is [wavelength#1044](https://github.com/lightninglabs/wavelength/pull/1044), merged 23 July 02:32 UTC. Its description states the mechanism:

> swapd's per-operation credit actors were blocked inside `fundingLanded` calling out to waved with no context timeout, waved's own `AwaitRPC` was blocked waiting on a reply from lumosd that never arrived

And the cause:

> Two specific requests just vanished after `lumosd-signet` restarted 13h into a connection that predated it by another 11h, with no error and no trace on either side. That's consistent with the connection surviving the restart in a state where it looks alive but silently drops traffic, which is exactly the class of failure client-side keepalive exists to catch.

The connection in question is `dialServer`'s, from waved to the ark operator's mailbox edge. Neither it nor the swap-server connection had any keepalive, and grpc-go does not ping an idle channel unless told to.

lumosd is our operator. `signet.wavelength.lightning.finance` is a CNAME to `lumosd-signet.staging.lightningcluster.com`.

## The fix is not in the build we run

- v0.1.0 is commit `ff510b11`, dated 21 July 2026. PR 1044 merged 23 July.
- `v0.1.x-branch` head is `7cbef62b`, also 21 July. There is no backport.
- v0.1.0 is the only release.

So our daemon dials the operator with no keepalive. A connection that goes silently stale reports READY indefinitely while every RPC on it hangs.

The fix on main is 30s ping interval, 10s timeout, `PermitWithoutStream: true` (`waved/server.go`, commit `ebe7b85a`).

Two things this does not fix, and both matter to us.

First, `mailbox/` and `serverconn/` are byte-identical between v0.1.0 and main. The ten-minute waiter TTL is still the outer bound on main today. Keepalive shortens the common case by detecting a dead connection in about 40 seconds; it does not bound the waiter. A response lost for any other reason still hangs the caller for ten minutes.

Second, PR 1044 says explicitly that it does not touch "the credit registry's missing per-call timeout or its blocking-mailbox head-of-line issue". Head-of-line blocking is the difference between one lost call and a wallet that cannot receive at all, which is exactly what our probe was built to measure.

The two server-side legs, lumos#699 and swapdk-server#245, are in private repositories. We cannot check whether the signet operator got its matching keepalive enforcement policy, and without it the client-side pings would be answered with `GOAWAY too_many_pings`.

## What this changes

The round was probably a coincidence. If the trigger is a stale operator connection, then the cooperative exit had nothing to do with it — it is simply what we happened to be doing when the connection went bad. That fits the evidence better than anything we had before: four clean runs executed rounds of 94 to 1,655 seconds with receive untouched, and no measured property of the round predicted the block.

It also means we do not need to spend a VTXO to reproduce this. See the section below.

The probe's two discriminators now map onto two mechanisms with different predicted signatures:

- a dead connection kills ingress for the whole daemon, so every in-flight receive on Alice stalls together and Bob is untouched, because he has his own daemon and his own connection
- a single lost response strands one correlation ID, so only that call stalls and calls started during it are served normally

Run 1 could distinguish neither, because the serial sampler attempted nothing during the ten minutes it was stuck.

For Kesh there is a mitigation available today, independent of upstream. The block is a wait with no deadline. Passing a context deadline on the receive call bounds it at our own chosen value and turns a ten-minute hang into a fast, typed failure we can retry or explain. That does not fix the lost response, but it removes the part of the failure that is unusable in a product.

## Reproducing it on demand

The point of this section is to replace a one-in-five, half-hour lottery with a test we can run whenever we like.

If the mechanism above is right, the failure needs one condition: the request reaches the operator, and the response never reaches us, while the connection stays open. A network blackhole to the operator produces exactly that, provided it starts after the send has landed.

The transport makes this easier than it sounds. The mailbox is store and forward. `Edge.Send` is a short RPC that hands the envelope over; the reply comes back later through the ingress pull loop on the same connection. So a blackhole that starts a second into a receive call leaves the send already delivered and the response unable to return.

`scripts/operator-blackhole.sh` implements this with a pf anchor that drops, rather than rejects, outbound packets to the operator. Dropping is the point: a reject would send a TCP reset and the client would re-dial immediately, which is the failure gRPC already handles.

The procedure:

1. Start the lock probe on Alice in fast mode, 3-second interval. Do not start an exit — no VTXO is spent.
2. Run `sudo scripts/operator-blackhole.sh window 0 60`. Any call in flight has already sent.
3. Watch `__l2probe` over the Metro debugger.

What each outcome tells us:

- the in-flight call hangs for about ten minutes and dies with `response waiter expired`, even though the network came back after 60 seconds. That confirms the mechanism end to end, and demonstrates the product argument in one line: a minute of network trouble produces a ten-minute user-visible hang, because nothing retries and the TTL is unconditional
- the call recovers when the network returns. That means the response is durable and was redelivered on reconnect, so run 1's response was lost for a different reason and we have learned something genuinely new
- the calls started during the blackhole fail at the send instead, with a different error. Expected, and it is the control that shows the timing worked

Two cautions. The blackhole is host-wide, so Bob hits it too and is not a valid control during a forced run. And pf changes the host firewall: the script scopes itself to one anchor and one table, but check `status` and run `off` when you are done.

## What is still unknown

- whether run 1 was a dead connection or a single lost response. The forced reproduction and the concurrent sampler both bear on this
- whether the signet operator has the server-side keepalive enforcement. Private repositories, so only Lightning Labs can say
- whether a ten-minute waiter TTL is intended as the outer bound for a user-facing call, or is a safety net that was never meant to be reached
- whether the automatic VTXO refresh path shares this code path. Still untriggerable from a client
