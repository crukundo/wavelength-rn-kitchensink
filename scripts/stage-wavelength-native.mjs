import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { cp, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

const VERSION = 'v0.1.0';
const RELEASE_ROOT = `https://github.com/lightninglabs/wavelength/releases/download/${VERSION}`;
const ROOT = resolve(import.meta.dirname, '..');
const PACKAGE_ROOT = join(ROOT, 'node_modules', '@lightninglabs', 'wavelength-react-native');
const CACHE_ROOT = join(ROOT, '.cache', 'wavelength', VERSION);

const assets = {
  android: {
    name: 'Wavewalletdk.aar',
    sha256: '8929aa25a49800bc4f421efb4f159fdffc039fe157759e1b3223422706fc302c',
  },
  ios: {
    name: 'Wavewalletdk.xcframework.tar.gz',
    sha256: '920d44255e5c2e04e039ac9eac708b2e7087e17dc4dfcfd491bf5f0b3cf86e7c',
  },
};

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifiedDownload(asset) {
  mkdirSync(CACHE_ROOT, { recursive: true });
  const destination = join(CACHE_ROOT, asset.name);

  if (existsSync(destination) && (await digest(destination)) === asset.sha256) {
    console.log(`Using verified cache: ${asset.name}`);
    return destination;
  }

  const partial = `${destination}.partial`;
  rmSync(partial, { force: true });
  console.log(`Downloading ${asset.name} from ${VERSION}…`);
  const response = await fetch(`${RELEASE_ROOT}/${asset.name}`, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed for ${asset.name}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));

  const actual = await digest(partial);
  if (actual !== asset.sha256) {
    rmSync(partial, { force: true });
    throw new Error(`Checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${actual}`);
  }
  await rename(partial, destination);
  return destination;
}

function findDirectory(root, name) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (!statSync(path).isDirectory()) continue;
    if (entry === name) return path;
    const nested = findDirectory(path, name);
    if (nested) return nested;
  }
  return null;
}

async function stageAndroid() {
  const source = await verifiedDownload(assets.android);
  const destination = join(PACKAGE_ROOT, 'android', 'libs', 'Wavewalletdk.aar');
  mkdirSync(dirname(destination), { recursive: true });
  await cp(source, destination);
  const gradlePath = join(PACKAGE_ROOT, 'android', 'build.gradle');
  const gradle = await readFile(gradlePath, 'utf8');
  const patched = gradle.replace(
    'api files("libs/Wavewalletdk.aar")',
    'compileOnly files("libs/Wavewalletdk.aar")',
  );
  if (!patched.includes('compileOnly files("libs/Wavewalletdk.aar")')) {
    throw new Error('Could not apply the Expo 54/AGP nested-AAR compatibility patch.');
  }
  if (patched !== gradle) await writeFile(gradlePath, patched);
  console.log(`Staged Android runtime: ${destination}`);
  console.log('Applied Android nested-AAR compatibility patch.');
}

async function stageIos() {
  const archive = await verifiedDownload(assets.ios);
  const extractRoot = join(CACHE_ROOT, 'xcframework');
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', extractRoot], { stdio: 'inherit' });

  const source = findDirectory(extractRoot, 'Wavewalletdk.xcframework');
  if (!source) throw new Error('Wavewalletdk.xcframework was not found in the release archive.');

  const destination = join(PACKAGE_ROOT, 'ios', 'Wavewalletdk.xcframework');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  const podspecPath = join(PACKAGE_ROOT, 'WavelengthReactNative.podspec');
  const podspec = await readFile(podspecPath, 'utf8');
  const desiredXcconfig = 's.pod_target_xcconfig = { "DEFINES_MODULE" => "YES", "CLANG_ENABLE_MODULES" => "YES", "OTHER_CPLUSPLUSFLAGS" => "$(inherited) -fcxx-modules" }';
  const patched = podspec
    .replace('s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }', desiredXcconfig)
    .replace('s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES", "CLANG_ENABLE_MODULES" => "YES" }', desiredXcconfig);
  if (!patched.includes('"OTHER_CPLUSPLUSFLAGS" => "$(inherited) -fcxx-modules"')) {
    throw new Error('Could not apply the Expo 54/Objective-C++ modules compatibility patch.');
  }
  if (patched !== podspec) await writeFile(podspecPath, patched);
  const modulePath = join(PACKAGE_ROOT, 'ios', 'WavelengthModule.mm');
  const moduleSource = await readFile(modulePath, 'utf8');
  const moduleIncludes = '#import <ReactCommon/RCTTurboModule.h>\n#import <jsi/jsi.h>\n';
  const patchedModule = moduleSource.includes(moduleIncludes)
    ? moduleSource
    : moduleSource.replace('#import "WavelengthModule.h"\n', `#import "WavelengthModule.h"\n\n${moduleIncludes}`);
  if (!patchedModule.includes(moduleIncludes)) {
    throw new Error('Could not apply the React Native 0.81 TurboModule header compatibility patch.');
  }
  if (patchedModule !== moduleSource) await writeFile(modulePath, patchedModule);
  console.log(`Staged iOS runtime: ${destination}`);
  console.log('Applied iOS Objective-C++ modules and RN 0.81 header compatibility patches.');
}

if (!existsSync(PACKAGE_ROOT)) {
  throw new Error('Install dependencies before staging native Wavelength runtimes.');
}

const requested = process.argv[2] ?? 'all';
if (!['android', 'ios', 'all'].includes(requested)) {
  throw new Error('Usage: stage-wavelength-native.mjs [android|ios|all]');
}

if (requested === 'android' || requested === 'all') await stageAndroid();
if (requested === 'ios' || requested === 'all') await stageIos();
