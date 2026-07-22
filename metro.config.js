const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Match Kesh: this harness is intentionally native-only.
config.resolver.platforms = ['ios', 'android'];

module.exports = config;
