/** Shared project staging for the dev launcher and the macOS packager. */

import { createRequire } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
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
 * The Host resolves its Office skill assets beside the project directory
 * (`<dirname(projectDir)>/office-skills`) and fails startup when the checker
 * script is missing. A reused development project (or a partial clean) can
 * leave that sibling directory behind, so restore it from the workspace
 * assets before every launch. Copy-only: no destructive cleanup here.
 * @param developmentRoot - the directory holding `project` and its siblings.
 */
export function ensurePixiesOfficeSkills(developmentRoot: string): void {
  const target = join(developmentRoot, 'office-skills')
  if (existsSync(join(target, 'scripts', 'check_office.py'))) return
  const source = join(REPOSITORY_ROOT, 'packages', 'skill', 'skill-office', 'assets')
  if (!existsSync(source)) return
  mkdirSync(target, { recursive: true })
  cpSync(source, target, { recursive: true, dereference: true })
}

/**
 * Mirror pnpm's virtual-hoist links into a pixies-owned view, dropping links
 * whose target no longer exists. A partial install or a branch switch can leave
 * dangling links behind, and the Desktop Host stager resolves every link with
 * `realpathSync`, so a single stale entry aborts the whole launch. The view is
 * updated in place: replacing hundreds of links on every launch trips bulk
 * deletion guards, while unchanged links are simply reused.
 * @param sourceRoot - pnpm's `.pnpm/node_modules` directory.
 * @param viewRoot - persistent view owned by the pixies development tree.
 * @returns the view directory, safe to pass as `dependencyDir`.
 */
export function prepareDependencyView(sourceRoot: string, viewRoot: string): string {
  if (!existsSync(sourceRoot)) {
    throw new Error('pixies staging: workspace dependency links are missing; run pnpm install')
  }
  mkdirSync(viewRoot, { recursive: true })
  const wanted = new Set<string>()
  const mirror = (source: string, destination: string): void => {
    let target: string
    try {
      target = realpathSync(source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    wanted.add(destination)
    try {
      if (realpathSync(destination) === target) return
    } catch {
      // Missing or dangling: replace the single entry below.
    }
    mkdirSync(dirname(destination), { recursive: true })
    try {
      unlinkSync(destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir')
  }
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    const source = join(sourceRoot, entry.name)
    if (entry.name.startsWith('@') && (entry.isDirectory() || entry.isSymbolicLink())) {
      for (const scoped of readdirSync(source, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue
        mirror(join(source, scoped.name), join(viewRoot, entry.name, scoped.name))
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) mirror(source, join(viewRoot, entry.name))
  }
  pruneDependencyView(viewRoot, wanted)
  return viewRoot
}

/** Remove view entries that no longer correspond to a resolvable dependency. */
function pruneDependencyView(directory: string, wanted: ReadonlySet<string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      pruneDependencyView(path, wanted)
      if (readdirSync(path).length === 0) rmdirSync(path)
      continue
    }
    if (!wanted.has(path)) unlinkSync(path)
  }
}

/**
 * Retire a previous disposable project instead of letting the Desktop Host
 * stager delete it with one recursive `rmSync`: its hundreds of dependency
 * links exceed the bulk-deletion threshold of hosted terminals. Moving the
 * tree to the OS temp directory is a rename, so the stager sees an absent
 * destination and creates a fresh project with no deletion at all.
 * @param projectDir - the project directory about to be re-staged.
 */
export function retireProjectDir(projectDir: string): void {
  if (!existsSync(projectDir)) return
  const retired = join(tmpdir(), `pixies-dev-project-${String(process.pid)}-${String(Date.now())}`)
  renameSync(projectDir, retired)
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
  retireProjectDir(projectDir)
  const project = prepareDevelopmentProject({
    projectDir,
    cliDir: join(REPOSITORY_ROOT, 'apps', 'cli'),
    hostDir: join(REPOSITORY_ROOT, 'apps', 'desktop-host'),
    dependencyDir: prepareDependencyView(
      join(REPOSITORY_ROOT, 'node_modules', '.pnpm', 'node_modules'),
      join(APP_ROOT, '.pixies-build', 'development', 'dependency-view'),
    ),
    release,
  })
  stagePixiesBundle(project)
  return project
}
