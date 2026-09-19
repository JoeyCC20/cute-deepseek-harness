/**
 * Ensure the Electron bundle may request speech recognition on macOS:
 * `SFSpeechRecognizer.requestAuthorization` crashes when the responsible
 * app's Info.plist lacks `NSSpeechRecognitionUsageDescription`, and Electron
 * ships only the microphone key. Idempotent; re-signs ad-hoc after patching
 * so the (now modified) bundle keeps a valid signature.
 */

import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

export function ensureElectronSpeechPermission(electronExecutable: string): void {
  if (process.platform !== 'darwin') return
  const app = resolve(electronExecutable, '..', '..', '..')
  const plist = join(app, 'Contents', 'Info.plist')
  const key = 'NSSpeechRecognitionUsageDescription'
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { stdio: 'pipe' })
    return // Already patched.
  } catch {
    // Key missing — fall through and add it.
  }
  try {
    execFileSync('/usr/libexec/PlistBuddy', [
      '-c',
      `Add :${key} string "Pixies uses speech recognition to turn your voice into prompts."`,
      plist,
    ], { stdio: 'pipe' })
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' })
    console.log('pixies: patched Electron.app with NSSpeechRecognitionUsageDescription')
  } catch (error) {
    console.warn(`pixies: could not patch Electron.app speech permission: ${
      error instanceof Error ? error.message : String(error)
    }`)
  }
}
