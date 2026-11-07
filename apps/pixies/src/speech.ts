/**
 * Node-side controller for the `pixies-speech` Swift CLI (SFSpeechRecognizer
 * subprocess). Spawns the binary in `listen` mode, parses its NDJSON stdout
 * into typed events. A missing binary, a failed spawn, or a dead child is
 * surfaced as an `error` event instead of leaving the UI stuck on listening.
 * Testable against an injected spawn.
 * @module @deepseek-ai/dsh-pixies-app/speech
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

/** One event surfaced from the speech CLI's NDJSON stream. */
export type PixiesSpeechEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'partial'; readonly text: string }
  | { readonly type: 'final'; readonly text: string }
  | { readonly type: 'error'; readonly message: string }

/** The `probe` subcommand's parsed report. */
export interface PixiesSpeechProbe {
  readonly status: 'notDetermined' | 'denied' | 'authorized' | 'restricted' | 'unknown'
  readonly microphone: 'notDetermined' | 'denied' | 'authorized' | 'unknown'
}

const PROBE_STATUSES = new Set(['notDetermined', 'denied', 'authorized', 'restricted', 'unknown'])
const MICROPHONE_STATUSES = new Set(['notDetermined', 'denied', 'authorized', 'unknown'])

/**
 * Parse one NDJSON line from the speech CLI into an event.
 * @param line - a single stdout line (no trailing newline).
 * @returns the parsed event, or undefined for blank/garbage lines.
 */
export function parseSpeechLine(line: string): PixiesSpeechEvent | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return undefined
  }
  const type = payload.type
  if (type === 'ready') return { type: 'ready' }
  if (type === 'partial' && typeof payload.text === 'string') return { type: 'partial', text: payload.text }
  if (type === 'final' && typeof payload.text === 'string') return { type: 'final', text: payload.text }
  if (type === 'error' && typeof payload.message === 'string') return { type: 'error', message: payload.message }
  return undefined
}

/**
 * Parse the `probe` subcommand's JSON output.
 * @param text - the full probe stdout.
 * @returns the parsed report, or undefined when the output is not a valid probe.
 */
export function parseProbeOutput(text: string): PixiesSpeechProbe | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(text.slice(start)) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (payload.type !== 'probe') return undefined
  if (typeof payload.status !== 'string' || !PROBE_STATUSES.has(payload.status)) return undefined
  const microphone = typeof payload.microphone === 'string' && MICROPHONE_STATUSES.has(payload.microphone)
    ? payload.microphone as PixiesSpeechProbe['microphone']
    : 'unknown' as const
  return { status: payload.status as PixiesSpeechProbe['status'], microphone }
}

/** Injectable spawn signature (mirrors `node:child_process` spawn). */
export type PixiesSpeechSpawn = (
  binary: string,
  args: readonly string[],
  options: { readonly stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess

/** Deps and sinks for the controller. */
export interface PixiesSpeechDeps {
  /** The `pixies-speech` binary path (missing binaries disable speech). */
  readonly binary: string
  /** Where parsed events go (renderer notification, diagnostics). */
  readonly onEvent: (event: PixiesSpeechEvent) => void
  /** Spawn override for tests; defaults to `node:child_process` spawn. */
  readonly spawnProcess?: PixiesSpeechSpawn
}

/**
 * Own the at-most-one speech-recognition child. `start()` while active is a
 * no-op; every failure to start, spawn, or keep the child alive is surfaced as
 * an `error` event so the UI never stays stuck on "listening". `stop()` and
 * `dispose()` terminate the child (stdin EOF first, SIGTERM as fallback).
 */
export class PixiesSpeechController {
  private readonly binary: string
  private readonly onEvent: (event: PixiesSpeechEvent) => void
  private readonly spawnProcess: PixiesSpeechSpawn
  private child: ChildProcess | undefined
  private buffer = ''
  private stderr = ''
  private sawError = false

  constructor(deps: PixiesSpeechDeps) {
    this.binary = deps.binary
    this.onEvent = deps.onEvent
    this.spawnProcess = deps.spawnProcess ?? ((bin, args, options) => spawn(bin, [...args], options))
  }

  /** Whether a listener child is currently alive. */
  get active(): boolean {
    return this.child !== undefined
  }

  /** Start listening and report any reason it cannot stay alive. */
  start(): void {
    if (this.child !== undefined) return
    if (!existsSync(this.binary)) {
      this.onEvent({ type: 'error', message: 'speech helper is missing; rebuild with pnpm run build:speech' })
      return
    }
    let child: ChildProcess
    try {
      child = this.spawnProcess(this.binary, ['listen'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      this.onEvent({ type: 'error', message: `speech helper could not start: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    this.child = child
    this.buffer = ''
    this.stderr = ''
    this.sawError = false
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.consume(chunk) })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-2048) })
    // A child we stopped ourselves must not be reported as a failure.
    const fail = (message: string): void => {
      if (this.child !== child) return
      this.child = undefined
      this.buffer = ''
      if (!this.sawError) this.onEvent({ type: 'error', message })
    }
    child.once('error', (error: Error) => { fail(`speech helper process error: ${error.message}`) })
    child.once('exit', (code, signal) => {
      const reason = code !== null ? `code ${String(code)}` : `signal ${String(signal)}`
      const privacyHint = signal === 'SIGABRT'
        ? '; macOS denied a privacy permission — grant Speech Recognition and Microphone access in System Settings'
        : ''
      const detail = this.stderr.trim().slice(0, 300)
      fail(`speech helper exited (${reason})${privacyHint}${detail === '' ? '' : `: ${detail}`}`)
    })
  }

  /** Stop the listener (no-op when idle). */
  stop(): void {
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    this.buffer = ''
    child.stdin?.end()
    try {
      child.kill('SIGTERM')
    } catch {
      // Already dead.
    }
  }

  /** Stop and permanently detach (app quit). */
  dispose(): void {
    this.stop()
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      const event = parseSpeechLine(line)
      if (event === undefined) continue
      if (event.type === 'error') this.sawError = true
      this.onEvent(event)
    }
  }
}
