/** Build and launch the unpackaged Pixies tray shell against the current workspace. */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ensureElectronSpeechPermission } from './electron-speech-permission.ts'
import { APP_ROOT, preparePixiesProject, REPOSITORY_ROOT } from './stage.ts'

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
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    DSH_DESKTOP_DEV_PROJECT_DIR: projectDir,
    DSH_DESKTOP_HOST_INSPECT_PORT: String(hostPort),
    DSH_DESKTOP_NODE_BINARY: process.execPath,
    DSH_PIXIES_OPEN_DEVTOOLS: process.env.DSH_PIXIES_OPEN_DEVTOOLS ?? '1',
    ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
  }
  console.log(`pixies development: DSH_HOME=${home}`)
  console.log(`pixies development: inspectors main=${String(mainPort)}, renderer=${String(rendererPort)}, host=${String(hostPort)}`)
  await run(electron, [
    `--inspect=127.0.0.1:${String(mainPort)}`,
    `--remote-debugging-port=${String(rendererPort)}`,
    `--user-data-dir=${userData}`,
    APP_ROOT,
  ], APP_ROOT, environment)
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'skip-build': { type: 'boolean', default: false } } })
  if (!values['skip-build']) {
    await runPackageScript('build', REPOSITORY_ROOT)
    await runPackageScript('build', APP_ROOT)
  }
  const projectDir = preparePixiesProject(join(DEVELOPMENT_ROOT, 'project'))
  await launchElectron(projectDir)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
