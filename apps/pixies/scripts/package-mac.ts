/** Package the Pixies macOS app bundle (local debug build, unsigned). */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../desktop/src/host-protocol.ts'
import { parseDesktopCorePackageSet, type DesktopCorePackageRecord } from '../../desktop/src/core-package-set.ts'
import { APP_ROOT, REPOSITORY_ROOT, pixiesAppVersion } from './stage.ts'

const BUILD_ROOT = join(APP_ROOT, '.pixies-build')
const PACKED_ROOT = join(BUILD_ROOT, 'packed')
const STAGE_ROOT = join(BUILD_ROOT, 'packaging-stage')
const DIST_ROOT = join(BUILD_ROOT, 'dist')

const PIXIES_PACKAGE = '@deepseek-ai/dsh-pixies'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const DESKTOP_HOST_PACKAGE = '@deepseek-ai/dsh-desktop-host'
const BUNDLE_ROOTS = [DSH_PACKAGE, DESKTOP_HOST_PACKAGE, PIXIES_PACKAGE] as const
/** Mirrors apps/desktop DESKTOP_PROFILE_BUNDLES + the pixies plugin. */
const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PIXIES_PACKAGE] as const
/** Mirrors apps/desktop project-manager.ts seed metadata (createSeedMetadata). */
const PROJECT_NAME = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n'
const HOST_RUNTIME_FILES = ['lib/index.js'] as const

interface PackedPackage {
  readonly tarball: string
  readonly manifest: Record<string, unknown>
}

function run(command: string, args: readonly string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

function findApp(dir: string, depth = 0): string {
  if (depth > 3) throw new Error('pixies packaging: Pixies.app not found in dist output')
  const appPath = join(dir, 'Pixies.app')
  if (existsSync(appPath)) return appPath
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const found = findApp(join(dir, entry.name), depth + 1)
    if (found !== '') return found
  }
  return ''
}

function dependencyNames(manifest: Record<string, unknown>, section: string): string[] {
  const value = manifest[section]
  if (value === undefined) return []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`pixies packaging: ${String(manifest.name)} has invalid ${section}`)
  }
  return Object.keys(value).sort()
}

/** Aggregate the packed first-party tarball directories by package name. */
function packedPackages(inputs: readonly string[]): Map<string, PackedPackage> {
  const available = new Map<string, PackedPackage>()
  for (const input of inputs) {
    for (const file of readdirSync(input).filter(name => name.endsWith('.tgz')).sort()) {
      const tarball = join(input, file)
      const manifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json']).toString('utf8')) as Record<string, unknown>
      const name = manifest.name
      if (typeof name !== 'string' || name === '') throw new Error(`pixies packaging: ${tarball} has no package name`)
      if (available.has(name)) continue
      available.set(name, { tarball, manifest })
    }
  }
  return available
}

/** Walk the first-party dependency closure from the pixies bundle roots. */
function selectClosure(available: ReadonlyMap<string, PackedPackage>): PackedPackage[] {
  const selected = new Map<string, PackedPackage>()
  const visit = (name: string): void => {
    if (selected.has(name)) return
    const packed = available.get(name)
    if (packed === undefined) throw new Error(`pixies packaging: packed inputs omit required package ${name}`)
    selected.set(name, packed)
    for (const section of ['dependencies', 'peerDependencies'] as const) {
      for (const dependency of dependencyNames(packed.manifest, section)) {
        if (available.has(dependency)) {
          visit(dependency)
          continue
        }
        // LibreOffice-kit is a runtime-loaded optional native engine for the
        // dsh document preview; the tray shell never invokes office-to-pdf,
        // so the engine packages are out of scope for the pixies closure
        // and are satisfied at host install instead.
        if (dependency === '@deepseek-ai/libreoffice-kit' || dependency.startsWith('@deepseek-ai/libreoffice-kit-')) continue
        if (dependency.startsWith('@deepseek-ai/')) {
          // An unpacked internal package means a first-party dep was missing
          // from the closure (likely because release:pack only covers the
          // families explicitly listed). That is a real packaging bug —
          // refuse rather than silently dropping the dep.
          throw new Error(`pixies packaging: ${name} requires unpacked internal package ${dependency}`)
        }
        // Other non-workspace npm dependencies are satisfied at install time
        // on the host, not by pack; skip them silently.
      }
    }
    for (const dependency of dependencyNames(packed.manifest, 'optionalDependencies')) {
      if (available.has(dependency)) visit(dependency)
    }
  }
  for (const root of BUNDLE_ROOTS) visit(root)
  return [...selected.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, packed]) => packed)
}

/** Mirrors apps/desktop project-manager.ts workspaceFile() for the deployed profile. */
function workspaceFile(overrides: Readonly<Record<string, string>>): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function assertInstalled(project: string, relative: string): void {
  if (!existsSync(join(project, relative))) {
    throw new Error(`pixies packaging: installed project is missing ${relative}`)
  }
}

/**
 * Rewrite absolute in-project symlinks (pnpm's .bin links) as relative, and
 * reject any link resolving outside the project: codesign rejects bundles
 * whose symlinks leave the bundle.
 */
function relativizeSymlinks(project: string): number {
  const root = realpathSync(project)
  let rewritten = 0
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(path)
        const real = realpathSync(path)
        if (!isDescendant(root, real)) {
          throw new Error(`pixies packaging: symlink escapes the bundled project: ${path} -> ${target}`)
        }
        if (isAbsolute(target)) {
          unlinkSync(path)
          symlinkSync(relative(dirname(path), real).split(sep).join('/'), path)
          rewritten += 1
        }
        continue
      }
      if (entry.isDirectory()) visit(path)
    }
  }
  visit(project)
  return rewritten
}

function isDescendant(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

async function main(): Promise<void> {
  const version = pixiesAppVersion()
  console.log(`pixies packaging: version ${version}`)
  // The workspace root build does not include this app; build it explicitly.
  run('pnpm', ['run', 'build'], APP_ROOT)
  run('pnpm', ['run', 'build:speech'], APP_ROOT)
  // The packed tarballs must carry the same built lib output the desktop release uses.
  run('pnpm', ['run', 'build:official'], REPOSITORY_ROOT)
  for (const artifact of ['lib/index.js', 'lib/client.js']) {
    const path = join(REPOSITORY_ROOT, 'packages', 'extensions', 'pixies', artifact)
    if (!existsSync(path)) throw new Error(`pixies packaging: missing built artifact ${path}`)
  }

  // Pack the first-party closure exactly like the apps/desktop release does.
  const packedDsh = join(PACKED_ROOT, 'dsh')
  const packedVendor = join(PACKED_ROOT, 'vendor')
  const packedPixies = join(PACKED_ROOT, 'pixies')
  const packedLandlock = join(PACKED_ROOT, 'landlock')
  run('pnpm', ['run', 'release:pack', '--family', 'dsh', '--out', packedDsh], REPOSITORY_ROOT)
  run('pnpm', ['--dir', 'apps/desktop-host', 'pack', '--pack-destination', packedDsh], REPOSITORY_ROOT)
  run('pnpm', ['run', 'release:pack', '--family', 'vendor', '--out', packedVendor], REPOSITORY_ROOT)
  run('pnpm', ['--dir', 'packages/extensions/pixies', 'pack', '--pack-destination', packedPixies], REPOSITORY_ROOT)
  // The sandbox closure requires the native entry, exactly like the desktop
  // release packs it. The workspace moved landlock-run to native/system on
  // master; align with that path so the pixies pack follows the same closure.
  run('pnpm', ['--dir', 'native/system', 'run', 'build:ts'], REPOSITORY_ROOT)
  run('pnpm', ['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', packedLandlock], REPOSITORY_ROOT)

  const closure = selectClosure(packedPackages([packedDsh, packedVendor, packedPixies, packedLandlock]))
  const dshManifest = closure.find(packed => packed.manifest.name === DSH_PACKAGE)
  if (dshManifest === undefined || dshManifest.manifest.version !== version) {
    throw new Error(`pixies packaging: packed ${DSH_PACKAGE} must be ${version}`)
  }

  // Materialize the seed-style project: tarballs + descriptor + metadata, then
  // a real hoisted install (no symlinks) so the bundle is codesign-clean.
  const project = join(STAGE_ROOT, 'project')
  rmSync(STAGE_ROOT, { recursive: true, force: true })
  mkdirSync(join(project, 'desktop-packages'), { recursive: true })
  const records: DesktopCorePackageRecord[] = closure.map((packed) => {
    const name = packed.manifest.name
    const packageVersion = packed.manifest.version
    if (typeof name !== 'string' || typeof packageVersion !== 'string') {
      throw new Error(`pixies packaging: ${packed.tarball} has no package identity`)
    }
    const file = basename(packed.tarball)
    const destination = join(project, 'desktop-packages', file)
    copyFileSync(packed.tarball, destination, constants.COPYFILE_EXCL)
    const body = readFileSync(destination)
    return {
      name,
      version: packageVersion,
      file,
      bytes: statSync(destination).size,
      integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
    }
  })
  const packageSet = parseDesktopCorePackageSet({ schemaVersion: 1, packages: records })
  writeFileSync(join(project, 'desktop-packages.json'), `${JSON.stringify(packageSet, undefined, 2)}\n`)
  const overrides = Object.fromEntries(packageSet.packages.map(record => [record.name, `file:./desktop-packages/${record.file}`]))
  writeFileSync(join(project, 'package.json'), `${JSON.stringify({
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: overrides,
    dsh: { profile: { bundles: [...PROFILE_BUNDLES] } },
  }, undefined, 2)}\n`)
  writeFileSync(join(project, 'pnpm-workspace.yaml'), workspaceFile(overrides))
  // pnpm is a workspace devDependency of apps/desktop; read its manifest beside its entry.
  const desktopRequire = createRequire(join(REPOSITORY_ROOT, 'apps', 'desktop', 'package.json'))
  const pnpmManifest = JSON.parse(readFileSync(join(dirname(desktopRequire.resolve('pnpm')), 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof pnpmManifest.version !== 'string') throw new Error('pixies packaging: pnpm package has no version')
  writeFileSync(join(project, 'desktop-release.json'), `${JSON.stringify({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: process.versions.node,
    pnpmVersion: pnpmManifest.version,
  }, undefined, 2)}\n`)

  console.log('pixies packaging: installing the bundled project (nodeLinker: hoisted)')
  run('pnpm', ['install', '--lockfile-only'], project)
  run('pnpm', ['install', '--prod', '--frozen-lockfile', '--trust-lockfile'], project)
  for (const file of HOST_RUNTIME_FILES) assertInstalled(project, join('node_modules', DESKTOP_HOST_PACKAGE, file))
  assertInstalled(project, join('node_modules', ...PIXIES_PACKAGE.split('/'), 'package.json'))
  assertInstalled(project, join('node_modules', ...DSH_PACKAGE.split('/'), 'package.json'))
  const rewritten = relativizeSymlinks(project)
  console.log(`pixies packaging: rewrote ${String(rewritten)} absolute symlink(s) inside the bundled project`)

  run('pnpm', ['exec', 'electron-builder', '--mac', '--arm64', '--dir', '--publish', 'never', '--config', 'electron-builder.config.mjs'], APP_ROOT)

  const appPath = findApp(DIST_ROOT)
  if (appPath === '') throw new Error('pixies packaging: Pixies.app not found in dist output')

  // Copy resources manually: electron-builder's extraResources copier drops
  // node_modules directories. `cp -R` is required because Node's cpSync
  // rewrites relative symlinks into absolute ones, which codesign rejects.
  const resources = join(appPath, 'Contents', 'Resources')
  console.log('pixies packaging: copying resources into the bundle')
  rmSync(join(resources, 'project'), { recursive: true, force: true })
  run('cp', ['-R', project, join(resources, 'project')], APP_ROOT)
  // dsh-desktop-host unconditionally loads the Office skill plugin and the
  // plugin's apply() statSyncs `office-skills/scripts/check_office.py`; the
  // tray shell never invokes an office skill but must still ship the assets
  // or the host's boot throws and the IPC `ready` event never lands.
  // Mirrors apps/desktop/scripts/prepare-primary-runtime.ts → prepareOfficeSkillAssets:
  // the Office plugin assets live in @deepseek-ai/dsh-skill-office/assets and
  // desktop copies them next to runtime/primary-runtime. PIXIES collapses
  // runtime into project, so we copy them next to the Resources root instead.
  const stagedSkillOffice = join(project, 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'assets')
  if (!existsSync(stagedSkillOffice)) {
    throw new Error(`pixies packaging: staged project is missing ${stagedSkillOffice}`)
  }
  const officeSkillsDir = join(resources, 'office-skills')
  rmSync(officeSkillsDir, { recursive: true, force: true })
  cpSync(stagedSkillOffice, officeSkillsDir, { recursive: true, dereference: true })
  console.log('pixies packaging: staged office skill assets beside the project')
  const nodeDir = join(resources, 'runtime', 'node')
  mkdirSync(nodeDir, { recursive: true })
  cpSync(realpathSync(process.execPath), join(nodeDir, 'node'))
  cpSync(join(APP_ROOT, 'lib', 'pixies-speech'), join(resources, 'pixies-speech'))

  // No re-signing: electron-builder leaves the Electron binaries' original
  // linker-signed ad-hoc signatures intact, which is what a local debug build
  // needs. `--deep --sign -` would strip the helper entitlements and break the
  // Chromium sandbox, and re-signing after copying Resources would invalidate
  // the main binary's bundle seal.
  console.log(`pixies packaging: ${appPath}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
