/**
 * The config plugin that shrinks the Android build.
 *
 * Gradle itself cannot be run in every environment, so these tests pin the
 * things that have actually broken the build: the AGP 8 property syntax, and
 * the ONNX Runtime keep rules without which a shrunk release build loads a
 * model and dies.
 */
const plugin = require('../../plugins/withAndroidReleaseSize.js') as {
  addAbiSplits: (contents: string) => string;
  PROGUARD_RULES: string;
  GRADLE_PROPERTIES: Array<[string, string]>;
};

const GENERATED = `apply plugin: "com.android.application"

android {
    ndkVersion rootProject.ext.ndkVersion
    compileSdk rootProject.ext.compileSdkVersion
}
`;

describe('addAbiSplits', () => {
  it('inserts a splits block into the android block', () => {
    const result = plugin.addAbiSplits(GENERATED);
    expect(result).toContain('splits {');
    expect(result).toContain('abi {');
    // The original contents survive.
    expect(result).toContain('ndkVersion rootProject.ext.ndkVersion');
  });

  it('assigns enable and universalApk rather than calling them', () => {
    // AGP 8 removed AbiSplitOptions.enable(boolean). The method form that
    // React Native's own template still uses fails with
    // "Could not find method enable() for arguments [true]".
    const result = plugin.addAbiSplits(GENERATED);
    expect(result).toMatch(/enable\s*=/);
    expect(result).toMatch(/universalApk\s*=/);
    expect(result).not.toMatch(/enable\s+\(/);
    expect(result).not.toMatch(/universalApk\s+\(/);
  });

  it('honours reactNativeArchitectures so one ABI can be built alone', () => {
    expect(plugin.addAbiSplits(GENERATED)).toContain("findProperty('reactNativeArchitectures')");
  });

  it('is idempotent — running prebuild twice must not double the block', () => {
    const once = plugin.addAbiSplits(GENERATED);
    expect(plugin.addAbiSplits(once)).toBe(once);
    expect(once.match(/splits \{/g)).toHaveLength(1);
  });

  it('fails loudly if the generated file stops looking as expected', () => {
    expect(() => plugin.addAbiSplits('// no android block here\n')).toThrow(/android \{/);
  });
});

describe('proguard rules', () => {
  it('keeps the ONNX Runtime classes its JNI library resolves by name', () => {
    expect(plugin.PROGUARD_RULES).toContain('-keep class ai.onnxruntime.** { *; }');
  });
});

describe('gradle properties', () => {
  it('turns on minification and resource shrinking for release builds', () => {
    const properties = new Map(plugin.GRADLE_PROPERTIES);
    expect(properties.get('android.enableMinifyInReleaseBuilds')).toBe('true');
    expect(properties.get('android.enableShrinkResourcesInReleaseBuilds')).toBe('true');
  });
});
