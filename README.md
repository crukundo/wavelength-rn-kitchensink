# Wavelength React Native Kitchen Sink

A native-only Wavelength v0.1.0 integration harness, locked to the architecture used by Kesh:

- Expo 54.0.25
- React Native 0.81.5 and React 19.1.0
- React Native New Architecture with Hermes
- Bun 1.3.12
- iOS 15.2 deployment target
- Android minSdk 24 / targetSdk 36
- Android physical-device ABIs (`arm64-v8a`, `armeabi-v7a`) matching Kesh

This is test software for signet, testnet, and local regtest. **Never use mainnet funds.** Wavelength v0.1.0 is an alpha and its mainnet service is invite-only.

The wallet UX is derived from Lightning Labs' MIT-licensed v0.1.0 React Native reference demo, then adapted to Kesh's pinned architecture. It exercises the currently published native SDK surface rather than mocking it.

## Capability coverage

- Runtime start, stop, readiness, custom endpoints, TLS/insecure modes, and log level
- Password and passkey wallet creation/unlock
- Mnemonic backup and server-assisted restore/recovery status
- Balance, wallet composition, identity, server state, and block height
- Bitcoin boarding address and QR
- BOLT11 receive invoice and live settlement activity
- Payment quote, fee review, and prepared send
- Activity stream and explicit reconciliation refresh
- On-chain wallet sweep
- VTXO listing and selection
- Cooperative and unilateral exit planning
- Batch exits, funding top-up, progress, and exit status
- Runtime log display during synchronization
- Stop, local wallet-data wipe, and restart

See [docs/TEST_MATRIX.md](docs/TEST_MATRIX.md) for the destructive and lifecycle cases that cannot be established by simply tapping through the happy path.
See [docs/BUILD_VALIDATION.md](docs/BUILD_VALIDATION.md) for the current native build, artifact-size, and simulator smoke-test evidence.
See [docs/WAVELENGTH_CONSTRAINTS.md](docs/WAVELENGTH_CONSTRAINTS.md) for confirmed protocol and SDK limits, each with provenance, and what they imply for wallet design.
See [docs/PAYMENT_TEST_FRAMEWORK.md](docs/PAYMENT_TEST_FRAMEWORK.md) for the two-wallet test matrix, the balance model, and what must be true before this carries real money.

## Install

```sh
fnm use 22
bun install
```

The npm package intentionally does not contain the 100+ MB native runtimes. The platform commands download the paired Wavelength v0.1.0 release artifact, verify its pinned SHA-256 digest, and stage it under `node_modules` before prebuild.

On Android, the staging step also applies a narrow compatibility adjustment required by Expo 54's Android Gradle Plugin: the Wavelength library compiles against the gomobile AAR while the generated application packages that AAR directly. Upstream's nested local-AAR declaration fails `bundleDebugAar` under this toolchain.

On iOS, the staging step enables Clang and C++ modules for the Wavelength Objective-C++ pod target. The gomobile-generated headers use `@import Foundation`, which Expo 54 otherwise compiles with C++ modules disabled.

The same iOS staging step adds the explicit TurboModule and JSI includes required by React Native 0.81. Wavelength's v0.1.0 bridge was authored against RN 0.86, where those declarations are visible transitively; they are not under Kesh's RN 0.81 header graph.

```sh
bun run stage:android
bun run stage:ios
# or both:
bun run stage:native
```

## Run

Expo Go cannot load Wavelength. Use a native development build:

```sh
# Terminal 1
bun run start:clear

# Terminal 2
bun run android
# or
bun run ios
```

The start screen defaults to public signet. Testnet uses Lightning Labs' published testnet preset. Regtest expects the operator on `:7070`, Esplora on `:8501`, and swap server on `:10030`; Android emulator host traffic is mapped to `10.0.2.2` automatically.

## Checks

```sh
bun run check
bun run verify:native
```

For a clean native regeneration:

```sh
bun run clean:android
bun run clean:ios
```

## Passkeys

The harness retains Lightning Labs' demo application id and RP id so Android's published demo association can be exercised with the standard debug certificate. Use only throwaway test wallets. Android requires API 28+, a Play-enabled image, signed-in Google account, and device screen lock.

iOS passkeys remain experimental upstream and the published association does not authorize a personal Apple team. Password and mnemonic flows are the reliable cross-platform baseline for this harness.

## Native runtime lifecycle

Create exactly one `WalletEngine` at module scope. A Metro reload can outlive the native daemon and produce `wavelength mobile already started`; force-quit and relaunch the app when that happens. Runtime logs are native, with only the SDK's buffered log tail exposed to the React layer during relevant flows.

## Current artifact-size warning

Wavelength v0.1.0 is a large native dependency. On this pinned build, the universal ARM Android APK is 224 MB in debug and 187 MB after release shrinking; the release AAB is 116 MB before Play delivery splits it by ABI. The on-device download and installed size must still be measured on actual target devices before product adoption. The iOS simulator debug application is 340 MB and is not representative of a thinned App Store download.

## Upstream

- [Wavelength documentation](https://wavelength.lightning.engineering/)
- [Wavelength SDK v0.1.0](https://github.com/lightninglabs/wavelength-sdk/tree/v0.1.0)
- [Wavelength v0.1.0 native artifacts](https://github.com/lightninglabs/wavelength/releases/tag/v0.1.0)
