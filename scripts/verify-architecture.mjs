import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const expected = {
  expo: '54.0.25',
  react: '19.1.0',
  'react-native': '0.81.5',
  '@lightninglabs/wavelength-react': '0.1.0',
  '@lightninglabs/wavelength-react-native': '0.1.0',
};

for (const [name, version] of Object.entries(expected)) {
  if (pkg.dependencies[name] !== version) {
    throw new Error(`${name} must remain pinned to ${version}; found ${pkg.dependencies[name]}`);
  }
}
if (pkg.packageManager !== 'bun@1.3.12') throw new Error('Bun must remain pinned to 1.3.12.');

const raw = execFileSync('npx', ['expo', 'config', '--type', 'public', '--json'], {
  cwd: root,
  encoding: 'utf8',
});
const config = JSON.parse(raw);
if (config.newArchEnabled !== true) throw new Error('Expo New Architecture must remain enabled.');

const buildProperties = config.plugins?.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties');
const android = buildProperties?.[1]?.android;
const ios = buildProperties?.[1]?.ios;
if (android?.targetSdkVersion !== 36 || android?.minSdkVersion !== 24) {
  throw new Error('Android SDK lock must remain minSdk 24 / targetSdk 36.');
}
if (ios?.deploymentTarget !== '15.2') throw new Error('iOS deployment target must remain 15.2.');

console.log('Architecture lock verified: Expo 54.0.25, RN 0.81.5, React 19.1.0, New Architecture.');
