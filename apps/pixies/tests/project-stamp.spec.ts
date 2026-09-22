/**
 * Project deploy-stamp tests (test-validation phase 9 method 1): the packaged
 * project fingerprint changes with descriptor content, and the deploy stamp
 * pairing version + fingerprint forces a userData redeploy for same-version
 * re-packages (the stale-client regression this fixes).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPixiesProjectFingerprint,
  composePixiesDeployStamp,
  PIXIES_PROJECT_FINGERPRINT_FILES,
  PIXIES_PROJECT_STAMP_FILE,
  readPixiesBuildStamp,
} from '../src/project-stamp.ts'

const roots: string[] = []

function makeProject(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'pixies-stamp-'))
  roots.push(root)
  for (const file of PIXIES_PROJECT_FINGERPRINT_FILES) {
    writeFileSync(join(root, file), files[file] ?? `${file} default body\n`)
  }
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('buildPixiesProjectFingerprint', () => {
  it('is stable for identical descriptor content', () => {
    expect(buildPixiesProjectFingerprint(makeProject())).toBe(buildPixiesProjectFingerprint(makeProject()))
  })

  it('changes when any descriptor file content changes', () => {
    const first = makeProject()
    const second = makeProject({ 'pnpm-lock.yaml': 'different lock body\n' })
    expect(buildPixiesProjectFingerprint(first)).not.toBe(buildPixiesProjectFingerprint(second))
  })

  it('throws when a descriptor file is missing', () => {
    const root = makeProject()
    rmSync(join(root, 'desktop-packages.json'))
    expect(() => buildPixiesProjectFingerprint(root)).toThrow(/desktop-packages\.json/)
  })

  it('produces a sha256 hex digest', () => {
    expect(buildPixiesProjectFingerprint(makeProject())).toMatch(/^[0-9a-f]{64}$/u)
  })
})

describe('readPixiesBuildStamp', () => {
  it('reads the trimmed fingerprint from the stamp file', () => {
    const root = makeProject()
    writeFileSync(join(root, PIXIES_PROJECT_STAMP_FILE), 'abc123\n')
    expect(readPixiesBuildStamp(root)).toBe('abc123')
  })

  it('returns undefined when the stamp file is absent', () => {
    expect(readPixiesBuildStamp(makeProject())).toBeUndefined()
  })

  it('returns undefined when the stamp file is blank', () => {
    const root = makeProject()
    writeFileSync(join(root, PIXIES_PROJECT_STAMP_FILE), '   \n')
    expect(readPixiesBuildStamp(root)).toBeUndefined()
  })
})

describe('composePixiesDeployStamp', () => {
  it('pairs the version with the fingerprint on separate lines', () => {
    expect(composePixiesDeployStamp('0.1.6-alpha.2', 'feed')).toBe('0.1.6-alpha.2\nfeed\n')
  })

  it('degrades to the version-only form for pre-fingerprint bundles', () => {
    expect(composePixiesDeployStamp('0.1.6-alpha.2', undefined)).toBe('0.1.6-alpha.2\n')
  })

  it('makes same-version redeploys differ, and old version-only stamps mismatch', () => {
    const version = '0.1.6-alpha.2'
    // Old userData stamp (pre-fingerprint format, the field regression).
    const legacyStamp = `${version}\n`
    // New bundle with a fingerprint: stamp changes even though version did not.
    const newStamp = composePixiesDeployStamp(version, buildPixiesProjectFingerprint(makeProject()))
    expect(newStamp).not.toBe(legacyStamp)
    // A rebuild with changed content must differ from the previous fingerprinted stamp.
    const changed = makeProject({ 'desktop-packages.json': '{"packages":[]}\n' })
    const rebuiltStamp = composePixiesDeployStamp(version, buildPixiesProjectFingerprint(changed))
    expect(rebuiltStamp).not.toBe(newStamp)
    expect(rebuiltStamp.startsWith(`${version}\n`)).toBe(true)
  })
})
