/**
 * Spoken-reply controller tests: NDJSON parsing, speakable-text reduction,
 * one-utterance-at-a-time cancellation, and every failure path surfaced as a
 * visible error event.
 */
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { parseVoiceLine, PixiesVoiceController, spokenLocale, spokenText } from '../src/voice.ts'
import type { PixiesVoiceEvent, PixiesVoiceSpawn } from '../src/voice.ts'

const EXISTING_FILE = fileURLToPath(import.meta.url)
const MISSING_BINARY = '/nonexistent-pixies-speech-binary'

type Listener = (...args: unknown[]) => void

function fakeChild(): {
  child: ChildProcess
  state: { signals: string[] }
  emitLine: (line: string) => void
  emitStderr: (text: string) => void
  emitExit: (code?: number | null, signal?: NodeJS.Signals | null) => void
  emitProcessError: (message: string) => void
} {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
  stdout.setEncoding = (): void => {}
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
  stderr.setEncoding = (): void => {}
  const exitListeners: Listener[] = []
  const errorListeners: Listener[] = []
  const state = { signals: [] as string[] }
  const child = {
    stdout,
    stderr,
    stdin: { end: (): void => {} },
    kill: (signal: NodeJS.Signals): void => { state.signals.push(signal) },
    once: (event: string, listener: Listener): ChildProcess => {
      if (event === 'exit') exitListeners.push(listener)
      if (event === 'error') errorListeners.push(listener)
      return child
    },
    on: (): ChildProcess => child,
  } as unknown as ChildProcess
  return {
    child,
    state,
    emitLine: (line) => { stdout.emit('data', line) },
    emitStderr: (text) => { stderr.emit('data', text) },
    emitExit: (code = 0, signal = null) => {
      for (const listener of [...exitListeners]) listener(code, signal)
    },
    emitProcessError: (message) => {
      for (const listener of [...errorListeners]) listener(new Error(message))
    },
  }
}

function harness(options: {
  readonly existingBinary?: boolean
  readonly spawnError?: Error
} = {}): {
  controller: PixiesVoiceController
  events: PixiesVoiceEvent[]
  calls: Array<{ binary: string; args: readonly string[] }>
  children: Array<ReturnType<typeof fakeChild>>
} {
  const events: PixiesVoiceEvent[] = []
  const calls: Array<{ binary: string; args: readonly string[] }> = []
  const children: Array<ReturnType<typeof fakeChild>> = []
  const spawn: PixiesVoiceSpawn = (binary, args, spawnOptions) => {
    calls.push({ binary, args })
    expect(spawnOptions.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    if (options.spawnError !== undefined) throw options.spawnError
    const child = fakeChild()
    children.push(child)
    return child.child
  }
  const controller = new PixiesVoiceController({
    binary: options.existingBinary === false ? MISSING_BINARY : EXISTING_FILE,
    onEvent: (event) => { events.push(event) },
    spawnProcess: spawn,
  })
  return { controller, events, calls, children }
}

describe('parseVoiceLine', () => {
  it('parses every terminal and error event and drops garbage', () => {
    expect(parseVoiceLine('  {"type":"speaking"}  ')).toEqual({ type: 'speaking' })
    expect(parseVoiceLine('{"type":"done"}')).toEqual({ type: 'done' })
    expect(parseVoiceLine('{"type":"cancelled"}')).toEqual({ type: 'cancelled' })
    expect(parseVoiceLine('{"type":"error","message":"no voice"}')).toEqual({ type: 'error', message: 'no voice' })
    expect(parseVoiceLine('')).toBeUndefined()
    expect(parseVoiceLine('not json')).toBeUndefined()
    expect(parseVoiceLine('{"type":"error"}')).toBeUndefined()
    expect(parseVoiceLine('{"type":"unknown"}')).toBeUndefined()
  })
})

describe('spokenText / spokenLocale', () => {
  it('reduces markdown to speakable prose', () => {
    expect(spokenText('# 标题\n**加粗** `代码` [文档](https://example.com/a) 完成'))
      .toBe('标题 加粗 代码 文档 完成')
    expect(spokenText('```js\nconst x = 1\n```\n好了')).toBe('好了')
    expect(spokenText('第一行\n\n第二行')).toBe('第一行 第二行')
    expect(spokenText('带\u0000控制符')).toBe('带 控制符')
    expect(spokenText('   ')).toBe('')
    expect(spokenText('```\nonly code\n```')).toBe('')
  })

  it('caps long replies so synthesis stays listenable', () => {
    const spoken = spokenText('啊'.repeat(600))
    expect(spoken).toHaveLength(481)
    expect(spoken.endsWith('…')).toBe(true)
  })

  it('chooses the voice language from the script', () => {
    expect(spokenLocale('今天天气不错')).toBe('zh-CN')
    expect(spokenLocale('All done')).toBe('en-US')
  })
})

describe('PixiesVoiceController', () => {
  it('spawns one speak child with the reduced text and forwards its events', () => {
    const { controller, events, calls, children } = harness()
    controller.speak('  你好，**世界**  ')
    expect(calls).toEqual([{ binary: EXISTING_FILE, args: ['speak', '你好， 世界', '--locale', 'zh-CN'] }])
    expect(controller.active).toBe(true)

    children[0]?.emitLine('{"type":"speaking"}\n{"type":"done"}\n')
    children[0]?.emitExit(0)
    expect(events).toEqual([{ type: 'speaking' }, { type: 'done' }])
    expect(controller.active).toBe(false)
  })

  it('drops blank or code-only replies without spawning', () => {
    const { controller, events, calls } = harness()
    controller.speak('```\ncode\n```')
    controller.speak('   ')
    expect(calls).toEqual([])
    expect(events).toEqual([])
  })

  it('reports a missing binary and a failed spawn as visible errors', () => {
    const missing = harness({ existingBinary: false })
    missing.controller.speak('你好')
    expect(missing.events).toEqual([{
      type: 'error', message: 'voice helper is missing; rebuild with pnpm run build:speech',
    }])
    expect(missing.calls).toEqual([])

    const failed = harness({ spawnError: new Error('EACCES') })
    failed.controller.speak('你好')
    expect(failed.events).toEqual([{ type: 'error', message: 'voice helper could not start: EACCES' }])
  })

  it('cancels the previous utterance when a newer reply arrives', () => {
    const { controller, events, calls, children } = harness()
    controller.speak('第一条')
    children[0]?.emitLine('{"type":"speaking"}\n')
    controller.speak('第二条')
    expect(children[0]?.state.signals).toEqual(['SIGTERM'])
    expect(calls).toHaveLength(2)
    expect(events).toEqual([{ type: 'speaking' }, { type: 'cancelled' }])

    children[1]?.emitLine('{"type":"speaking"}\n')
    expect(events.at(-1)).toEqual({ type: 'speaking' })
    controller.dispose()
    expect(children[1]?.state.signals).toEqual(['SIGTERM'])
    expect(events.at(-1)).toEqual({ type: 'cancelled' })
    expect(controller.active).toBe(false)
  })

  it('reports a child that dies before reporting a terminal event', () => {
    const { controller, events, children } = harness()
    controller.speak('你好')
    children[0]?.emitStderr('audio device missing')
    children[0]?.emitExit(1)
    expect(events).toEqual([{
      type: 'error', message: 'voice helper exited (code 1): audio device missing',
    }])
    expect(controller.active).toBe(false)
  })

  it('surfaces a process error without duplicating it on exit', () => {
    const { controller, events, children } = harness()
    controller.speak('你好')
    children[0]?.emitProcessError('spawn broken')
    children[0]?.emitExit(1)
    expect(events).toEqual([{ type: 'error', message: 'voice helper process error: spawn broken' }])
  })

  it('forwards the helper\'s own error once', () => {
    const { controller, events, children } = harness()
    controller.speak('你好')
    children[0]?.emitLine('{"type":"error","message":"no voice"}\n')
    children[0]?.emitExit(1)
    expect(events).toEqual([{ type: 'error', message: 'no voice' }])
  })
})
