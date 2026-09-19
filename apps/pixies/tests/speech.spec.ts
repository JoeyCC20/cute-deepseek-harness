/**
 * Speech subprocess controller tests (test-validation phase3 method 9):
 * NDJSON parsing, event flow with chunk buffering, fail-soft on a missing
 * binary, and stop semantics — all against an injected fake spawn.
 */
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { parseProbeOutput, parseSpeechLine, PixiesSpeechController } from '../src/speech.ts'
import type { ChildProcess } from 'node:child_process'
import type { PixiesSpeechEvent, PixiesSpeechSpawn } from '../src/speech.ts'

/** A real path so `existsSync` passes for the happy-path controller. */
const EXISTING_FILE = fileURLToPath(import.meta.url)
const MISSING_BINARY = '/nonexistent-pixies-speech-binary'

function fakeChild(): {
  child: ChildProcess
  state: { ended: boolean; signals: string[] }
  emitLine: (line: string) => void
  emitExit: () => void
} {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
  stdout.setEncoding = (): void => {}
  const exitListeners: Array<() => void> = []
  const state = { ended: false, signals: [] as string[] }
  const child = {
    stdout,
    stdin: { end: (): void => { state.ended = true } },
    kill: (signal: NodeJS.Signals): void => { state.signals.push(String(signal)) },
    once: (event: string, listener: (...args: never[]) => void): ChildProcess => {
      if (event === 'exit') exitListeners.push(() => { listener(...[] as never[]) })
      return child as unknown as ChildProcess
    },
    on: (): ChildProcess => child as unknown as ChildProcess,
  } as unknown as ChildProcess
  return {
    child,
    state,
    emitLine: (line) => { stdout.emit('data', line) },
    emitExit: () => { for (const listener of [...exitListeners]) listener() },
  }
}

function controllerHarness(existingBinary: boolean): {
  controller: PixiesSpeechController
  events: PixiesSpeechEvent[]
  calls: Array<{ binary: string; args: readonly string[] }>
  harness: ReturnType<typeof fakeChild>
} {
  const events: PixiesSpeechEvent[] = []
  const { child, ...harness } = fakeChild()
  const calls: Array<{ binary: string; args: readonly string[] }> = []
  const spawnProcess: PixiesSpeechSpawn = (binary, args, options) => {
    calls.push({ binary, args })
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    return child
  }
  const controller = new PixiesSpeechController({
    binary: existingBinary ? EXISTING_FILE : MISSING_BINARY,
    onEvent: (event) => { events.push(event) },
    spawnProcess,
  })
  return { controller, events, calls, harness: { ...harness, child } }
}

describe('parseSpeechLine', () => {
  it('parses every protocol event', () => {
    expect(parseSpeechLine('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseSpeechLine('{"type":"partial","text":"你好"}')).toEqual({ type: 'partial', text: '你好' })
    expect(parseSpeechLine('{"type":"final","text":"你好世界"}')).toEqual({ type: 'final', text: '你好世界' })
    expect(parseSpeechLine('{"type":"error","message":"boom"}')).toEqual({ type: 'error', message: 'boom' })
  })

  it('returns undefined for blank and garbage lines', () => {
    expect(parseSpeechLine('')).toBeUndefined()
    expect(parseSpeechLine('   ')).toBeUndefined()
    expect(parseSpeechLine('not json')).toBeUndefined()
    expect(parseSpeechLine('{"type":"unknown"}')).toBeUndefined()
    expect(parseSpeechLine('{"type":"partial"}')).toBeUndefined()
  })
})

describe('parseProbeOutput', () => {
  it('parses a valid probe report and defaults unknown microphone states', () => {
    expect(parseProbeOutput('{"type":"probe","status":"authorized","microphone":"denied"}'))
      .toEqual({ status: 'authorized', microphone: 'denied' })
    expect(parseProbeOutput('noise before {"type":"probe","status":"notDetermined"}'))
      .toEqual({ status: 'notDetermined', microphone: 'unknown' })
  })

  it('rejects garbage and wrong types', () => {
    expect(parseProbeOutput('')).toBeUndefined()
    expect(parseProbeOutput('{"type":"ready"}')).toBeUndefined()
    expect(parseProbeOutput('{"type":"probe","status":"bogus"}')).toBeUndefined()
    expect(parseProbeOutput('no json at all')).toBeUndefined()
  })
})

describe('PixiesSpeechController', () => {
  it('spawns listen mode and streams buffered NDJSON into events', () => {
    const { controller, events, calls, harness } = controllerHarness(true)

    expect(controller.active).toBe(false)
    controller.start()

    expect(calls).toEqual([{ binary: EXISTING_FILE, args: ['listen'] }])
    expect(controller.active).toBe(true)

    // One chunk with two full lines, one split line, and a blank line.
    harness.emitLine('{"type":"ready"}\n{"type":"par')
    harness.emitLine('tial","text":"你好"}\n\n{"type":"final","text":"你好"}\n{"type":"error","message":"x"}\n')

    expect(events).toEqual([
      { type: 'ready' },
      { type: 'partial', text: '你好' },
      { type: 'final', text: '你好' },
      { type: 'error', message: 'x' },
    ])

    harness.emitExit()
    expect(controller.active).toBe(false)
  })

  it('start while active is a no-op', () => {
    const { controller, calls } = controllerHarness(true)

    controller.start()
    controller.start()

    expect(calls).toHaveLength(1)
    controller.stop()
  })

  it('stop ends stdin, sends SIGTERM, and detaches', () => {
    const { controller, harness, calls } = controllerHarness(true)

    controller.start()
    controller.stop()

    expect(harness.state.ended).toBe(true)
    expect(harness.state.signals).toEqual(['SIGTERM'])
    expect(controller.active).toBe(false)

    controller.stop() // no-op while idle
    expect(harness.state.signals).toEqual(['SIGTERM'])
    expect(calls).toHaveLength(1)
  })

  it('fails soft when the binary is missing', () => {
    const { controller, events, calls } = controllerHarness(false)

    expect(() => { controller.start() }).not.toThrow()
    expect(calls).toHaveLength(0)
    expect(controller.active).toBe(false)
    expect(events).toEqual([])

    controller.stop()
    controller.dispose()
  })

  it('dispose stops a live listener', () => {
    const { controller, harness } = controllerHarness(true)
    const killSpy = vi.spyOn(harness.child, 'kill')

    controller.start()
    controller.dispose()

    expect(harness.state.ended).toBe(true)
    expect(killSpy).toHaveBeenCalledWith('SIGTERM')
    expect(controller.active).toBe(false)
  })
})
