/**
 * Launch the development Electron through LaunchServices so macOS TCC
 * attributes privacy prompts to Pixies instead of the IDE or terminal that
 * started the launcher. A direct `spawn` inherits the parent's responsible
 * process; when that app has no NSSpeechRecognitionUsageDescription in its
 * Info.plist, SFSpeechRecognizer.requestAuthorization aborts the speech helper
 * before it can emit a single NDJSON event.
 *
 * The bundle executable is a symlink to the Electron binary itself.
 * LaunchServices does not attach an NSStatusItem to a process whose
 * CFBundleExecutable is a shell script, so a launcher that `exec`s Electron
 * leaves the menu-bar tray invisible. The environment and log redirection a
 * script used to provide now travel as `--pixies-dev-env` / `--pixies-dev-log`
 * arguments and are applied by the pre-boot shim.
 * @module @deepseek-ai/dsh-pixies-app/launch-services
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bundle id that owns the dev app's microphone and speech-recognition grants. */
export const PIXIES_DEV_BUNDLE_ID = 'ai.deepseek.dsh.pixies-dev'

/** Info.plist for the launcher bundle; it must own both privacy usage strings. */
export function devLauncherInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIdentifier</key>
  <string>${PIXIES_DEV_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>Pixies Development</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Pixies uses speech recognition to turn your voice into prompts.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Pixies uses the microphone to turn your voice into prompts.</string>
</dict>
</plist>
`
}

/**
 * Serialize the development environment for the pre-boot shim. LaunchServices
 * does not pass the calling shell's environment to a GUI app, so the shim
 * restores it from this file before any dsh provider is constructed.
 * @param environment - development environment to reproduce.
 * @returns JSON with exactly one trailing newline.
 */
export function devLauncherEnvironment(environment: NodeJS.ProcessEnv): string {
  const defined = Object.entries(environment)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return `${JSON.stringify(Object.fromEntries(defined), undefined, 2)}\n`
}

/** Paths produced by {@link writeDevLauncher}. */
export interface DevLauncherPaths {
  /** The `.app` bundle to hand to `open -a`. */
  readonly app: string
  /** The log file the pre-boot shim tees stdout/stderr into. */
  readonly log: string
  /** JSON file holding the development environment. */
  readonly envFile: string
}

/** Ad-hoc sign callback; injectable so unit tests never invoke `codesign`. */
export type DevLauncherSigner = (app: string) => string | undefined

function codesign(app: string): string | undefined {
  const result = spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], { encoding: 'utf8' })
  return result.status === 0 ? undefined : (result.stderr || 'codesign failed').trim()
}

/**
 * Write the disposable launcher bundle. Its executable is a symlink to the
 * Electron binary: codesign cannot sign a bundle whose main executable is a
 * symlink, but LaunchServices still launches it, so a failed signature is a
 * warning rather than a launch blocker.
 * @param directory - parent directory for the bundle, environment, and log.
 * @param executable - Electron binary path.
 * @param environment - development environment to reproduce.
 * @param sign - optional signer override for tests.
 * @returns the bundle, log, and environment paths.
 */
export function writeDevLauncher(
  directory: string,
  executable: string,
  environment: NodeJS.ProcessEnv,
  sign: DevLauncherSigner = codesign,
): DevLauncherPaths {
  const app = join(directory, 'PixiesDev.app')
  const macos = join(app, 'Contents', 'MacOS')
  mkdirSync(macos, { recursive: true })
  const log = join(directory, 'electron.log')
  const envFile = join(directory, 'dev-env.json')
  writeFileSync(join(app, 'Contents', 'Info.plist'), devLauncherInfoPlist())
  writeFileSync(join(app, 'Contents', 'PkgInfo'), 'APPL????')
  const launcher = join(macos, 'launcher')
  rmSync(launcher, { force: true })
  symlinkSync(executable, launcher)
  writeFileSync(envFile, devLauncherEnvironment(environment))
  writeFileSync(log, '')
  const failure = sign(app)
  if (failure !== undefined) {
    process.stderr.write(`pixies development: launcher ad-hoc signing skipped (${failure})\n`)
  }
  return { app, log, envFile }
}

/**
 * Start the launcher bundle and stream its log until Electron exits.
 * @param app - launcher bundle path.
 * @param log - file the shim tees Electron's output into.
 * @param args - Electron command-line arguments, including the shim flags.
 */
export async function launchViaLaunchServices(
  app: string,
  log: string,
  args: readonly string[],
): Promise<void> {
  const tail = spawn('tail', ['-f', log], { stdio: ['ignore', 'inherit', 'inherit'] })
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn('open', ['-W', '-n', '-a', app, '--args', ...args], { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code === 0) resolvePromise()
        else reject(new Error(`pixies development: open exited with ${String(code ?? signal)}`))
      })
    })
  } finally {
    tail.kill()
  }
}
