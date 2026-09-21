/**
 * Expo config plugin: per-ABI APKs and a shrunk release build.
 *
 * A debug APK carrying every architecture is ~122 MB, most of it ONNX Runtime's
 * native libraries repeated four times. A phone only ever loads the one matching
 * its own CPU, so splitting per ABI cuts roughly three quarters of that, and R8
 * plus resource shrinking takes more off the release build.
 *
 * This lives as a plugin rather than an edit to `android/` because that folder is
 * generated: `expo prebuild` would throw the edit away on the next run.
 */
const fs = require('fs');
const path = require('path');
const { withAppBuildGradle, withDangerousMod, withGradleProperties } = require('expo/config-plugins');

const DEFAULT_ABIS = 'armeabi-v7a,arm64-v8a,x86,x86_64';

const SPLITS_BLOCK = `
    // Added by plugins/withAndroidReleaseSize.js
    // One APK per architecture instead of one carrying all four. Override with
    // -PreactNativeArchitectures=arm64-v8a to build a single ABI, or
    // -Pandroid.enableAbiSplits=false to go back to one fat APK.
    splits {
        abi {
            reset()
            // Property assignment, not the method form: AGP 8 dropped
            // AbiSplitOptions.enable(boolean), so the bare "enable true" that
            // React Native's own template still uses fails with
            // "Could not find method enable() for arguments [true]".
            enable = (findProperty('android.enableAbiSplits') ?: 'true').toBoolean()
            universalApk = (findProperty('android.buildUniversalApk') ?: 'false').toBoolean()
            include(*((findProperty('reactNativeArchitectures') ?: '${DEFAULT_ABIS}').split(',')))
        }
    }
`;

/**
 * R8 keep rules.
 *
 * ONNX Runtime's JNI library looks its Java classes up by name at runtime -- the
 * paths "ai/onnxruntime/OnnxTensor", "ai/onnxruntime/OrtException" and friends
 * appear as literal strings inside libonnxruntime4j_jni.so. The AAR's own
 * consumer rules only keep its telemetry classes, so without these the release
 * build compiles cleanly and then dies the first time a model is loaded.
 */
const PROGUARD_RULES = `
# Added by plugins/withAndroidReleaseSize.js
-keep class ai.onnxruntime.** { *; }
-dontwarn ai.onnxruntime.**
`;

/** Gradle properties the generated build.gradle already reads. */
const PROPERTIES = [
  ['android.enableMinifyInReleaseBuilds', 'true'],
  ['android.enableShrinkResourcesInReleaseBuilds', 'true'],
];

function setProperty(properties, key, value) {
  const existing = properties.find((item) => item.type === 'property' && item.key === key);
  if (existing) {
    existing.value = value;
    return properties;
  }
  return [...properties, { type: 'property', key, value }];
}

/**
 * Insert the splits block into a generated app/build.gradle. Pure and
 * idempotent so it can be tested without running prebuild.
 */
function addAbiSplits(contents) {
  if (contents.includes('android.enableAbiSplits')) {
    return contents;
  }

  // Anchor on the start of the android block so the insert survives changes
  // elsewhere in the generated file.
  const anchor = /^android \{$/m;
  if (!anchor.test(contents)) {
    throw new Error(
      'withAndroidReleaseSize: could not find the `android {` block in app/build.gradle',
    );
  }

  return contents.replace(anchor, `android {\n${SPLITS_BLOCK}`);
}

const withAndroidReleaseSize = (config) => {
  config = withGradleProperties(config, (gradleConfig) => {
    for (const [key, value] of PROPERTIES) {
      gradleConfig.modResults = setProperty(gradleConfig.modResults, key, value);
    }
    return gradleConfig;
  });

  config = withDangerousMod(config, [
    'android',
    async (dangerousConfig) => {
      const rulesPath = path.join(
        dangerousConfig.modRequest.platformProjectRoot,
        'app',
        'proguard-rules.pro',
      );
      const existing = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8') : '';
      if (!existing.includes('ai.onnxruntime')) {
        fs.writeFileSync(rulesPath, `${existing.trimEnd()}\n${PROGUARD_RULES}`);
      }
      return dangerousConfig;
    },
  ]);

  return withAppBuildGradle(config, (gradleConfig) => {
    gradleConfig.modResults.contents = addAbiSplits(gradleConfig.modResults.contents);
    return gradleConfig;
  });
};

module.exports = withAndroidReleaseSize;
module.exports.addAbiSplits = addAbiSplits;
module.exports.PROGUARD_RULES = PROGUARD_RULES;
module.exports.GRADLE_PROPERTIES = PROPERTIES;
