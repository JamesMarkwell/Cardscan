// react-native-worklets' Babel plugin rewrites `'worklet'` functions (the
// vision-camera frame processor runs as one) so they can execute on the
// Camera's frame thread. It must be listed last.
module.exports = function babel(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
