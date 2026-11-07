/**
 * Pre-boot credential injection for the packaged macOS app.
 *
 * `open Pixies.app` launches through Launch Services, which inherits NO shell
 * environment. Variables defined in `~/.zshrc`/`~/.bash_profile` are therefore
 * absent inside the Electron process even though the user's terminal can see
 * them. dsh's provider routes that rely on ambient credential discovery then
 * fail with `Provider is not configured` while the same setup works in a
 * shell-launched process.
 *
 * This module reads `KEY=VALUE` lines from a small, explicit list of files
 * (project .env, then the user's shell rc files) and copies any entries that
 * are not already set into `process.env`. It is `require`d from the
 * packaged-entry shim before any dsh / Electron code runs so the credentials
 * are present at provider construction time.
 *
 * Order is intentional: explicit files win over shell rc, and we never
 * overwrite a value that is already in the environment (Launch Services DID
 * pass something through — that takes priority).
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HOME = os.homedir()
const USER_FILES = [
  path.join(HOME, '.config', 'dsh', 'env'),
  path.join(HOME, '.zshenv'),
  path.join(HOME, '.zshrc'),
  path.join(HOME, '.bash_profile'),
  path.join(HOME, '.bashrc'),
  path.join(HOME, '.profile'),
]

/**
 * Files to consult, nearest first. A Finder launch has `/` as cwd, and the dev
 * launcher runs from `.pixies-build/development/project`, so a single
 * `cwd/.env` misses the repository `.env` that holds DEEPSEEK_API_KEY. Walking
 * up the directory tree (plus an explicit launcher-supplied path) finds it
 * without hardcoding this checkout's location.
 * @param {string} cwd - working directory to start from.
 * @param {string | undefined} explicit - launcher-supplied `.env` path.
 * @returns {string[]} candidate file paths in priority order.
 */
function sourceCandidates(cwd = process.cwd(), explicit = process.env.DSH_PIXIES_ENV_FILE) {
  const files = []
  if (typeof explicit === 'string' && explicit !== '') files.push(explicit)
  let dir = cwd
  for (let depth = 0; depth < 16; depth += 1) {
    files.push(path.join(dir, '.env'))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return [...new Set([...files, ...USER_FILES])]
}

// Conservative token grammar: letters / digits / underscore, must start with a
// letter or underscore. Captures anything that looks like a shell variable
// assignment; we deliberately ignore `export FOO` without an assignment.
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/

function parse(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    if (raw === '' || raw.trimStart().startsWith('#')) continue
    const match = LINE.exec(raw)
    if (match === null) continue
    const [, name, rawValue] = match
    if (name === undefined || rawValue === undefined) continue
    let value = rawValue
    // Strip a single layer of matching single or double quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    out[name] = value
  }
  return out
}

function inject() {
  let injected = 0
  const sources = []
  for (const file of sourceCandidates()) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    sources.push(file)
    const parsed = parse(text)
    for (const [name, value] of Object.entries(parsed)) {
      if (process.env[name] !== undefined) continue
      process.env[name] = value
      injected += 1
    }
  }
  return { injected, sources }
}

module.exports = { injectCredentials: inject, parse, sourceCandidates }
