/**
 * Node-side controller for the `pixies-speech` Swift CLI (SFSpeechRecognizer
 * subprocess). Spawns the binary in `listen` mode, parses its NDJSON stdout
 * into typed events, and fails soft — a missing binary or a dead child only
 * ends the stream, never the app. Testable against an injected spawn.
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
 * no-op; a missing binary fails soft; `stop()`/`dispose()` terminate the
 * child (stdin EOF is the CLI's primary stop signal, SIGTERM the fallback).
 */
export class PixiesSpeechController {
  private readonly binary: string
  private readonly onEvent: (event: PixiesSpeechEvent) => void
  private readonly spawnProcess: PixiesSpeechSpawn
  private child: ChildProcess | undefined
  private buffer = ''

  constructor(deps: PixiesSpeechDeps) {
    this.binary = deps.binary
    this.onEvent = deps.onEvent
    this.spawnProcess = deps.spawnProcess ?? ((bin, args, options) => spawn(bin, [...args], options))
  }

  /** Whether a listener child is currently alive. */
  get active(): boolean {
    return this.child !== undefined
  }

  /** Start listening; fails soft when already active or the binary is absent. */
  start(): void {
    if (this.child !== undefined || !existsSync(this.binary)) return
    let child: ChildProcess
    try {
      child = this.spawnProcess(this.binary, ['listen'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      return
    }
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.consume(chunk) })
    child.once('exit', () => {
      this.child = undefined
      this.buffer = ''
    })
    child.once('error', () => {
      this.child = undefined
      this.buffer = ''
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
      if (event !== undefined) this.onEvent(event)
    }
  }
}
