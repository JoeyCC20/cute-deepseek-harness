/** electron-builder config: Pixies macOS app (debug bundle, ad-hoc signed). */

export default {
  appId: 'io.deepseek-harness.pixies',
  productName: 'Pixies',
  asar: true,
  directories: { output: '.pixies-build/dist' },
  files: ['lib/**/*.js', 'lib/**/*.cjs', 'package.json', '!lib/pixies-speech'],
  // Resources (project/runtime/pixies-speech) are copied by scripts/package-mac.ts
  // after the build: electron-builder's extraResources copier silently drops
  // node_modules directories.
  mac: {
    identity: null,
    extendInfo: {
      LSUIElement: true,
      NSMicrophoneUsageDescription: 'Pixies uses the microphone to turn your voice into prompts.',
      NSSpeechRecognitionUsageDescription: 'Pixies uses speech recognition to turn your voice into prompts.',
    },
  },
}
