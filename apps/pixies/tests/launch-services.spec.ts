/** LaunchServices dev launcher and speech-helper privacy manifest tests. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  devLauncherInfoPlist,
  devLauncherScript,
  PIXIES_DEV_BUNDLE_ID,
  shellQuote,
  writeDevLauncher,
} from '../scripts/launch-services.ts'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pixies-launch-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('shellQuote', () => {
  it('quotes spaces and re-opens embedded single quotes', () => {
    expect(shellQuote('')).toBe("''")
    expect(shellQuote('/tmp/a b')).toBe("'/tmp/a b'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
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

describe('devLauncherScript', () => {
  it('re-execs Electron with the environment, arguments, and a log file', () => {
    const script = devLauncherScript(
      '/Applications/Electron.app/Contents/MacOS/Electron',
      ['--user-data-dir=/tmp/pixies data', '/repo/apps/pixies'],
      { DSH_HOME: '/tmp/home', OPTIONAL: undefined, WITH_QUOTE: "it's" },
      '/tmp/pixies/electron.log',
      '/repo/apps/pixies',
    )
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain("cd '/repo/apps/pixies' || exit 1")
    expect(script).toContain('exec env ')
    expect(script).toContain("'DSH_HOME=/tmp/home'")
    expect(script).toContain("'WITH_QUOTE=it'\\''s'")
    expect(script).not.toContain('OPTIONAL')
    expect(script).toContain("'--user-data-dir=/tmp/pixies data'")
    expect(script).toContain("'/repo/apps/pixies'")
    expect(script).toContain(">> '/tmp/pixies/electron.log' 2>&1")
    expect(script.endsWith('\n')).toBe(true)
  })
})

describe('writeDevLauncher', () => {
  it('writes a signed, executable bundle and truncates the log', () => {
    const directory = temporaryDirectory()
    const paths = writeDevLauncher(
      directory,
      '/Applications/Electron',
      ['--inspect=9239'],
      { DSH_HOME: '/tmp/home' },
      '/repo/apps/pixies',
      () => undefined,
    )
    expect(paths.app).toBe(join(directory, 'PixiesDev.app'))
    expect(paths.log).toBe(join(directory, 'electron.log'))
    expect(readFileSync(join(paths.app, 'Contents', 'Info.plist'), 'utf8'))
      .toContain('NSSpeechRecognitionUsageDescription')
    expect(readFileSync(join(paths.app, 'Contents', 'PkgInfo'), 'utf8')).toBe('APPL????')
    const launcher = join(paths.app, 'Contents', 'MacOS', 'launcher')
    expect(readFileSync(launcher, 'utf8')).toContain("'DSH_HOME=/tmp/home'")
    expect(statSync(launcher).mode & 0o111).not.toBe(0)
    expect(readFileSync(paths.log, 'utf8')).toBe('')
  })

  it('fails loud when the bundle cannot be signed', () => {
    const directory = temporaryDirectory()
    expect(() => writeDevLauncher(directory, '/Applications/Electron', [], {}, '/repo/apps/pixies', () => 'no identity'))
      .toThrow('launcher codesign failed: no identity')
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
