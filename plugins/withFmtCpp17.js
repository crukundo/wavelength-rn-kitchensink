const { withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

// Match Kesh's temporary Xcode 26.x compatibility patch. Only fmt is forced
// to C++17; React Native core remains on C++20.
const BEGIN_MARKER = '# BEGIN: fmt C++17 workaround (Xcode 26.x)';
const END_MARKER = '# END: fmt C++17 workaround';
const SNIPPET = `
    ${BEGIN_MARKER}
    installer.pods_project.targets.each do |target|
      if target.name == 'fmt'
        target.build_configurations.each do |bc|
          bc.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
        end
      end
    end
    ${END_MARKER}
`;
const ANCHOR = /react_native_post_install\([\s\S]*?\)\n/;

module.exports = function withFmtCpp17(config) {
  return withDangerousMod(config, [
    'ios',
    async (result) => {
      const podfilePath = path.join(result.modRequest.platformProjectRoot, 'Podfile');
      const contents = fs.readFileSync(podfilePath, 'utf8');
      if (contents.includes(BEGIN_MARKER)) return result;
      if (!ANCHOR.test(contents)) {
        throw new Error('[withFmtCpp17] could not locate react_native_post_install(...) in ios/Podfile');
      }
      fs.writeFileSync(podfilePath, contents.replace(ANCHOR, (match) => `${match}${SNIPPET}`));
      return result;
    },
  ]);
};
