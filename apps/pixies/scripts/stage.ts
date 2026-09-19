/** Shared project staging for the dev launcher and the macOS packager. */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../desktop/src/host-protocol.ts'
import type { DesktopRelease } from '../../desktop/src/release.ts'
import { prepareDevelopmentProject } from '../../desktop/scripts/development-project.ts'

const SCRIPTS_ROOT = resolve(import.meta.dirname)
export const APP_ROOT = resolve(SCRIPTS_ROOT, '..')
export const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const PIXIES_PACKAGE = '@deepseek-ai/dsh-pixies'
const PIXIES_PACKAGE_DIR = join(REPOSITORY_ROOT, 'packages', 'extensions', 'pixies')

interface PackageManifest {
  readonly version?: string
}

function packageVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`pixies staging: ${subject} has no version`)
  }
  return manifest.version
}

/** The pixies app package version, used in release records and deployment stamps. */
export function pixiesAppVersion(): string {
  return packageVersion(join(APP_ROOT, 'package.json'), 'pixies package')
}

/** Link the pixies bundle into the staged project and register it as a profile bundle. */
export function stagePixiesBundle(projectDir: string): void {
  for (const artifact of ['lib/index.js', 'lib/client.js']) {
    const path = join(PIXIES_PACKAGE_DIR, artifact)
    if (!existsSync(path)) throw new Error(`pixies staging: missing built artifact ${path}`)
  }
  const link = join(projectDir, 'node_modules', '@deepseek-ai', 'dsh-pixies')
  try {
    unlinkSync(link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  symlinkSync(PIXIES_PACKAGE_DIR, link, process.platform === 'win32' ? 'junction' : 'dir')
  const manifestPath = join(projectDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh?: { profile?: { bundles?: readonly string[] } }
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (bundles === undefined) throw new Error('pixies staging: staged project has no dsh.profile.bundles')
  if (bundles.includes(PIXIES_PACKAGE)) return
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: [...bundles, PIXIES_PACKAGE] },
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Prepare the disposable npm-project view over the current workspace and
 * stage the pixies bundle into it. Used by `dev` and by the macOS packager.
 * @param projectDir - directory replaced with the generated project.
 * @returns the absolute project directory.
 */
export function preparePixiesProject(projectDir: string): string {
  for (const path of [
    join(APP_ROOT, 'lib', 'main.js'),
    join(REPOSITORY_ROOT, 'apps', 'desktop-host', 'lib', 'index.js'),
  ]) {
    if (!existsSync(path)) throw new Error(`pixies staging: missing built artifact ${path}`)
  }
  // pnpm is a workspace devDependency of apps/desktop; read its manifest beside its entry.
  const desktopRequire = createRequire(join(REPOSITORY_ROOT, 'apps', 'desktop', 'package.json'))
  const pnpmVersion = packageVersion(join(dirname(desktopRequire.resolve('pnpm')), 'package.json'), 'pnpm package')
  const release: DesktopRelease = {
    schemaVersion: 1,
    version: pixiesAppVersion(),
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: process.versions.node,
    pnpmVersion,
  }
  const project = prepareDevelopmentProject({
    projectDir,
    cliDir: join(REPOSITORY_ROOT, 'apps', 'cli'),
    hostDir: join(REPOSITORY_ROOT, 'apps', 'desktop-host'),
    dependencyDir: join(REPOSITORY_ROOT, 'node_modules', '.pnpm', 'node_modules'),
    release,
  })
  stagePixiesBundle(project)
  return project
}
