import type { ConfigContext, ExpoConfig } from 'expo/config';

const APP_VERSION = '0.1.0';
const DEMO_RP_ID = 'wavelength.lightning.engineering';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Wavelength Kitchen Sink',
  slug: 'wavelength-rn-kitchensink',
  version: APP_VERSION,
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  runtimeVersion: APP_VERSION,
  ios: {
    bundleIdentifier: 'engineering.lightning.wavelength.demo',
    supportsTablet: false,
    associatedDomains: [`webcredentials:${DEMO_RP_ID}`],
    config: {
      usesNonExemptEncryption: false,
    },
  },
  android: {
    package: 'engineering.lightning.wavelength.demo',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    './plugins/withAssetStatements',
    './plugins/withWavelengthAndroidAar',
    './plugins/withReactNativeArchitectures',
    './plugins/withFmtCpp17',
    'expo-font',
    [
      'expo-build-properties',
      {
        android: {
          targetSdkVersion: 36,
          minSdkVersion: 24,
          enableProguardInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
        },
        ios: {
          deploymentTarget: '15.2',
        },
      },
    ],
  ],
  experiments: {
    reactCompiler: true,
  },
  extra: {
    architectureLock: {
      source: 'Kesh apps/mobile/package.json + app.config.ts',
      expo: '54.0.25',
      react: '19.1.0',
      reactNative: '0.81.5',
      newArchitecture: true,
      iosDeploymentTarget: '15.2',
      androidTargetSdk: 36,
      androidMinSdk: 24,
      wavelength: '0.1.0',
    },
  },
});
