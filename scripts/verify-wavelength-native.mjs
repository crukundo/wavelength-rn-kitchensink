import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', 'node_modules', '@lightninglabs', 'wavelength-react-native');
const artifacts = [
  join(root, 'android', 'libs', 'Wavewalletdk.aar'),
  join(root, 'ios', 'Wavewalletdk.xcframework'),
];

let failed = false;
for (const artifact of artifacts) {
  if (!existsSync(artifact)) {
    console.error(`Missing: ${artifact}`);
    failed = true;
    continue;
  }
  const size = statSync(artifact).isFile() ? `${statSync(artifact).size} bytes` : 'directory';
  console.log(`Present: ${artifact} (${size})`);
}

if (failed) {
  console.error('Run `bun run stage:native` to download and checksum-verify both runtimes.');
  process.exit(1);
}

const gradle = readFileSync(join(root, 'android', 'build.gradle'), 'utf8');
if (!gradle.includes('compileOnly files("libs/Wavewalletdk.aar")')) {
  console.error('The Android nested-AAR compatibility patch is missing. Run `bun run stage:android`.');
  process.exit(1);
}
console.log('Android nested-AAR compatibility patch is present.');

const podspec = readFileSync(join(root, 'WavelengthReactNative.podspec'), 'utf8');
if (!podspec.includes('"OTHER_CPLUSPLUSFLAGS" => "$(inherited) -fcxx-modules"')) {
  console.error('The iOS Objective-C++ modules compatibility patch is missing. Run `bun run stage:ios`.');
  process.exit(1);
}
console.log('iOS Objective-C++ modules compatibility patch is present.');

const moduleSource = readFileSync(join(root, 'ios', 'WavelengthModule.mm'), 'utf8');
if (!moduleSource.includes('#import <ReactCommon/RCTTurboModule.h>\n#import <jsi/jsi.h>')) {
  console.error('The RN 0.81 TurboModule header compatibility patch is missing. Run `bun run stage:ios`.');
  process.exit(1);
}
console.log('RN 0.81 TurboModule header compatibility patch is present.');
