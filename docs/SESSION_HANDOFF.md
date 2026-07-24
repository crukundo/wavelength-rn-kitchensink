# Session handoff — 24 July 2026

Where the Wavelength evaluation stands, and what to pick up next. Written to be read cold.

## Why this work exists

Kesh removed its Bitcoin integration on 20 July 2026 (`/Users/rukundo/Desktop/kesh/docs/bitcoin-shelved.md`). Ark via the bark SDK was judged too early, for two specific reasons rather than a general sense of risk:

- VTXO expiry silently swept funds from an inactive wallet, and bark still reported the swept VTXOs as spendable — 41,989 sats displayed that the user no longer had
- `wallet.maintenance()` waited on server rounds with no timeout, holding the wallet lock and blocking invoice creation, so users could not receive

This repo is the harness for evaluating whether Lightning Labs' Wavelength answers those two failures well enough to carry Kesh user money. The target is a Lightning wallet for every Kesh user: reliable onramp, paying Lightning invoices and LNURLs, and on-chain bitcoin.

## Read these first

- [PAYMENT_TEST_FRAMEWORK.md](PAYMENT_TEST_FRAMEWORK.md) — the two decisive questions, the balance model, and a 22-test matrix with pass conditions. Six tests already have results
- [WAVELENGTH_CONSTRAINTS.md](WAVELENGTH_CONSTRAINTS.md) — every limit verified against source, with provenance markers. Three earlier entries were wrong and are marked as corrections

Do not trust any constraint in those docs that is not marked Source. The Observed and Unverified entries are exactly that.

Both documents were audited against the source on 24 July 2026, after they were written. The audit found one factual error and one overclaim, both corrected. The confidence register in the test framework is the authoritative list of what is verified, what was seen once, and what is inference. Read it before quoting any finding to anyone.

## Environment

Two iOS simulators, both renamed, both running the same dev build against one Metro on port 8081.

| Name | Device | UDID | Theme |
| --- | --- | --- | --- |
| Alice | iPhone 11, iOS 18.6 | `29C47385-6C57-4ADC-B257-4D46F3029302` | light |
| Bob | iPhone 16 Pro, iOS 18.6 | `E1A6CCCF-3B55-4A2A-B509-1B41ED3F2E42` | dark |

Both on signet. Balances are deliberately not recorded here: they were last seen at 15:46 on 24 July 2026 and will have moved. Read them from the app rather than trusting a figure in this document. Bob had boarded twice and held credit from a 500 sat receive; Alice was funded and had been sending.

Separate simulators give separate app containers, so each wallet has its own dataDir, seed and node identity. No code changes were needed to make them distinct users.

To add another wallet, install the existing build rather than rebuilding:

```sh
xcrun simctl install <udid> \
  ~/Library/Developer/Xcode/DerivedData/WavelengthKitchenSink-*/Build/Products/Debug-iphonesimulator/WavelengthKitchenSink.app
```

Then launch it and pick `http://localhost:8081` in the dev launcher.

Two environment changes to be aware of: both simulators were renamed with `xcrun simctl rename`, and Bob's simulator OS appearance was set to dark via `xcrun simctl ui`. Both are cosmetic and reversible.

## Uncommitted work

Nothing is committed. Branch is `main` at `fed4910`.

New:
- `docs/PAYMENT_TEST_FRAMEWORK.md`
- `docs/WAVELENGTH_CONSTRAINTS.md`
- `src/screens/activity/ActivityDetail.tsx`

Modified:
- `src/components/ActivityRow.tsx` — optional `onPress`, pressed state, accessibility label
- `src/screens/activity/ActivityScreen.tsx` and `src/screens/home/HomeScreen.tsx` — both open the detail sheet, tracking the open entry by id so a pending entry updates in place
- `src/lib/format.ts` — added `formatTimestampFull`
- `README.md` — links to both new docs

`bun run check` passes: typecheck, architecture lock, and all 17 expo-doctor checks.

## What was built

An activity detail sheet. The list row shows 8 of roughly 26 Entry fields and truncates three of them, which meant the real reason a payment failed was only readable through the accessibility tree. The sheet shows everything: full failure reason with a plain-English hint mapped from `failureCode`, the complete invoice or address, payment hash, preimage, txid, VTXO outpoint, and created against last update.

One trap worth remembering: wrapping the sheet in a `Pressable` to absorb backdrop taps made it claim the touch responder, so the `ScrollView` rendered everything but refused to scroll. The backdrop is now an absolutely positioned sibling.

## The source clone is gone

Most findings came from reading the Wavelength Go source, which is public and MIT licensed. It was cloned to a session scratchpad that does not persist. Re-clone it:

```sh
git clone --depth 1 --branch v0.1.0 https://github.com/lightninglabs/wavelength.git
```

Tag `v0.1.0` is commit `6ff371852ff93044ffeab201fbb61a87520ef67e`. Every file and line reference in the two docs points at that commit.

## Where things stand

Answered, from source:

- the phantom-balance half of the bark failure is addressed while the wallet is running. There is a per-VTXO expiry state machine, thresholds that scale with tree depth and CSV delay, escalation to unilateral exit at critical, and a spendable balance traced end to end as Live-VTXO only. The caveat: expiry is evaluated on block epochs, so a wallet reopened after a long closure can briefly report value it no longer holds. L1 must measure that window
- the lease itself appears unchanged, on the inference that a closed app processes no block epochs. Not tested. Do not state it as fact
- a mitigation is buildable today: `WalletVTXO` exposes `batchExpiry` and `relativeExpiry`, and `Info` carries `blockHeight`, so blocks-remaining is computable per VTXO. A visible deadline is possible even though the lease is not removable

Open, and blocking:

- test L2, the maintenance lock. Kesh's second killer. Wavelength bounds several waits but nobody has traced whether a round join can block invoice creation. This is the cheapest decisive test left and should be next
- the SDK exposes only one of eleven operator policy values (`freeRefreshWindowBlocks`). Without the VTXO floor a client cannot compute the true maximum sendable, so it cannot reject an impossible amount before the confirmation screen. This is the highest-value upstream ask
- LNURL is in the Kesh requirement and has not been shown to work at all
- `progress.preimage` was empty on a completed Lightning send, so proof of payment is not yet demonstrated

## Suggested next session

1. Run L2. Start a round join on Alice, then immediately create invoices on both wallets. Anything over 30 seconds reproduces the bark failure
2. Run L1 if there is time to leave a wallet closed past the batch expiry window. Read the window from a VTXO's `batchExpiry` first
3. Work through the receive matrix R4 to R7, which covers the offline cases that decide whether onramp is reliable
4. Commit the current work before adding more

## Loose ends

- an Argent update to 0.17.0 is available. The user has not asked for it and it must not be applied without explicit consent
- one unexplained observation: an on-chain send sat at `request created` from 12:26 without broadcasting, while a second send from the same wallet reached `settling`. Never diagnosed
- `AlreadyExists: receive intent already used` originates in the swap server, which is not in the public repo. Our reading of the invoice burn matches observed behaviour but is unverified
