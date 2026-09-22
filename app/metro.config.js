// ONNX models and index packs ship as binary assets, not source.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts = [...config.resolver.assetExts, 'onnx', 'bin', 'ids'];

// DIAGNOSTIC: resolve onnxruntime-react-native to a stub so the native module
// can be removed from the build entirely. Revert with the branch.
const path = require('path');
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  'onnxruntime-react-native': path.resolve(__dirname, 'stubs/onnxruntime-react-native.ts'),
};

module.exports = config;
