/** LaunchServices dev launcher and speech-helper privacy manifest tests. */
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  devLauncherEnvironment,
  devLauncherInfoPlist,
  PIXIES_DEV_BUNDLE_ID,
  writeDevLauncher,
} from '../scripts/launch-services.ts'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pixies-launch-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('devLauncherInfoPlist', () => {
  it('declares both privacy usage strings and the Pixies bundle id', () => {
    const plist = devLauncherInfoPlist()
    expect(plist).toContain(`<string>${PIXIES_DEV_BUNDLE_ID}</string>`)
    expect(plist).toContain('<key>NSSpeechRecognitionUsageDescription</key>')
    expect(plist).toContain('<key>NSMicrophoneUsageDescription</key>')
    expect(plist).toContain('<key>CFBundleExecutable</key>')
  })
})

describe('devLauncherEnvironment', () => {
  it('serializes defined variables as JSON with one trailing newline', () => {
    const json = devLauncherEnvironment({ DSH_HOME: '/tmp/home', OPTIONAL: undefined, WITH_QUOTE: "it's" })
    expect(JSON.parse(json)).toEqual({ DSH_HOME: '/tmp/home', WITH_QUOTE: "it's" })
    expect(json.endsWith('\n')).toBe(true)
    expect(json).not.toContain('OPTIONAL')
  })
})

describe('writeDevLauncher', () => {
  it('links the Electron binary as the bundle executable and writes the dev environment', () => {
    const directory = temporaryDirectory()
    const paths = writeDevLauncher(
      directory,
      '/Applications/Electron',
      { DSH_HOME: '/tmp/home' },
      () => undefined,
    )
    expect(paths.app).toBe(join(directory, 'PixiesDev.app'))
    expect(paths.log).toBe(join(directory, 'electron.log'))
    expect(paths.envFile).toBe(join(directory, 'dev-env.json'))
    expect(readFileSync(join(paths.app, 'Contents', 'Info.plist'), 'utf8'))
      .toContain('NSSpeechRecognitionUsageDescription')
    expect(readFileSync(join(paths.app, 'Contents', 'PkgInfo'), 'utf8')).toBe('APPL????')
    // A shell-script executable makes LaunchServices withhold the NSStatusItem,
    // so the bundle must link the real Electron binary instead.
    expect(readlinkSync(join(paths.app, 'Contents', 'MacOS', 'launcher'))).toBe('/Applications/Electron')
    expect(JSON.parse(readFileSync(paths.envFile, 'utf8'))).toEqual({ DSH_HOME: '/tmp/home' })
    expect(readFileSync(paths.log, 'utf8')).toBe('')
  })

  it('still produces a usable bundle when ad-hoc signing fails', () => {
    const directory = temporaryDirectory()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const paths = writeDevLauncher(
      directory,
      '/Applications/Electron',
      {},
      () => 'no identity',
    )
    expect(readlinkSync(join(paths.app, 'Contents', 'MacOS', 'launcher'))).toBe('/Applications/Electron')
    expect(stderr).toHaveBeenCalledWith('pixies development: launcher ad-hoc signing skipped (no identity)\n')
  })
})

describe('speech helper Info.plist', () => {
  it('is embedded in the binary and declares both TCC usage strings', () => {
    const plist = readFileSync(fileURLToPath(new URL('../speech/Info.plist', import.meta.url)), 'utf8')
    expect(plist).toContain('<key>NSSpeechRecognitionUsageDescription</key>')
    expect(plist).toContain('<key>NSMicrophoneUsageDescription</key>')
    expect(plist).toContain('ai.deepseek.dsh.pixies-speech')
  })
})
