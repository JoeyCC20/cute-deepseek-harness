/**
 * Node-side controller for spoken replies: the `speak` subcommand of the
 * `pixies-speech` Swift CLI (AVSpeechSynthesizer). One utterance owns one child;
 * a newer reply cancels the previous one so the newest result wins. Every
 * failure is an `error` event instead of a silent, text-only reply.
 * @module @deepseek-ai/dsh-pixies-app/voice
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

/** One event surfaced from the speech CLI's NDJSON stream. */
export type PixiesVoiceEvent =
  | { readonly type: 'speaking' }
  | { readonly type: 'done' }
  | { readonly type: 'cancelled' }
  | { readonly type: 'error'; readonly message: string }

/** Spoken replies are capped so a long markdown answer stays listenable. */
const MAX_SPOKEN_CHARS = 480

/** Han characters select the Chinese system voice; everything else uses English. */
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/u

/**
 * Reduce a model reply to speakable prose: drop fenced code, inline-code
 * markers, markdown links and headings, strip URLs and emphasis, flatten
 * whitespace, and cap the length.
 * @param text - the assistant's visible reply.
 * @returns the text to speak, or an empty string when nothing is speakable.
 */
export function spokenText(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/https?:\/\/\S+/gu, '')
    .replace(/[*_>#]/gu, ' ')
    // A NUL or other non-whitespace control byte cannot cross an argv boundary.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (plain === '') return ''
  return plain.length > MAX_SPOKEN_CHARS ? `${plain.slice(0, MAX_SPOKEN_CHARS)}…` : plain
}

/**
 * Choose the voice language from the reply's script.
 * @param text - the text about to be spoken.
 * @returns the BCP-47 tag passed to the speech helper.
 */
export function spokenLocale(text: string): 'zh-CN' | 'en-US' {
  return HAN.test(text) ? 'zh-CN' : 'en-US'
}

/**
 * Parse one NDJSON line from the speech CLI into a voice event.
 * @param line - a single stdout line (no trailing newline).
 * @returns the parsed event, or undefined for blank/garbage lines.
 */
export function parseVoiceLine(line: string): PixiesVoiceEvent | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (payload.type === 'speaking') return { type: 'speaking' }
  if (payload.type === 'done') return { type: 'done' }
  if (payload.type === 'cancelled') return { type: 'cancelled' }
  if (payload.type === 'error' && typeof payload.message === 'string') {
    return { type: 'error', message: payload.message }
  }
  return undefined
}

/** Injectable spawn signature (mirrors `node:child_process` spawn). */
export type PixiesVoiceSpawn = (
  binary: string,
  args: readonly string[],
  options: { readonly stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess

/** Deps and sinks for the controller. */
export interface PixiesVoiceDeps {
  /** The `pixies-speech` binary path (missing binaries disable speech output). */
  readonly binary: string
  /** Where parsed events go (renderer notification, diagnostics). */
  readonly onEvent: (event: PixiesVoiceEvent) => void
  /** Spawn override for tests; defaults to `node:child_process` spawn. */
  readonly spawnProcess?: PixiesVoiceSpawn
}

/**
 * Own the at-most-one speech-synthesis child. `speak()` replaces any active
 * utterance, `cancel()`/`dispose()` stop it, and a child that dies before
 * reporting a terminal event is surfaced as an `error`.
 */
export class PixiesVoiceController {
  private readonly binary: string
  private readonly onEvent: (event: PixiesVoiceEvent) => void
  private readonly spawnProcess: PixiesVoiceSpawn
  private child: ChildProcess | undefined
  private buffer = ''
  private stderr = ''
  private sawTerminal = false

  constructor(deps: PixiesVoiceDeps) {
    this.binary = deps.binary
    this.onEvent = deps.onEvent
    this.spawnProcess = deps.spawnProcess ?? ((bin, args, options) => spawn(bin, [...args], options))
  }

  /** Whether a synthesis child is currently alive. */
  get active(): boolean {
    return this.child !== undefined
  }

  /** Speak one reply, cancelling any utterance already in flight. */
  speak(text: string): void {
    const utterance = spokenText(text)
    if (utterance === '') return
    this.cancel()
    if (!existsSync(this.binary)) {
      this.onEvent({ type: 'error', message: 'voice helper is missing; rebuild with pnpm run build:speech' })
      return
    }
    let child: ChildProcess
    try {
      child = this.spawnProcess(
        this.binary,
        ['speak', utterance, '--locale', spokenLocale(utterance)],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
    } catch (error) {
      this.onEvent({
        type: 'error',
        message: `voice helper could not start: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    this.child = child
    this.buffer = ''
    this.stderr = ''
    this.sawTerminal = false
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.consume(chunk) })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-2048) })
    const fail = (message: string): void => {
      if (this.child !== child) return
      this.child = undefined
      this.buffer = ''
      if (!this.sawTerminal) this.onEvent({ type: 'error', message })
    }
    child.once('error', (error: Error) => { fail(`voice helper process error: ${error.message}`) })
    child.once('exit', (code, signal) => {
      const reason = code !== null ? `code ${String(code)}` : `signal ${String(signal)}`
      const detail = this.stderr.trim().slice(0, 300)
      fail(`voice helper exited (${reason})${detail === '' ? '' : `: ${detail}`}`)
    })
  }

  /** Stop the current utterance (no-op when idle) and clear the speaking state. */
  cancel(): void {
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    this.buffer = ''
    // The killed helper has no chance to report its own cancellation, so the
    // controller owns that terminal event for the renderer.
    this.onEvent({ type: 'cancelled' })
    try {
      child.kill('SIGTERM')
    } catch {
      // Already dead.
    }
  }

  /** Stop and permanently detach (app quit). */
  dispose(): void {
    this.cancel()
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      const event = parseVoiceLine(line)
      if (event === undefined) continue
      if (event.type !== 'speaking') this.sawTerminal = true
      this.onEvent(event)
    }
  }
}
