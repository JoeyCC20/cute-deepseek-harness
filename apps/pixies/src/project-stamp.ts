/**
 * Content-fingerprinted project deploy stamps: the packaged project carries a
 * build fingerprint beside the app version, so a re-packaged bundle with the
 * same version number still redeploys into userData (dev builds iterate
 * without version bumps; the version-only stamp silently kept stale client
 * code running after the drag/click fix).
 * @module @deepseek-ai/dsh-pixies-app/project-stamp
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Name of the fingerprint file placed in the packaged (and staged) project. */
export const PIXIES_PROJECT_STAMP_FILE = '.pixies-build-stamp'

/**
 * Project-root descriptor files the fingerprint covers. `desktop-packages.json`
 * carries every first-party tarball's sha512 integrity, so any dependency
 * content change (including the dsh-pixies client bundle) changes the
 * fingerprint; the remaining files pin the profile composition, the install
 * resolution, and the host protocol contract.
 */
export const PIXIES_PROJECT_FINGERPRINT_FILES = [
  'desktop-packages.json',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'desktop-release.json',
] as const

/**
 * Compute the content fingerprint of a staged or packaged project.
 * @param projectDir - the project root holding the descriptor files.
 * @returns the sha256 hex digest over every descriptor file's name and bytes.
 * @throws when any descriptor file is missing (fail loud: a partial project
 * must never deploy with a stamp that silently pins it).
 */
export function buildPixiesProjectFingerprint(projectDir: string): string {
  const hash = createHash('sha256')
  for (const file of PIXIES_PROJECT_FINGERPRINT_FILES) {
    const path = join(projectDir, file)
    if (!existsSync(path)) {
      throw new Error(`pixies: project fingerprint source ${file} is missing`)
    }
    hash.update(file).update('\0').update(readFileSync(path)).update('\0')
  }
  return hash.digest('hex')
}

/**
 * Read the packaged project's build fingerprint.
 * @param projectDir - the packaged project root under Resources.
 * @returns the trimmed fingerprint, or undefined for pre-fingerprint bundles
 * (their stamp degrades to the version-only form, matching the old behavior).
 */
export function readPixiesBuildStamp(projectDir: string): string | undefined {
  const path = join(projectDir, PIXIES_PROJECT_STAMP_FILE)
  if (!existsSync(path)) return undefined
  const body = readFileSync(path, 'utf8').trim()
  return body === '' ? undefined : body
}

/**
 * Compose the deploy stamp written into userData and compared on every boot.
 * @param version - the app version (`app.getVersion()`).
 * @param fingerprint - the packaged project fingerprint, when present.
 * @returns the stamp text; version-only when the bundle predates fingerprints.
 */
export function composePixiesDeployStamp(version: string, fingerprint: string | undefined): string {
  return fingerprint === undefined ? `${version}\n` : `${version}\n${fingerprint}\n`
}
