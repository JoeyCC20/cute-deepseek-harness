/**
 * Launch the development Electron through LaunchServices so macOS TCC
 * attributes privacy prompts to Pixies instead of the IDE or terminal that
 * started the launcher. A direct `spawn` inherits the parent's responsible
 * process; when that app has no NSSpeechRecognitionUsageDescription in its
 * Info.plist, SFSpeechRecognizer.requestAuthorization aborts the speech helper
 * before it can emit a single NDJSON event.
 * @module @deepseek-ai/dsh-pixies-app/launch-services
 */

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bundle id that owns the dev app's microphone and speech-recognition grants. */
export const PIXIES_DEV_BUNDLE_ID = 'ai.deepseek.dsh.pixies-dev'

/** Quote one POSIX shell word; embedded single quotes are re-opened safely. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

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
 * Render the launcher script. `exec` keeps the Electron pid as the app pid so
 * `open -W` waits for the real shell, and `env` reconstructs the development
 * environment that LaunchServices does not inherit from the calling shell.
 * @param executable - Electron binary path.
 * @param args - Electron command-line arguments.
 * @param environment - development environment to reproduce.
 * @param logFile - file receiving Electron stdout/stderr.
 * @param cwd - working directory a direct `spawn` would have used.
 * @returns the shell script body, including a trailing newline.
 */
export function devLauncherScript(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  logFile: string,
  cwd: string,
): string {
  const assignments = Object.entries(environment)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => shellQuote(`${key}=${value}`))
  const words = [shellQuote(executable), ...args.map(shellQuote)].join(' ')
  return [
    '#!/bin/sh',
    `cd ${shellQuote(cwd)} || exit 1`,
    `exec env ${assignments.join(' ')} ${words} >> ${shellQuote(logFile)} 2>&1`,
    '',
  ].join('\n')
}

/** Paths produced by {@link writeDevLauncher}. */
export interface DevLauncherPaths {
  /** The `.app` bundle to hand to `open -a`. */
  readonly app: string
  /** The log file Electron writes to. */
  readonly log: string
}

/** Ad-hoc sign callback; injectable so unit tests never invoke `codesign`. */
export type DevLauncherSigner = (app: string) => string | undefined

function codesign(app: string): string | undefined {
  const result = spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], { encoding: 'utf8' })
  return result.status === 0 ? undefined : (result.stderr || 'codesign failed').trim()
}

/**
 * Write (and re-sign) the disposable launcher bundle. Rewriting every launch
 * keeps the environment and arguments current.
 * @param directory - parent directory for the bundle and log file.
 * @param executable - Electron binary path.
 * @param args - Electron command-line arguments.
 * @param environment - development environment to reproduce.
 * @param cwd - working directory a direct `spawn` would have used.
 * @param sign - optional signer override for tests.
 * @returns the bundle and log paths.
 */
export function writeDevLauncher(
  directory: string,
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  sign: DevLauncherSigner = codesign,
): DevLauncherPaths {
  const app = join(directory, 'PixiesDev.app')
  const macos = join(app, 'Contents', 'MacOS')
  mkdirSync(macos, { recursive: true })
  const log = join(directory, 'electron.log')
  writeFileSync(join(app, 'Contents', 'Info.plist'), devLauncherInfoPlist())
  writeFileSync(join(app, 'Contents', 'PkgInfo'), 'APPL????')
  const launcher = join(macos, 'launcher')
  writeFileSync(launcher, devLauncherScript(executable, args, environment, log, cwd))
  chmodSync(launcher, 0o755)
  writeFileSync(log, '')
  const failure = sign(app)
  if (failure !== undefined) throw new Error(`pixies development: launcher codesign failed: ${failure}`)
  return { app, log }
}

/**
 * Start the launcher bundle and stream its log until Electron exits.
 * @param app - launcher bundle path.
 * @param log - Electron log file path.
 */
export async function launchViaLaunchServices(app: string, log: string): Promise<void> {
  const tail = spawn('tail', ['-f', log], { stdio: ['ignore', 'inherit', 'inherit'] })
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn('open', ['-W', '-n', '-a', app], { stdio: 'inherit' })
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
