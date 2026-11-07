/** Dependency-view staging tests: pnpm hoist links that no longer resolve. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDependencyView, retireProjectDir } from '../scripts/stage.ts'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pixies-stage-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A hoist root with valid packages, a real directory, and dangling links. */
function fakeHoist(root: string): { source: string; validTarget: string } {
  const source = join(root, 'hoist')
  const validTarget = join(root, 'real', 'pkg')
  const scopedTarget = join(root, 'real', 'scoped')
  mkdirSync(validTarget, { recursive: true })
  mkdirSync(scopedTarget, { recursive: true })
  mkdirSync(join(source, '@scope'), { recursive: true })
  mkdirSync(join(source, 'real-dir'), { recursive: true })
  mkdirSync(join(source, '.bin'), { recursive: true })
  symlinkSync(validTarget, join(source, 'valid-pkg'), 'dir')
  symlinkSync(join(root, 'missing'), join(source, 'broken-pkg'), 'dir')
  symlinkSync(scopedTarget, join(source, '@scope', 'valid'), 'dir')
  symlinkSync(join(root, 'missing'), join(source, '@scope', 'broken'), 'dir')
  return { source, validTarget }
}

describe('prepareDependencyView', () => {
  it('mirrors resolvable links and drops dangling ones', () => {
    const root = temporaryDirectory()
    const { source, validTarget } = fakeHoist(root)
    const view = join(root, 'view')

    expect(prepareDependencyView(source, view)).toBe(view)
    expect(existsSync(join(view, 'valid-pkg'))).toBe(true)
    expect(realpathSync(join(view, 'valid-pkg'))).toBe(realpathSync(validTarget))
    expect(existsSync(join(view, '@scope', 'valid'))).toBe(true)
    expect(existsSync(join(view, 'real-dir'))).toBe(true)
    expect(existsSync(join(view, 'broken-pkg'))).toBe(false)
    expect(existsSync(join(view, '@scope', 'broken'))).toBe(false)
    expect(existsSync(join(view, '.bin'))).toBe(false)
  })

  it('prunes stale entries while reusing intact links', () => {
    const root = temporaryDirectory()
    const { source } = fakeHoist(root)
    const view = join(root, 'view')

    prepareDependencyView(source, view)
    const link = join(view, 'valid-pkg')
    const inode = lstatSync(link).ino
    writeFileSync(join(view, 'stale.txt'), 'stale')
    prepareDependencyView(source, view)

    expect(existsSync(join(view, 'stale.txt'))).toBe(false)
    expect(lstatSync(link).ino).toBe(inode)
  })

  it('fails loud when the workspace hoist directory is absent', () => {
    const root = temporaryDirectory()
    expect(() => prepareDependencyView(join(root, 'absent'), join(root, 'view')))
      .toThrow('run pnpm install')
  })
})

describe('retireProjectDir', () => {
  it('moves an existing project aside without deleting it', () => {
    const root = temporaryDirectory()
    const project = join(root, 'project')
    mkdirSync(join(project, 'node_modules'), { recursive: true })
    writeFileSync(join(project, 'node_modules', 'marker'), 'old')

    retireProjectDir(project)

    expect(existsSync(project)).toBe(false)
    expect(existsSync(join(project, 'node_modules', 'marker'))).toBe(false)
  })

  it('is a no-op when there is no project yet', () => {
    const root = temporaryDirectory()
    expect(() => { retireProjectDir(join(root, 'absent')) }).not.toThrow()
  })
})
