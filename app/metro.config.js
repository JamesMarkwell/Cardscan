// ONNX models and index packs ship as binary assets, not source.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts = [...config.resolver.assetExts, 'onnx', 'bin', 'ids'];

module.exports = config;
