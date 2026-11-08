/**
 * @vitest-environment jsdom
 *
 * Shell-surface tests (test-validation phase2c method 6): session picking,
 * the follow feed's watermark/rebind semantics, and the full-window mount
 * that stays live from the store.
 */
import { act, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type {
  ISessions,
  SessionEventChange,
  SessionEventLikeEntry,
  SessionEventSource,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { createPixiesStore } from '../../src/client/store.ts'
import {
  defaultPixiesMessages,
  followPixiesSession,
  mountPixiesShell,
  pickPixiesSessionId,
  promptPixiesSession,
} from '../../src/client/shell.tsx'
import type {
  PixiesShellBridge,
  PixiesShellMode,
  PixiesShellSpeechEvent,
} from '../../src/client/shell.tsx'

/** A minimal structural `SessionEventSource` with an appendable window. */
function fakeEventSource(entries: readonly SessionEventLikeEntry[] = []): {
  source: SessionEventSource
  append: (entry: SessionEventLikeEntry) => void
  listenerCount: () => number
} {
  let window: { entries: readonly SessionEventLikeEntry[]; hasMore: boolean; revision: number; change: SessionEventChange } = {
    entries,
    hasMore: false,
    revision: 0,
    change: { kind: 'replace', entries },
  }
  const listeners = new Set<() => void>()
  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    source: {
      getSnapshot: () => window,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    },
    append: (entry) => {
      window = {
        entries: [...window.entries, entry],
        hasMore: false,
        revision: window.revision + 1,
        change: { kind: 'append', entries: [entry] },
      }
      publish()
    },
    listenerCount: () => listeners.size,
  }
}

/** A minimal structural `ISessions`: a mutable list snapshot plus retain-materialized bindings. */
function fakeSessions(
  state: SessionListState,
  bindings: ReadonlyMap<string, SessionEventSource>,
): {
  sessions: ISessions
  setList: (next: SessionListState) => void
  listListenerCount: () => number
  retainCount: (id: string) => number
} {
  let current = state
  const listeners = new Set<() => void>()
  // Mirrors the real service: a binding exists only while a reference is held.
  const retained = new Map<string, number>()
  const bindingFor = (id: string): { sessionId: string; eventSource: SessionEventSource } => {
    const eventSource = bindings.get(id)
    if (eventSource === undefined) throw new Error(`fakeSessions: no event source for ${id}`)
    return { sessionId: id, eventSource }
  }
  interface FakeReference {
    sessionId: string
    binding: ReturnType<typeof bindingFor>
    ready: Promise<unknown>
    release: () => void
  }
  const retain = (id: string): FakeReference => {
    retained.set(id, (retained.get(id) ?? 0) + 1)
    const binding = bindingFor(id)
    return {
      sessionId: id,
      binding,
      ready: Promise.resolve(binding),
      release: () => { retained.set(id, Math.max(0, (retained.get(id) ?? 1) - 1)) },
    }
  }
  const sessions = {
    list: {
      getSnapshot: () => current,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    },
    binding: (id: string) => ((retained.get(id) ?? 0) > 0 ? bindingFor(id) : undefined),
    retain,
    using: async (id: string, _options: unknown, operation: (reference: ReturnType<typeof retain>) => unknown) => {
      const reference = retain(id)
      try {
        return await operation(reference)
      } finally {
        reference.release()
      }
    },
  } as unknown as ISessions
  return {
    sessions,
    setList: (next) => {
      current = next
      for (const listener of [...listeners]) listener()
    },
    listListenerCount: () => listeners.size,
    retainCount: id => retained.get(id) ?? 0,
  }
}

/** Let the follow's async attach (retain → ready → subscribe) settle. */
async function flushFollow(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** A `SessionListState` carrying only the fields the shell reads. */
function listState(ids: readonly string[], current: string | undefined): SessionListState {
  return {
    ids,
    byId: {},
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  } as unknown as SessionListState
}

/** One durable `assistant/message` entry carrying speakable text. */
function assistantMessage(seq: number, text: string): SessionEventLikeEntry {
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      seq,
      time: 0,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
    },
  } as unknown as SessionEventLikeEntry
}

/** One durable non-speech entry the feed must ignore. */
function userMessage(seq: number): SessionEventLikeEntry {
  return {
    type: 'event',
    event: { type: 'user/message', seq, time: 0, data: {} },
  } as unknown as SessionEventLikeEntry
}

describe('pickPixiesSessionId', () => {
  it('prefers the current selection', () => {
    expect(pickPixiesSessionId(listState(['a', 'b'], 'b'))).toBe('b')
  })

  it('falls back to the first listed session', () => {
    expect(pickPixiesSessionId(listState(['a', 'b'], undefined))).toBe('a')
  })

  it('is undefined while no session exists', () => {
    expect(pickPixiesSessionId(listState([], undefined))).toBeUndefined()
  })
})

describe('followPixiesSession', () => {
  it('binds the current session without replaying its history', async () => {
    const store = createPixiesStore()
    const a = fakeEventSource([assistantMessage(1, '早上好')])
    const { sessions, retainCount } = fakeSessions(listState(['a'], 'a'), new Map([['a', a.source]]))

    const follow = followPixiesSession(sessions, store)
    await flushFollow()

    expect(store.getState().latest).toBeUndefined()
    expect(a.listenerCount()).toBe(1)
    expect(retainCount('a')).toBe(1)
    follow.dispose()
  })

  it('feeds newly appended assistant messages and ignores other events', async () => {
    const store = createPixiesStore()
    const a = fakeEventSource()
    const { sessions } = fakeSessions(listState(['a'], 'a'), new Map([['a', a.source]]))

    const follow = followPixiesSession(sessions, store)
    await flushFollow()
    a.append(assistantMessage(1, '你好'))
    expect(store.getState().latest?.text).toBe('你好')
    expect(store.getState().latest?.sessionId).toBe('a')

    a.append(userMessage(2))
    expect(store.getState().latest?.text).toBe('你好')
    follow.dispose()
  })

  it('rebinds when the followed session changes, resets the watermark, and releases the old reference', async () => {
    const store = createPixiesStore()
    const a = fakeEventSource()
    const b = fakeEventSource()
    const { sessions, setList, retainCount } = fakeSessions(
      listState(['a'], 'a'),
      new Map([['a', a.source], ['b', b.source]]),
    )

    const follow = followPixiesSession(sessions, store)
    await flushFollow()
    a.append(assistantMessage(1, '第一条'))
    expect(store.getState().latest?.text).toBe('第一条')

    setList(listState(['a', 'b'], 'b'))
    await flushFollow()
    expect(a.listenerCount()).toBe(0)
    expect(b.listenerCount()).toBe(1)
    expect(retainCount('a')).toBe(0)
    expect(retainCount('b')).toBe(1)

    // Session b's own log starts over, so a seq below session a's watermark still feeds.
    b.append(assistantMessage(7, '新会话'))
    expect(store.getState().latest?.text).toBe('新会话')
    expect(store.getState().latest?.sessionId).toBe('b')
    follow.dispose()
  })

  it('retains the first listed session when the profile has no current selection', async () => {
    const store = createPixiesStore()
    const a = fakeEventSource()
    const { sessions, setList, retainCount } = fakeSessions(listState([], undefined), new Map([['a', a.source]]))

    const follow = followPixiesSession(sessions, store)
    await flushFollow()
    expect(a.listenerCount()).toBe(0)
    expect(retainCount('a')).toBe(0)

    setList(listState(['a'], undefined))
    await flushFollow()
    expect(a.listenerCount()).toBe(1)
    expect(retainCount('a')).toBe(1)

    a.append(assistantMessage(1, '你好'))
    expect(store.getState().latest?.text).toBe('你好')
    follow.dispose()
  })

  it('dispose releases the list subscription, event subscription, and retained reference', async () => {
    const store = createPixiesStore()
    const a = fakeEventSource()
    const b = fakeEventSource()
    const { sessions, setList, listListenerCount, retainCount } = fakeSessions(
      listState(['a'], 'a'),
      new Map([['a', a.source], ['b', b.source]]),
    )

    const follow = followPixiesSession(sessions, store)
    await flushFollow()
    expect(listListenerCount()).toBe(1)
    expect(retainCount('a')).toBe(1)

    follow.dispose()
    expect(listListenerCount()).toBe(0)
    expect(a.listenerCount()).toBe(0)
    expect(retainCount('a')).toBe(0)

    setList(listState(['a', 'b'], 'b'))
    await flushFollow()
    expect(b.listenerCount()).toBe(0)
  })
})

describe('mountPixiesShell', () => {
  it('renders idle, stays live from the store, and unmounts on dispose', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)

    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store) })
    expect(container.querySelector('[data-pixies-shell]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pixies-character"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()

    act(() => {
      store.speak({
        id: 'session-1#1',
        sessionId: 'session-1',
        character: 'spider-man',
        kind: 'speech',
        mood: 'neutral',
        text: '我是蜘蛛侠',
        seq: 1,
      })
    })
    expect(container.querySelector('[data-testid="pixies-bubble"]')?.textContent).toBe('我是蜘蛛侠')
    expect(container.querySelector('[data-testid="pixies-character"]')).not.toBeNull()

    act(() => { disposer?.() })
    expect(container.firstChild).toBeNull()
    container.remove()
  })

  it('defaults to the locale-owned interaction copy', () => {
    expect(defaultPixiesMessages.approval).toBe('需要你的确认')
    expect(defaultPixiesMessages.question).toBe('有个问题想问你')
    expect(defaultPixiesMessages.expand).toBe('展开对话')
    expect(defaultPixiesMessages.mic).toBe('语音输入')
    expect(defaultPixiesMessages.collapse).toBe('收起')
    expect(defaultPixiesMessages.speechFailed).toBe('语音输入失败')
    expect(defaultPixiesMessages.promptFailed).toBe('发送失败')
    expect(defaultPixiesMessages.placeholder).toBe('给 Pixies 发消息…')
  })
})

/** A recording fake of the Electron preload bridge. */
function fakeBridge(options: { readonly mode?: PixiesShellMode } = {}): {
  bridge: PixiesShellBridge
  calls: string[]
  emitMode: (mode: PixiesShellMode) => void
  emitSpeech: (event: PixiesShellSpeechEvent) => void
  emitVoiceReply: (event: unknown) => void
  emitVoiceCommand: (event: unknown) => void
  speechListenerCount: () => number
  modeListenerCount: () => number
} {
  const calls: string[] = []
  const speechListeners: Array<(event: PixiesShellSpeechEvent) => void> = []
  const modeListeners: Array<(mode: PixiesShellMode) => void> = []
  const voiceListeners: Array<(event: unknown) => void> = []
  const commandListeners: Array<(event: unknown) => void> = []
  const remove = <T,>(list: T[], item: T): void => {
    const index = list.indexOf(item)
    if (index >= 0) list.splice(index, 1)
  }
  const bridge: PixiesShellBridge = {
    expand: () => { calls.push('expand') },
    collapse: () => { calls.push('collapse') },
    startSpeech: () => { calls.push('startSpeech') },
    stopSpeech: () => { calls.push('stopSpeech') },
    getMode: async () => options.mode,
    endDrag: () => { calls.push('endDrag') },
    onSpeech: (listener) => {
      speechListeners.push(listener)
      return () => { remove(speechListeners, listener) }
    },
    onMode: (listener) => {
      modeListeners.push(listener)
      return () => { remove(modeListeners, listener) }
    },
    speakReply: (text) => { calls.push(`speakReply:${text}`) },
    cancelReply: () => { calls.push('cancelReply') },
    onVoiceReply: (listener) => {
      voiceListeners.push(listener)
      return () => { remove(voiceListeners, listener) }
    },
    onVoiceCommand: (listener) => {
      commandListeners.push(listener)
      return () => { remove(commandListeners, listener) }
    },
    dragBy: () => {},
  }
  return {
    bridge,
    calls,
    emitMode: (mode) => { for (const listener of [...modeListeners]) listener(mode) },
    emitSpeech: (event) => { for (const listener of [...speechListeners]) listener(event) },
    emitVoiceReply: (event) => { for (const listener of [...voiceListeners]) listener(event) },
    emitVoiceCommand: (event) => { for (const listener of [...commandListeners]) listener(event) },
    speechListenerCount: () => speechListeners.length,
    modeListenerCount: () => modeListeners.length,
  }
}

describe('mountPixiesShell with the shell bridge (phase 3)', () => {
  it('starts mini, expands on the avatar click, and collapses back', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, calls, emitMode, modeListenerCount } = fakeBridge()

    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })

    // Mini: the peeking avatar button only.
    expect(container.querySelector('[data-testid="pixies-mini"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pixies-character"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pixies-mic"]')).toBeNull()
    expect(container.querySelector('[data-pixies-shell]')).not.toBeNull()

    fireEvent.click(container.querySelector('[data-testid="pixies-mini"]')!)
    expect(calls).toEqual(['expand'])

    act(() => { emitMode('expanded') })
    expect(container.querySelector('[data-testid="pixies-mini"]')).toBeNull()
    expect(container.querySelector('[data-testid="pixies-mic"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pixies-collapse"]')).not.toBeNull()

    fireEvent.click(container.querySelector('[data-testid="pixies-collapse"]')!)
    expect(calls).toEqual(['expand', 'collapse'])
    act(() => { emitMode('mini') })
    expect(container.querySelector('[data-testid="pixies-mini"]')).not.toBeNull()
    expect(modeListenerCount()).toBe(1)

    act(() => { disposer?.() })
    expect(container.firstChild).toBeNull()
    container.remove()
  })

  it('routes speech: mic toggles, partial fills the bubble, final fires the transcript', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, calls, emitMode, emitSpeech } = fakeBridge()
    const finals: string[] = []

    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, (text) => { finals.push(text) })
    })
    act(() => { emitMode('expanded') })

    const mic = (): HTMLElement => container.querySelector('[data-testid="pixies-mic"]')!
    fireEvent.click(mic())
    expect(calls).toEqual(['startSpeech'])
    // Phase 6: the click itself must show feedback, not wait for the first event.
    expect(mic().getAttribute('data-active')).toBe('')
    expect(container.querySelector('[data-testid="pixies-bubble"]')?.textContent)
      .toBe(defaultPixiesMessages.listening)

    act(() => { emitSpeech({ type: 'ready' }) })
    expect(mic().getAttribute('data-active')).toBe('')

    act(() => { emitSpeech({ type: 'partial', text: '你好' }) })
    expect(container.querySelector('[data-testid="pixies-bubble"]')?.textContent).toBe('你好')

    act(() => { emitSpeech({ type: 'final', text: '你好世界' }) })
    expect(finals).toEqual(['你好世界'])
    expect(calls).toEqual(['startSpeech', 'stopSpeech'])
    expect(mic().hasAttribute('data-active')).toBe(false)
    expect(container.querySelector('[data-testid="pixies-bubble"]')).toBeNull() // idle again

    // Second round: a partial then an error also ends the round without firing.
    fireEvent.click(mic())
    act(() => { emitSpeech({ type: 'partial', text: '写到一半' }) })
    expect(container.querySelector('[data-testid="pixies-bubble"]')?.textContent).toBe('写到一半')
    act(() => { emitSpeech({ type: 'error', message: 'denied' }) })
    expect(finals).toEqual(['你好世界'])
    expect(calls).toEqual(['startSpeech', 'stopSpeech', 'startSpeech', 'stopSpeech'])
    // Phase 6: a failed round must say why instead of going silent.
    expect(container.querySelector('[data-testid="pixies-bubble"]')?.textContent)
      .toBe(`${defaultPixiesMessages.speechFailed}: denied`)

    // The next round starts clean: the stale reason is gone.
    fireEvent.click(mic())
    act(() => { emitSpeech({ type: 'ready' }) })
    expect(container.querySelector('[data-testid="pixies-bubble"]')?.textContent)
      .toBe(defaultPixiesMessages.listening)

    act(() => { disposer?.() })
    container.remove()
  })

  it('says why in the bubble when the transcript handler rejects (phase 10)', async () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode, emitSpeech } = fakeBridge()

    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, async () => {
        throw new Error('boom')
      })
    })
    act(() => { emitMode('expanded') })

    fireEvent.click(container.querySelector('[data-testid="pixies-mic"]')!)
    await act(async () => { emitSpeech({ type: 'final', text: '你好' }) })
    // A failed delivery is invisible in the transcript path alone; the bubble
    // must carry the host's rejection reason instead of going idle silently.
    expect(container.querySelector('[data-testid="pixies-bubble"]')?.textContent)
      .toBe(`${defaultPixiesMessages.promptFailed}: boom`)
    expect(container.querySelector('[data-testid="pixies-mic"]')?.hasAttribute('data-active')).toBe(false)

    act(() => { disposer?.() })
    container.remove()
  })

  it('tapping stop mid-round sends the recognized draft instead of dropping it', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode, emitSpeech } = fakeBridge()
    const finals: string[] = []

    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, (text) => { finals.push(text) })
    })
    act(() => { emitMode('expanded') })

    const mic = (): HTMLElement => container.querySelector('[data-testid="pixies-mic"]')!
    fireEvent.click(mic()) // start
    act(() => { emitSpeech({ type: 'partial', text: '今天星期几' }) })
    expect(container.querySelector('[data-testid="pixies-bubble"]')?.textContent).toBe('今天星期几')

    fireEvent.click(mic()) // stop with a draft: the draft must be sent.
    expect(finals).toEqual(['今天星期几'])
    expect(bridge).toBeTruthy()

    act(() => { disposer?.() })
    container.remove()
  })
})

describe('promptPixiesSession (phase 3 / phase 5 / phase 10)', () => {
  interface UsingRecord {
    id: string
    content: unknown
    mode: string
  }

  /**
   * A fake mirroring the real service's materialization rule: a promptable
   * binding exists ONLY inside `using`'s retain scope — `binding()` returns
   * undefined for catalog ids, and `create()` never materializes one. The
   * old fake exposed `binding()` unconditionally, which masked the field bug
   * where transcripts were silently dropped on never-retained sessions.
   */
  function sessionsWithUsing(
    prompts: UsingRecord[],
    opts: {
      state?: SessionListState
      promptResponse?: () => { ok: false; error: { code: string; message: string } }
      createError?: Error
    } = {},
  ): {
    sessions: ISessions
    created: string[]
    usingIds: string[]
    bindingCalls: string[]
  } {
    const created: string[] = []
    const usingIds: string[] = []
    const bindingCalls: string[] = []
    const respond = opts.promptResponse
    const sessions = {
      list: {
        getSnapshot: () => opts.state ?? listState(['a'], 'a'),
        subscribe: () => () => {},
      },
      create: async (): Promise<string> => {
        if (opts.createError !== undefined) throw opts.createError
        const id = `created-${created.length + 1}`
        created.push(id)
        return id
      },
      binding: (id: string) => {
        bindingCalls.push(id)
        return undefined
      },
      using: async (id: string, _options: unknown, operation: (reference: unknown) => unknown) => {
        usingIds.push(id)
        const reference = {
          ready: Promise.resolve(),
          binding: {
            sessionId: id,
            session: {
              prompt: (content: unknown, mode: string): Promise<unknown> => {
                prompts.push({ id, content, mode })
                const response = respond?.()
                return response === undefined
                  ? Promise.resolve({ ok: true, value: { accepted: true } })
                  : Promise.resolve(response)
              },
            },
          },
        }
        return await operation(reference)
      },
    } as unknown as ISessions
    return { sessions, created, usingIds, bindingCalls }
  }

  it('sends the transcript as a queued text prompt to the selected session without creating one', async () => {
    const prompts: UsingRecord[] = []
    const { sessions, created, usingIds, bindingCalls } = sessionsWithUsing(prompts)

    await promptPixiesSession(sessions, '帮我看一下这段代码')

    expect(prompts).toEqual([{ id: 'a', content: [{ type: 'text', text: '帮我看一下这段代码' }], mode: 'queue' }])
    expect(created).toEqual([])
    expect(usingIds).toEqual(['a'])
    expect(bindingCalls).toEqual([])
  })

  // Phase 10 regression: the real service keeps no binding for a merely
  // listed session, so a transcript must travel through a retained
  // reference (`using`) instead of a direct `binding()` read.
  it('delivers the prompt through a retained reference although binding() holds nothing', async () => {
    const prompts: UsingRecord[] = []
    const { sessions, bindingCalls } = sessionsWithUsing(prompts)

    await promptPixiesSession(sessions, '仍然要送达')

    expect(bindingCalls).toEqual([])
    expect(prompts).toEqual([{ id: 'a', content: [{ type: 'text', text: '仍然要送达' }], mode: 'queue' }])
  })

  it('creates the session when the profile has none, then prompts the created one', async () => {
    const prompts: UsingRecord[] = []
    const { sessions, created } = sessionsWithUsing(prompts, { state: listState([], undefined) })

    await promptPixiesSession(sessions, '哈喽')

    expect(created).toEqual(['created-1'])
    expect(prompts).toEqual([{ id: 'created-1', content: [{ type: 'text', text: '哈喽' }], mode: 'queue' }])
  })

  it('rejects with the prompt error code and message when the session refuses', async () => {
    const prompts: UsingRecord[] = []
    const { sessions } = sessionsWithUsing(prompts, {
      promptResponse: () => ({ ok: false, error: { code: 'busy', message: 'session busy' } }),
    })

    await expect(promptPixiesSession(sessions, '拒收试试')).rejects.toThrow('busy: session busy')
    expect(prompts).toEqual([{ id: 'a', content: [{ type: 'text', text: '拒收试试' }], mode: 'queue' }])
  })

  it('rejects when create fails and never prompts', async () => {
    const prompts: UsingRecord[] = []
    const { sessions } = sessionsWithUsing(prompts, {
      state: listState([], undefined),
      createError: new Error('host down'),
    })

    await expect(promptPixiesSession(sessions, '新会话也失败')).rejects.toThrow('host down')
    expect(prompts).toEqual([])
  })

  it('drops blank text without creating or prompting', async () => {
    const prompts: UsingRecord[] = []
    const { sessions, created, usingIds } = sessionsWithUsing(prompts)

    await promptPixiesSession(sessions, '   ')

    expect(created).toEqual([])
    expect(usingIds).toEqual([])
    expect(prompts).toEqual([])
  })
})

describe('expanded conversation interactions', () => {
  /** Mount a shell with a bridge, expand it, and return the interesting nodes. */
  function bench(options: { readonly mode?: PixiesShellMode } = {}): {
    store: ReturnType<typeof createPixiesStore>
    container: HTMLElement
    bridge: ReturnType<typeof fakeBridge>
    input: () => HTMLTextAreaElement
    send: () => HTMLButtonElement
    dispose: () => void
  } {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const bridge = fakeBridge(options)
    const sent: string[] = []
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge.bridge, (text) => { sent.push(text) })
    })
    act(() => { bridge.emitMode('expanded') })
    return {
      store,
      container,
      bridge,
      input: () => container.querySelector('[data-testid="pixies-input"]') as HTMLTextAreaElement,
      send: () => container.querySelector('[data-testid="pixies-send"]') as HTMLButtonElement,
      dispose: () => { act(() => { disposer?.() }); container.remove() },
    }
  }

  it('sends typed text with Enter, clears the composer, and renders the prompt', () => {
    const b = bench()
    const input = b.input()
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { value: '你好，Pixies' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(b.container.textContent).toContain('你好，Pixies')
    expect(input.value).toBe('')
    b.dispose()
  })

  it('keeps Shift+Enter as a newline instead of sending', () => {
    const b = bench()
    const input = b.input()
    fireEvent.change(input, { target: { value: '第一行' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(input.value).toBe('第一行')
    expect(b.container.querySelector('[data-testid="pixies-send"]')).not.toBeNull()
    b.dispose()
  })

  it('disables send while the draft is blank and sends on click', () => {
    const b = bench()
    const send = b.send()
    expect(send.disabled).toBe(true)
    fireEvent.change(b.input(), { target: { value: '走起' } })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(b.container.textContent).toContain('走起')
    expect(b.input().value).toBe('')
    b.dispose()
  })

  it('collapses on Escape', () => {
    const b = bench()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(b.bridge.calls).toContain('collapse')
    b.dispose()
  })

  it('renders the assistant reply and the thinking state as a status bubble', () => {
    const b = bench()
    act(() => { b.store.beginThinking('session-1') })
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')?.getAttribute('data-mood')).toBe('thinking')
    act(() => {
      b.store.speak({
        id: 'session-1#2', sessionId: 'session-1', character: 'spider-man',
        kind: 'speech', mood: 'happy', text: '我在这儿', seq: 2,
      })
    })
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')?.textContent).toBe('我在这儿')
    b.dispose()
  })

  it('reconciles the window mode from the main process on mount', async () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge } = fakeBridge({ mode: 'expanded' })
    let disposer: (() => void) | undefined
    await act(async () => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge)
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="pixies-mic"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pixies-mini"]')).toBeNull()
    act(() => { disposer?.() })
    container.remove()
  })

  it('does not expand the avatar after a real pointer drag', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, calls } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })
    const root = container.querySelector('[data-pixies-shell]') as HTMLElement
    const avatar = container.querySelector('[data-testid="pixies-mini"]') as HTMLElement
    fireEvent.pointerDown(root, { pointerId: 1, button: 0, screenX: 100, screenY: 100 })
    fireEvent.pointerMove(root, { pointerId: 1, screenX: 130, screenY: 100 })
    fireEvent.pointerUp(root, { pointerId: 1, screenX: 130, screenY: 100 })
    fireEvent.click(avatar)
    expect(calls).not.toContain('expand')
    // A plain tap still expands.
    fireEvent.click(avatar)
    expect(calls).toContain('expand')
    act(() => { disposer?.() })
    container.remove()
  })
})

describe('voice-command shortcut and spoken replies', () => {
  /** One assistant entry appended through the store's own speech path. */
  const speak = (store: ReturnType<typeof createPixiesStore>, id: string, text: string): void => {
    store.speak({
      id, sessionId: 'session-1', character: 'spider-man',
      kind: 'speech', mood: 'neutral', text, seq: 1,
    })
  }

  /** Mount in expanded mode with the recording bridge. */
  function expandedBench(): {
    store: ReturnType<typeof createPixiesStore>
    container: HTMLElement
    bridge: ReturnType<typeof fakeBridge>
    voice: () => HTMLElement
    dispose: () => void
  } {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const bridge = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge.bridge) })
    act(() => { bridge.emitMode('expanded') })
    return {
      store,
      container,
      bridge,
      voice: () => container.querySelector('[data-testid="pixies-voice"]') as HTMLElement,
      dispose: () => { act(() => { disposer?.() }); container.remove() },
    }
  }

  it('changes the avatar on the shortcut itself and delivers the recognized draft on stop', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitSpeech, emitVoiceCommand } = fakeBridge()
    const finals: string[] = []
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, (text) => { finals.push(text) })
    })
    const mini = (): HTMLElement => container.querySelector('[data-testid="pixies-mini"]')!
    expect(mini().hasAttribute('data-listening')).toBe(false)

    act(() => { emitVoiceCommand({ type: 'start' }) })
    expect(mini().getAttribute('data-listening')).toBe('')
    expect(mini().getAttribute('aria-label')).toBe(defaultPixiesMessages.voiceCommandListening)
    expect(container.querySelector('[data-testid="pixies-listening-ring"]')).not.toBeNull()
    expect(container.querySelector('[data-pixies-shell]')?.getAttribute('data-listening')).toBe('')

    act(() => { emitSpeech({ type: 'partial', text: '打开设置' }) })
    act(() => { emitVoiceCommand({ type: 'stop' }) })
    expect(finals).toEqual(['打开设置'])
    expect(mini().hasAttribute('data-listening')).toBe(false)
    expect(container.querySelector('[data-testid="pixies-listening-ring"]')).toBeNull()

    act(() => { disposer?.() })
    container.remove()
  })

  it('ignores malformed wire payloads from the shortcut and speech-output channels', () => {
    const b = expandedBench()
    act(() => { b.bridge.emitVoiceCommand({ type: 'bogus' }) })
    act(() => { b.bridge.emitVoiceReply(null) })
    expect(b.container.querySelector('[data-testid="pixies-voice-error"]')).toBeNull()
    expect(b.voice().hasAttribute('data-speaking')).toBe(false)
    b.dispose()
  })

  it('speaks the newest assistant reply once without replaying existing history', () => {
    const store = createPixiesStore()
    speak(store, 'session-1#1', '旧回复')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, calls } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })
    expect(calls.filter(call => call.startsWith('speakReply:'))).toEqual([])

    act(() => { speak(store, 'session-1#2', '新回复') })
    expect(calls.filter(call => call.startsWith('speakReply:'))).toEqual(['speakReply:新回复'])
    act(() => { store.setInteraction({ kind: 'question', sessionId: '', summary: '还有吗' }) })
    expect(calls.filter(call => call.startsWith('speakReply:'))).toHaveLength(1)

    act(() => { disposer?.() })
    container.remove()
  })

  it('speaks a failed turn so a failure is not text-only', () => {
    const b = expandedBench()
    act(() => { b.store.appendMessage({ role: 'system', text: 'provider unavailable', mood: 'asking' }) })
    expect(b.bridge.calls).toContain('speakReply:provider unavailable')
    b.dispose()
  })

  it('muting cancels the current utterance and keeps later replies text-only', () => {
    const b = expandedBench()
    expect(b.voice().hasAttribute('data-muted')).toBe(false)
    fireEvent.click(b.voice())
    expect(b.bridge.calls).toContain('cancelReply')
    expect(b.voice().getAttribute('data-muted')).toBe('')

    act(() => { speak(b.store, 'session-1#3', '这条不念') })
    expect(b.bridge.calls.filter(call => call.startsWith('speakReply:'))).toEqual([])
    b.dispose()
  })

  it('shows the speaking state and a visible voice failure outside the reply bubble', () => {
    const b = expandedBench()
    act(() => { b.bridge.emitVoiceReply({ type: 'speaking' }) })
    expect(b.voice().getAttribute('data-speaking')).toBe('')
    expect(b.container.textContent).toContain(defaultPixiesMessages.statusSpeaking)

    act(() => { b.bridge.emitVoiceReply({ type: 'error', message: 'no voice' }) })
    expect(b.container.querySelector('[data-testid="pixies-voice-error"]')?.textContent)
      .toBe(`${defaultPixiesMessages.voiceFailed}: no voice`)
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    expect(b.voice().hasAttribute('data-speaking')).toBe(false)

    act(() => { b.bridge.emitVoiceReply({ type: 'done' }) })
    b.dispose()
  })
})
