# Wavelength v0.1.0 test matrix

Use test coins only. Record platform, OS, device model, app build, network preset, Wavelength version, start/end timestamps, activity id, and native log excerpt for every result.

## Baseline flows

| Area | Test | Expected evidence |
| --- | --- | --- |
| Runtime | Start signet with defaults | Phase reaches `ready`; server connected; block height advances |
| Password wallet | Create, back up, stop, and unlock | Same identity and balance after unlock |
| Restore | Wipe and restore from mnemonic with recovery enabled | Wallet becomes usable; recovery scan converges; balance/activity return |
| Passkey | Create and unlock on supported Android device | PRF succeeds; same identity after relaunch |
| Boarding | Create Bitcoin address and fund it | Pending activity appears, then Ark balance becomes spendable |
| Lightning receive | Create and pay BOLT11 | Activity moves pending → settled and balance increases |
| Lightning send | Prepare, inspect fees, then send | Quote matches review; final activity and balance reconcile |
| Sweep | Sweep on-chain wallet balance | Destination and fee are explicit; activity eventually settles |
| Cooperative leave | Select VTXO and exit cooperatively | Transaction is broadcast and tracked to completion |
| Unilateral exit | Preview plan, fund fees, acknowledge, execute | Every transaction, delay, fee need, and phase is observable |

## Mobile lifecycle and failure injection

| Scenario | Procedure | Pass condition |
| --- | --- | --- |
| Offline Lightning receive | Create invoice, force-stop receiver, pay, reopen after 30s / 5m / near timeout | Outcome and timeout are deterministic; payer and receiver cannot disagree |
| Offline OOR receive | Generate destination, stop receiver, send OOR, reopen | Mailbox delivery materializes once with no duplicate balance |
| Send crash recovery | Kill at quote, dispatch, and pending states | No duplicate payment; terminal state reconciles after restart |
| Receive crash recovery | Kill before and after vHTLC funding | Claim or refund completes without lost state |
| Boarding restart | Kill before confirmation and during round | Deposit is rediscovered and boards exactly once |
| Refresh foreground | Shorten expiry in regtest and keep app open | VTXO is replaced before expiry without manual action |
| Refresh suspended | Suspend/kill through the refresh window | Document whether reopen refreshes, exits, or loses unilateral safety |
| Operator outage | Disable only Ark operator | Clear degraded state; no false success; exit data remains intact |
| Swap outage | Disable only swap server | Lightning fails/refunds without corrupting Ark funds |
| Indexer outage | Disable only Esplora | Chain-dependent state reports stale/offline and later converges |
| Restore without operator | Wipe device, restore mnemonic while operator/indexer unavailable | Record exactly what can be reconstructed and whether exit remains possible |
| Database durability | Kill process during every durable transition | SQLite reopens; state machine continues idempotently |
| OTA mismatch | Run newer JS bundle against older native runtime | Update is rejected or behavior remains version-compatible |

## Performance capture

Measure both debug and release builds on at least one low/mid-range Android device and one iPhone:

- Native artifact and installed app-size delta
- Cold launch to first frame
- Runtime start to `ready`
- Restore start to usable wallet and to recovery completion
- Idle and active RSS
- 30-minute foreground and 12-hour background battery/network use
- Activity-list performance after 100, 1,000, and 10,000 entries
- Resume time after 1 hour, 24 hours, and 30 days offline

## Go/no-go gates

- Mainnet onboarding supports arbitrary end-user wallet identities.
- Offline receive semantics and swap timelimits are documented and reproduced.
- Forced-expiry refresh passes with foreground, suspension, crash, and operator outage.
- Mnemonic restore plus unilateral exit works under the agreed operator-loss model.
- JS/native runtime version pairing cannot be broken by OTA delivery.
- Release builds pass Play/App Store native validation and measured resource budgets.
- Upstream security review and incident-response expectations are acceptable.
