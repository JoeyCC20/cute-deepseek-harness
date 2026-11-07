/** Build and launch the unpackaged Pixies tray shell against the current workspace. */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ensureElectronSpeechPermission } from './electron-speech-permission.ts'
import { launchViaLaunchServices, writeDevLauncher } from './launch-services.ts'
import { APP_ROOT, ensurePixiesOfficeSkills, preparePixiesProject, REPOSITORY_ROOT } from './stage.ts'

const BUILD_ROOT = join(APP_ROOT, '.pixies-build')
const DEVELOPMENT_ROOT = join(BUILD_ROOT, 'development')

function debugPort(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`pixies development: ${name} must be an integer from 1 through 65535`)
  }
  return port
}

async function run(command: string, args: readonly string[], cwd: string, environment = process.env): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`pixies development: ${args.join(' ')} exited with ${String(code ?? signal)}`))
    })
  })
}

async function runPackageScript(script: string, cwd: string): Promise<void> {
  const packageManager = process.env.npm_execpath
  if (packageManager === undefined || packageManager === '') {
    throw new Error('pixies development: invoke this launcher through pnpm run dev:pixies or start:pixies')
  }
  await run(process.execPath, [packageManager, 'run', script], cwd)
}

async function launchElectron(projectDir: string): Promise<void> {
  const require = createRequire(import.meta.url)
  const electron: unknown = require('electron')
  if (typeof electron !== 'string') throw new Error('pixies development: electron executable is unavailable')
  ensureElectronSpeechPermission(electron)
  const mainPort = debugPort('DSH_PIXIES_MAIN_INSPECT_PORT', 9239)
  const rendererPort = debugPort('DSH_PIXIES_RENDERER_DEBUG_PORT', 9232)
  const hostPort = debugPort('DSH_DESKTOP_HOST_INSPECT_PORT', 9240)
  const home = resolve(process.env.DSH_HOME ?? join(DEVELOPMENT_ROOT, 'home'))
  const userData = join(DEVELOPMENT_ROOT, 'electron-user-data')
  const envFile = join(REPOSITORY_ROOT, '.env')
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    // A Finder launch has no shell environment; give the packaged-entry
    // credential injector the repository .env explicitly in development.
    ...(existsSync(envFile) ? { DSH_PIXIES_ENV_FILE: envFile } : {}),
    DSH_HOME: home,
    DSH_DESKTOP_DEV_PROJECT_DIR: projectDir,
    DSH_DESKTOP_HOST_INSPECT_PORT: String(hostPort),
    DSH_DESKTOP_NODE_BINARY: process.execPath,
    // DevTools used to open on every launch and covered the avatar. Opt in
    // explicitly with DSH_PIXIES_OPEN_DEVTOOLS=1 when debugging the renderer.
    DSH_PIXIES_OPEN_DEVTOOLS: process.env.DSH_PIXIES_OPEN_DEVTOOLS ?? '0',
    ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
  }
  console.log(`pixies development: DSH_HOME=${home}`)
  console.log(`pixies development: inspectors main=${String(mainPort)}, renderer=${String(rendererPort)}, host=${String(hostPort)}`)
  const args = [
    `--inspect=127.0.0.1:${String(mainPort)}`,
    `--remote-debugging-port=${String(rendererPort)}`,
    `--user-data-dir=${userData}`,
    APP_ROOT,
  ]
  // A direct spawn inherits the IDE/terminal as its TCC responsible process.
  // When that app lacks NSSpeechRecognitionUsageDescription, macOS aborts the
  // speech helper on its first authorization request. LaunchServices assigns
  // the prompts to our own bundle, which declares both usage strings.
  if (process.platform === 'darwin') {
    let launcher: ReturnType<typeof writeDevLauncher> | undefined
    try {
      launcher = writeDevLauncher(join(BUILD_ROOT, 'dev-launcher'), electron, args, environment, APP_ROOT)
    } catch (error) {
      console.warn(`pixies development: LaunchServices launcher unavailable (${error instanceof Error ? error.message : String(error)}); falling back to a direct launch`)
    }
    if (launcher !== undefined) {
      await launchViaLaunchServices(launcher.app, launcher.log)
      return
    }
  }
  await run(electron, args, APP_ROOT, environment)
}

/** True when the Swift helper is absent or older than its sources. */
function speechBinaryStale(): boolean {
  const binary = join(APP_ROOT, 'lib', 'pixies-speech')
  if (!existsSync(binary)) return true
  const built = statSync(binary).mtimeMs
  return [join(APP_ROOT, 'speech', 'PixiesSpeech.swift'), join(APP_ROOT, 'speech', 'Info.plist')]
    .some(source => existsSync(source) && statSync(source).mtimeMs > built)
}

/** The staged bundle entry that proves an existing project is still usable. */
function projectReady(projectDir: string): boolean {
  return existsSync(join(projectDir, 'package.json'))
    && existsSync(join(projectDir, 'node_modules', '@deepseek-ai', 'dsh-pixies', 'lib', 'client.js'))
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'skip-build': { type: 'boolean', default: false } } })
  const projectDir = join(DEVELOPMENT_ROOT, 'project')
  if (!values['skip-build']) {
    await runPackageScript('build', REPOSITORY_ROOT)
    await runPackageScript('build', APP_ROOT)
  }
  // `start` means "launch what is already built". Re-staging the disposable
  // project deletes thousands of files on every launch and is only needed
  // after a real `dev` build; DSH_PIXIES_REUSE_PROJECT opts a dev run into it.
  const reuse = values['skip-build'] === true || process.env.DSH_PIXIES_REUSE_PROJECT === '1'
  if (reuse && projectReady(projectDir)) {
    console.log(`pixies development: reusing prepared project ${projectDir}`)
  } else {
    preparePixiesProject(projectDir)
  }
  ensurePixiesOfficeSkills(DEVELOPMENT_ROOT)
  if (process.platform === 'darwin' && speechBinaryStale()) {
    try {
      await runPackageScript('build:speech', APP_ROOT)
    } catch (error) {
      console.warn(`pixies development: speech helper build failed (${error instanceof Error ? error.message : String(error)}); voice input will report the failure`)
    }
  }
  await launchElectron(projectDir)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
