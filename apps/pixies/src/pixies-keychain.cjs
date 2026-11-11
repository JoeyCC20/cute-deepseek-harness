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
 *
 * The dev launcher passes `--pixies-dev-env=<json>` and
 * `--pixies-dev-log=<path>` for the same reason: its bundle executable is the
 * Electron binary itself, so no shell script can seed the environment or
 * redirect stdout/stderr. Those flags are applied here before anything else.
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

/** Dev launcher flags that replace the removed shell script's setup work. */
const LAUNCHER_FLAGS = /^--pixies-dev-(env|log)=(.+)$/

/**
 * @param {string[]} argv - process arguments.
 * @returns {{ envFile?: string, logFile?: string }} recognized launcher flags.
 */
function launcherFlags(argv = process.argv) {
  const out = {}
  for (const arg of argv) {
    const match = LAUNCHER_FLAGS.exec(arg)
    if (match === null) continue
    if (match[1] === 'env') out.envFile = match[2]
    else out.logFile = match[2]
  }
  return out
}

/**
 * LaunchServices discards a GUI app's stdout/stderr. The dev launcher asks us
 * to tee both into its log so `dev.ts` can keep streaming them to the terminal.
 * @param {string} file - append-only log path.
 */
function redirectLog(file) {
  try {
    const stream = fs.createWriteStream(file, { flags: 'a' })
    for (const name of ['stdout', 'stderr']) {
      const target = process[name]
      const write = target.write.bind(target)
      target.write = (chunk, ...rest) => {
        stream.write(chunk)
        return write(chunk, ...rest)
      }
    }
  } catch {
    // Diagnostics must never take the app down.
  }
}

function inject() {
  const { envFile, logFile } = launcherFlags()
  if (logFile !== undefined) redirectLog(logFile)
  let injected = 0
  const sources = []
  if (envFile !== undefined) {
    try {
      const parsed = JSON.parse(fs.readFileSync(envFile, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        sources.push(envFile)
        for (const [name, value] of Object.entries(parsed)) {
          if (typeof value !== 'string' || process.env[name] !== undefined) continue
          process.env[name] = value
          injected += 1
        }
      }
    } catch {
      // A missing dev environment file only means a normal packaged launch.
    }
  }
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

module.exports = { injectCredentials: inject, parse, sourceCandidates, launcherFlags }
