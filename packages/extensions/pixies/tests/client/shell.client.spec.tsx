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
    } as unknown as SessionEventSource,
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

/** A minimal structural `ISessions`: a mutable list snapshot plus fixed bindings. */
function fakeSessions(
  state: SessionListState,
  bindings: ReadonlyMap<string, SessionEventSource>,
): { sessions: ISessions; setList: (next: SessionListState) => void; listListenerCount: () => number } {
  let current = state
  const listeners = new Set<() => void>()
  const sessions = {
    list: {
      getSnapshot: () => current,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    },
    binding: (id: string) => {
      const eventSource = bindings.get(id)
      if (eventSource === undefined) return undefined
      return { sessionId: id, eventSource }
    },
  } as unknown as ISessions
  return {
    sessions,
    setList: (next) => {
      current = next
      for (const listener of [...listeners]) listener()
    },
    listListenerCount: () => listeners.size,
  }
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
  it('binds the current session without replaying its history', () => {
    const store = createPixiesStore()
    const a = fakeEventSource([assistantMessage(1, '早上好')])
    const { sessions } = fakeSessions(listState(['a'], 'a'), new Map([['a', a.source]]))

    const follow = followPixiesSession(sessions, store)

    expect(store.getState().latest).toBeUndefined()
    expect(a.listenerCount()).toBe(1)
    follow.dispose()
  })

  it('feeds newly appended assistant messages and ignores other events', () => {
    const store = createPixiesStore()
    const a = fakeEventSource()
    const { sessions } = fakeSessions(listState(['a'], 'a'), new Map([['a', a.source]]))

    const follow = followPixiesSession(sessions, store)
    a.append(assistantMessage(1, '你好'))
    expect(store.getState().latest?.text).toBe('你好')
    expect(store.getState().latest?.sessionId).toBe('a')

    a.append(userMessage(2))
    expect(store.getState().latest?.text).toBe('你好')
    follow.dispose()
  })

  it('rebinds when the followed session changes and resets the watermark', () => {
    const store = createPixiesStore()
    const a = fakeEventSource()
    const b = fakeEventSource()
    const { sessions, setList } = fakeSessions(
      listState(['a'], 'a'),
      new Map([['a', a.source], ['b', b.source]]),
    )

    const follow = followPixiesSession(sessions, store)
    a.append(assistantMessage(1, '第一条'))
    expect(store.getState().latest?.text).toBe('第一条')

    setList(listState(['a', 'b'], 'b'))
    expect(a.listenerCount()).toBe(0)
    expect(b.listenerCount()).toBe(1)

    // Session b's own log starts over, so a seq below session a's watermark still feeds.
    b.append(assistantMessage(7, '新会话'))
    expect(store.getState().latest?.text).toBe('新会话')
    expect(store.getState().latest?.sessionId).toBe('b')
    follow.dispose()
  })

  it('waits for the list to expose a bindable session', () => {
    const store = createPixiesStore()
    const a = fakeEventSource()
    const { sessions, setList } = fakeSessions(listState([], undefined), new Map([['a', a.source]]))

    const follow = followPixiesSession(sessions, store)
    expect(a.listenerCount()).toBe(0)

    setList(listState(['a'], undefined))
    expect(a.listenerCount()).toBe(1)

    a.append(assistantMessage(1, '你好'))
    expect(store.getState().latest?.text).toBe('你好')
    follow.dispose()
  })

  it('dispose releases the list and event subscriptions', () => {
    const store = createPixiesStore()
    const a = fakeEventSource()
    const b = fakeEventSource()
    const { sessions, setList, listListenerCount } = fakeSessions(
      listState(['a'], 'a'),
      new Map([['a', a.source], ['b', b.source]]),
    )

    const follow = followPixiesSession(sessions, store)
    expect(listListenerCount()).toBe(1)

    follow.dispose()
    expect(listListenerCount()).toBe(0)
    expect(a.listenerCount()).toBe(0)

    setList(listState(['a', 'b'], 'b'))
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

  it('defaults to the shell interaction copy', () => {
    expect(defaultPixiesMessages.approval).toBe('Pixies needs your approval')
    expect(defaultPixiesMessages.question).toBe('Pixies has a question')
    expect(defaultPixiesMessages.expand).toBe('Expand Pixies')
    expect(defaultPixiesMessages.mic).toBe('Speak')
    expect(defaultPixiesMessages.collapse).toBe('Collapse')
    expect(defaultPixiesMessages.speechFailed).toBe('Voice input failed')
  })
})

/** A recording fake of the Electron preload bridge. */
function fakeBridge(): {
  bridge: PixiesShellBridge
  calls: string[]
  emitMode: (mode: PixiesShellMode) => void
  emitSpeech: (event: PixiesShellSpeechEvent) => void
  speechListenerCount: () => number
  modeListenerCount: () => number
} {
  const calls: string[] = []
  const speechListeners: Array<(event: PixiesShellSpeechEvent) => void> = []
  const modeListeners: Array<(mode: PixiesShellMode) => void> = []
  const remove = <T,>(list: T[], item: T): void => {
    const index = list.indexOf(item)
    if (index >= 0) list.splice(index, 1)
  }
  const bridge: PixiesShellBridge = {
    expand: () => { calls.push('expand') },
    collapse: () => { calls.push('collapse') },
    startSpeech: () => { calls.push('startSpeech') },
    stopSpeech: () => { calls.push('stopSpeech') },
    onSpeech: (listener) => {
      speechListeners.push(listener)
      return () => { remove(speechListeners, listener) }
    },
    onMode: (listener) => {
      modeListeners.push(listener)
      return () => { remove(modeListeners, listener) }
    },
  }
  return {
    bridge,
    calls,
    emitMode: (mode) => { for (const listener of [...modeListeners]) listener(mode) },
    emitSpeech: (event) => { for (const listener of [...speechListeners]) listener(event) },
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

describe('promptPixiesSession (phase 3 / phase 5)', () => {
  /** A recording fake: `created` collects each `create()`, `prompts` each `prompt()`. */
  function sessionsWithPrompt(
    prompts: Array<{ content: unknown; mode: string }>,
    opts: { state?: SessionListState; created?: string[]; bindingFor?: (id: string) => boolean } = {},
  ): ISessions {
    const created = opts.created ?? []
    const bound = opts.bindingFor ?? (() => true)
    return {
      list: {
        getSnapshot: () => opts.state ?? listState(['a'], 'a'),
        subscribe: () => () => {},
      },
      create: async (): Promise<string> => {
        created.push('created-1')
        return 'created-1'
      },
      binding: (id: string) => {
        if (!bound(id)) return undefined
        return {
          sessionId: id,
          session: {
            prompt: (content: unknown, mode: string): Promise<unknown> => {
              prompts.push({ content, mode })
              return Promise.resolve({ accepted: true })
            },
          },
        }
      },
    } as unknown as ISessions
  }

  it('sends the transcript as a queued text prompt to the followed session', async () => {
    const prompts: Array<{ content: unknown; mode: string }> = []
    const created: string[] = []
    await promptPixiesSession(sessionsWithPrompt(prompts, { created }), '帮我看一下这段代码')

    expect(prompts).toEqual([{ content: [{ type: 'text', text: '帮我看一下这段代码' }], mode: 'queue' }])
    expect(created).toEqual([])
  })

  it('creates the session when the profile has none, then prompts it', async () => {
    const prompts: Array<{ content: unknown; mode: string }> = []
    const created: string[] = []
    await promptPixiesSession(
      sessionsWithPrompt(prompts, { state: listState([], undefined), created }),
      '哈喽',
    )

    expect(created).toEqual(['created-1'])
    expect(prompts).toEqual([{ content: [{ type: 'text', text: '哈喽' }], mode: 'queue' }])
  })

  it('creates the session when the selected one has no binding', async () => {
    const prompts: Array<{ content: unknown; mode: string }> = []
    const created: string[] = []
    await promptPixiesSession(
      sessionsWithPrompt(prompts, { created, bindingFor: id => id !== 'a' }),
      '仍然要送达',
    )

    expect(created).toEqual(['created-1'])
    expect(prompts).toEqual([{ content: [{ type: 'text', text: '仍然要送达' }], mode: 'queue' }])
  })

  it('drops blank text without creating a session', async () => {
    const prompts: Array<{ content: unknown; mode: string }> = []
    const created: string[] = []
    await promptPixiesSession(sessionsWithPrompt(prompts, { created }), '   ')

    expect(created).toEqual([])
    expect(prompts).toEqual([])
  })
})
