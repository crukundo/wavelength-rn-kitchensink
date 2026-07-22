const { withGradleProperties } = require('expo/config-plugins');

// Match Kesh production builds: physical-device ABIs only. Android App
// Bundles split these at delivery; emulator x86 ABIs add no production value.
const ARCHITECTURES = 'arm64-v8a,armeabi-v7a';

module.exports = function withReactNativeArchitectures(config) {
  return withGradleProperties(config, (result) => {
    const existing = result.modResults.find(
      (item) => item.type === 'property' && item.key === 'reactNativeArchitectures',
    );

    if (existing) {
      existing.value = ARCHITECTURES;
    } else {
      result.modResults.push({
        type: 'property',
        key: 'reactNativeArchitectures',
        value: ARCHITECTURES,
      });
    }

    return result;
  });
};
