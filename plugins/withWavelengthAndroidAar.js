const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// Wavelength gomobile runtime (staged and checksum-verified by this harness).';
const DEPENDENCY = `    ${MARKER}\n    implementation files("${'${rootDir}'}/../node_modules/@lightninglabs/wavelength-react-native/android/libs/Wavewalletdk.aar")\n`;

module.exports = function withWavelengthAndroidAar(config) {
  return withAppBuildGradle(config, (result) => {
    if (result.modResults.language !== 'groovy') {
      throw new Error('withWavelengthAndroidAar only supports a Groovy app/build.gradle.');
    }

    if (!result.modResults.contents.includes(MARKER)) {
      result.modResults.contents = result.modResults.contents.replace(
        /dependencies \{\n/,
        `dependencies {\n${DEPENDENCY}`,
      );
    }

    return result;
  });
};
