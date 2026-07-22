# Build validation

Validated on 2026-07-22 against the exact dependency and native-platform pins in `app.config.ts` and `package.json`.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Dependency consistency | Pass | Expo Doctor: 17/17 checks |
| TypeScript | Pass | `tsc --noEmit` |
| Architecture lock | Pass | Expo 54.0.25, React Native 0.81.5, React 19.1.0, New Architecture, iOS 15.2, Android 24/36, Wavelength 0.1.0 |
| Android debug | Pass | `assembleDebug`; 224 MB universal ARM APK |
| Android release | Pass | `assembleRelease` with R8/resource shrinking; 187 MB universal ARM APK |
| Android App Bundle | Pass | `bundleRelease`; 116 MB two-ABI AAB before Play delivery splitting |
| iOS simulator debug | Pass | Xcode simulator build with Wavelength XCFramework; 340 MB unthinned `.app` |
| iOS launch | Pass | Launched on iPhone 11 simulator, iOS 18.6 |
| JS/native bridge | Pass | UI reported Wavelength runtime 0.1.0 |
| Signet runtime initialization | Pass | Default Signet runtime advanced to wallet creation without an exception |

These are smoke results, not protocol certification. No funded Lightning, boarding, restore, refresh-expiry, exit, background, or adversarial failure case has been marked complete. Those remain in `TEST_MATRIX.md`.

## Integration patches required for Expo 54 / React Native 0.81

The staging scripts apply three narrow, reproducible compatibility patches to Wavelength 0.1.0 after every install:

1. Android compiles the Wavelength library against its local gomobile AAR and packages that AAR at the application layer. A nested local AAR cannot be packaged by the Android Gradle Plugin used by Expo 54.
2. The iOS pod target enables Clang/C++ modules because the generated gomobile headers use `@import Foundation` from Objective-C++.
3. The iOS bridge explicitly imports TurboModule and JSI headers that are not transitively visible in React Native 0.81's header graph.

These patches are version-specific. Treat a Wavelength or React Native upgrade as a fresh native integration and rerun every build and runtime check.

## Size context

The staged Android AAR is about 162 MB and contains both supported ARM ABIs. The extracted iOS XCFramework is about 560 MB because it contains device and simulator slices. Source artifact sizes are not user download sizes, but they materially affect dependency staging, CI cache, build time, and repository strategy. Native binaries are checksum-verified and deliberately excluded from git.

## Runtime smoke path

1. Install the native iOS development build.
2. Connect it to Metro on an explicit non-default port.
3. Confirm the Wavelength start screen and runtime version 0.1.0.
4. Start the default Signet runtime.
5. Confirm navigation to wallet creation with both passkey and password options.

The simulator pass establishes that the native framework loads and the runtime can initialize. Passkeys still require real associated-domain credentials and should be validated on a physical device; the password path is the reliable baseline.
