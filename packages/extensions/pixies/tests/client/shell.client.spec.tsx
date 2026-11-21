/**
 * @vitest-environment jsdom
 *
 * Shell-surface tests (test-validation phase2c method 6): session picking,
 * the follow feed's watermark/rebind semantics, and the full-window mount
 * that stays live from the store.
 */
import { act, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  ISessions,
  SessionEventChange,
  SessionEventLikeEntry,
  SessionEventSource,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createPixiesStore } from '../../src/client/store.ts'
import { feedSessionEvent } from '../../src/client/feed.ts'
import {
  cancelPixiesSession,
  createPixiesSessionSelection,
  defaultPixiesMessages,
  followPixiesSession,
  mountPixiesShell,
  pickPixiesSessionId,
  promptPixiesSession,
} from '../../src/client/shell.tsx'
import type {
  PixiesSessionPanel,
  PixiesShellBridge,
  PixiesShellMode,
  PixiesShellSpeechEvent,
} from '../../src/client/shell.tsx'

/** Branded session ids in compact test fixtures. */
const sid = (value: string): SessionId => value as unknown as SessionId

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

/** One client-only live reasoning chunk on the transient seq axis. */
function reasoningChunk(seq: number, text: string): SessionEventLikeEntry {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq,
      time: 0,
      data: {
        attemptId: 'attempt-1',
        turn: 1,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text },
      },
    },
  } as unknown as SessionEventLikeEntry
}

/** A catalog fixture with morning, afternoon, and older sessions. */
function sessionPanelFixture(opts: {
  createError?: Error
  createBlocker?: Promise<void>
  removeError?: Error
  removeBlocker?: Promise<void>
  hiddenIds?: readonly string[]
} = {}): {
  panel: PixiesSessionPanel
  selected: string[]
  created: SessionId[]
  removed: string[]
  hidden: string[]
  setIds: (ids: readonly string[]) => void
} {
  const today = new Date()
  const at = (hour: number, dayOffset: number): number => {
    const date = new Date(today)
    date.setDate(date.getDate() + dayOffset)
    date.setHours(hour, 0, 0, 0)
    return date.getTime()
  }
  const summaries = {
    a: { id: sid('a'), displayTitle: '上午的会话', running: false, blank: false, retainedBy: {}, updatedAt: at(9, 0) },
    b: { id: sid('b'), displayTitle: '下午的会话', running: true, blank: false, retainedBy: {}, updatedAt: at(15, 0) },
    c: { id: sid('c'), displayTitle: '更早的会话', running: false, blank: false, retainedBy: {}, updatedAt: at(9, -1) },
  }
  let state = {
    // A catalog id without a projected row must be skipped, not rendered blank.
    ids: [sid('a'), sid('b'), sid('c'), sid('ghost')],
    byId: summaries,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
  } as unknown as SessionListState
  const listeners = new Set<() => void>()
  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const selected: string[] = []
  const created: SessionId[] = []
  const removed: string[] = []
  const hidden: string[] = [...(opts.hiddenIds ?? [])]
  let currentSelected = sid('a')
  const panel: PixiesSessionPanel = {
    getSnapshot: () => state,
    hiddenIds: () => hidden.map(sid),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    selectedId: () => currentSelected,
    select: (id) => {
      selected.push(id)
      currentSelected = id
      publish()
    },
    create: async () => {
      if (opts.createBlocker !== undefined) await opts.createBlocker
      if (opts.createError !== undefined) throw opts.createError
      const id = sid(`created-${String(created.length + 1)}`)
      created.push(id)
      // The real service publishes the catalog row before resolving, so the
      // selection switch can address the new id immediately.
      const summary = {
        id, displayTitle: '新建的会话', running: false, blank: true, retainedBy: {}, updatedAt: Date.now(),
      }
      state = {
        ...state,
        ids: [id, ...state.ids],
        byId: { ...state.byId, [id]: summary },
      }
      currentSelected = id
      publish()
      return id
    },
    remove: async (id) => {
      removed.push(id)
      if (opts.removeBlocker !== undefined) await opts.removeBlocker
      if (opts.removeError !== undefined) throw opts.removeError
      hidden.push(id)
      if (currentSelected === id) {
        const next = state.ids.find(candidate => candidate !== id && !hidden.includes(candidate))
        if (next !== undefined) currentSelected = next
      }
      publish()
    },
  }
  return {
    panel,
    selected,
    created,
    removed,
    hidden,
    setIds: (ids) => {
      const byId: Record<string, unknown> = {}
      for (const id of ids) {
        const summary = summaries[id as keyof typeof summaries]
        if (summary !== undefined) byId[sid(id)] = summary
      }
      state = { ...state, ids: ids.map(sid), byId } as unknown as SessionListState
      publish()
    },
  }
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

/** One durable human-authored prompt, foldable when replaying a session. */
function humanMessage(seq: number, text: string): SessionEventLikeEntry {
  return {
    type: 'event',
    event: {
      type: 'user/message',
      seq,
      time: 0,
      data: {
        id: `user-${String(seq)}`, role: 'user',
        content: [{ type: 'text', text }], source: { kind: 'user' },
      },
    },
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

  it('prefers a listed shell choice over the catalog preference', () => {
    expect(pickPixiesSessionId(listState(['a', 'b'], 'a'), sid('b'))).toBe('b')
  })

  it('ignores a shell choice that is no longer listed', () => {
    expect(pickPixiesSessionId(listState(['a'], 'a'), sid('gone'))).toBe('a')
  })
})

describe('createPixiesSessionSelection', () => {
  it('notifies subscribers on every choice, including a repeated one', () => {
    const selection = createPixiesSessionSelection()
    let calls = 0
    const off = selection.subscribe(() => { calls += 1 })
    expect(selection.get()).toBeUndefined()
    selection.set(sid('a'))
    selection.set(sid('a'))
    expect(calls).toBe(2)
    expect(selection.get()).toBe('a')
    off()
    selection.set(sid('b'))
    expect(calls).toBe(2)
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

  it('forwards client-only reasoning chunks without replaying them', async () => {
    const store = createPixiesStore()
    const a = fakeEventSource()
    const { sessions } = fakeSessions(listState(['a'], 'a'), new Map([['a', a.source]]))

    const follow = followPixiesSession(sessions, store)
    await flushFollow()
    a.append(reasoningChunk(3.1, '先看'))
    a.append(reasoningChunk(3.2, '再查'))
    expect(store.getState().thinking).toEqual({ sessionId: 'a', text: '先看再查', active: true })

    // A transient row from the initial window is not replayed on settlement.
    a.append(reasoningChunk(3.1, '重复'))
    expect(store.getState().thinking?.text).toBe('先看再查')
    follow.dispose()
  })

  it('keeps transient and durable watermarks on separate axes', async () => {
    const store = createPixiesStore()
    const a = fakeEventSource()
    const { sessions } = fakeSessions(listState(['a'], 'a'), new Map([['a', a.source]]))

    const follow = followPixiesSession(sessions, store)
    await flushFollow()
    a.append(reasoningChunk(8.5, '推理'))
    a.append(assistantMessage(2, '答案'))
    expect(store.getState().latest?.text).toBe('答案')
    expect(store.getState().thinking?.active).toBe(false)
    follow.dispose()
  })

  it('rebinds when the shell selects a different session', async () => {
    const store = createPixiesStore()
    const selection = createPixiesSessionSelection()
    const a = fakeEventSource()
    const b = fakeEventSource()
    const { sessions, retainCount } = fakeSessions(
      listState(['a', 'b'], 'a'),
      new Map([['a', a.source], ['b', b.source]]),
    )

    const follow = followPixiesSession(sessions, store, selection)
    await flushFollow()
    expect(retainCount('a')).toBe(1)

    selection.set(sid('b'))
    await flushFollow()
    expect(a.listenerCount()).toBe(0)
    expect(retainCount('a')).toBe(0)
    expect(retainCount('b')).toBe(1)

    b.append(assistantMessage(1, '新会话'))
    expect(store.getState().latest?.sessionId).toBe('b')
    follow.dispose()
  })

  it('replays the selected session history instead of leaving the conversation blank', async () => {
    const store = createPixiesStore()
    const selection = createPixiesSessionSelection()
    const a = fakeEventSource()
    const b = fakeEventSource([humanMessage(1, '之前的问题'), assistantMessage(2, '之前的回答')])
    const { sessions } = fakeSessions(
      listState(['a', 'b'], 'a'),
      new Map([['a', a.source], ['b', b.source]]),
    )

    const follow = followPixiesSession(sessions, store, selection)
    await flushFollow()
    expect(store.getState().messages).toEqual([])

    selection.set(sid('b'))
    await flushFollow()
    expect(store.getState().messages.map(message => message.text)).toEqual(['之前的问题', '之前的回答'])
    expect(store.getState().messages.every(message => message.historical === true)).toBe(true)
    expect(store.getState().latest).toBeUndefined()

    b.append(assistantMessage(3, '实时补充'))
    expect(store.getState().messages.at(-1)?.text).toBe('实时补充')
    expect(store.getState().messages.at(-1)?.historical).toBeUndefined()
    follow.dispose()
  })

  it('seeds transient rows already in the initial window', async () => {
    const store = createPixiesStore()
    const a = fakeEventSource([reasoningChunk(2.5, '已有')])
    const { sessions } = fakeSessions(listState(['a'], 'a'), new Map([['a', a.source]]))

    const follow = followPixiesSession(sessions, store)
    await flushFollow()
    a.append(reasoningChunk(2.4, '过期'))
    a.append(reasoningChunk(2.6, '新增'))
    expect(store.getState().thinking?.text).toBe('新增')
    follow.dispose()
  })

  it('stops following selection changes after dispose', async () => {
    const store = createPixiesStore()
    const selection = createPixiesSessionSelection()
    const a = fakeEventSource()
    const b = fakeEventSource()
    const { sessions, retainCount } = fakeSessions(
      listState(['a', 'b'], 'a'),
      new Map([['a', a.source], ['b', b.source]]),
    )

    const follow = followPixiesSession(sessions, store, selection)
    await flushFollow()
    follow.dispose()
    selection.set(sid('b'))
    await flushFollow()
    expect(retainCount('b')).toBe(0)
  })
})

describe('mountPixiesShell', () => {
  it('renders assistant Markdown and delegates its links, while user text stays literal', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, calls, emitMode } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })
    act(() => { emitMode('expanded') })

    act(() => {
      store.appendMessage({ role: 'user', text: '**原样**的用户输入' })
      store.speak({
        id: 'session-1#md', sessionId: 'session-1', character: 'spider-man',
        kind: 'speech', mood: 'neutral', text: '## 结论\n\n- 第一点\n- [文档](https://example.com)', seq: 2,
      })
    })
    const bubble = container.querySelector('[data-testid="pixies-bubble"]')
    expect(bubble?.querySelector('h2')?.textContent).toBe('结论')
    expect(bubble?.querySelectorAll('li')).toHaveLength(2)
    const link = bubble?.querySelector('a') as HTMLAnchorElement | null
    expect(link?.textContent).toContain('文档')
    act(() => { link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    expect(calls.some(call => call.startsWith('openExternal:'))).toBe(true)
    expect(container.textContent).toContain('**原样**的用户输入')

    act(() => { disposer?.() })
    container.remove()
  })

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
  iconCalls: string[]
} {
  const calls: string[] = []
  const iconCalls: string[] = []
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
    hide: () => { iconCalls.push('hide') },
    dismissAutoIcon: () => { iconCalls.push('dismissAutoIcon') },
    openExternal: (url) => { calls.push(`openExternal:${url}`) },
  }
  return {
    bridge,
    calls,
    iconCalls,
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
    // A delivered transcript now waits for the agent: the work group reports
    // the running turn instead of a separate thinking bubble.
    expect(container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    expect(container.querySelector('[data-testid="pixies-work-title"]')?.textContent)
      .toBe(defaultPixiesMessages.thinking)

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

  it('reports thinking in the work group and switches its label once settled', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })
    act(() => { emitMode('expanded') })
    // No separate thinking bubble, and no group before anything happens.
    expect(container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    expect(container.querySelector('[data-testid="pixies-work-group"]')).toBeNull()

    act(() => { store.appendThinking('s', '先看项目') })
    const group = (): Element => container.querySelector('[data-testid="pixies-work-group"]')!
    const title = (): string => group().querySelector('[data-testid="pixies-work-title"]')?.textContent ?? ''
    const toggle = (): Element => group().querySelector('[data-testid="pixies-work-toggle"]')!
    expect(group().hasAttribute('data-active')).toBe(true)
    expect(title()).toBe(defaultPixiesMessages.thinking)
    expect(group().textContent).toContain(defaultPixiesMessages.thinkingStreaming)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().getAttribute('aria-label')).toBe(defaultPixiesMessages.showProcess)
    expect(group().querySelector('[data-testid="pixies-work-items"]')).toBeNull()

    fireEvent.click(toggle())
    const row = (): Element => group().querySelector('[data-testid="pixies-process-row"]')!
    expect(row().getAttribute('data-kind')).toBe('thinking')
    fireEvent.click(row().querySelector('[data-testid="pixies-process-toggle"]')!)
    expect(row().querySelector('[data-testid="pixies-process-body"]')?.textContent).toBe('先看项目')

    act(() => { store.appendThinking('s', '再查日志') })
    expect(row().querySelector('[data-testid="pixies-process-body"]')?.textContent)
      .toBe('先看项目再查日志')

    act(() => { store.settleThinking('s', '先看项目，再查日志') })
    expect(group().hasAttribute('data-active')).toBe(false)
    expect(title()).toBe(defaultPixiesMessages.thinkingProcess)
    expect(group().textContent).toContain(defaultPixiesMessages.thinkingDone)
    expect(container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    act(() => { disposer?.() })
    container.remove()
  })

  it('opens history as an overlay popup that never takes a conversation slot', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode } = fakeBridge()
    const { panel, setIds } = sessionPanelFixture()
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, undefined, panel)
    })
    act(() => { emitMode('expanded') })
    act(() => {
      store.appendMessage({ role: 'user', text: '帮我查一下' })
      store.appendMessage({ role: 'assistant', text: '收到' })
      store.appendMessage({ role: 'system', text: 'turn 失败' })
    })

    const toggle = (): Element => container.querySelector('[data-testid="pixies-history-toggle"]')!
    const backdrop = (): Element | null => container.querySelector('[data-testid="pixies-history-backdrop"]')
    const drawer = (): Element => container.querySelector('[data-testid="pixies-history-panel"]')!
    expect(backdrop()).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[role="log"]')).not.toBeNull()

    fireEvent.click(toggle())
    expect((backdrop() as HTMLElement).style.position).toBe('absolute')
    expect(container.querySelector('[role="log"]')).not.toBeNull()
    expect(drawer().textContent).toContain(defaultPixiesMessages.groupMorning)
    expect(drawer().textContent).toContain(defaultPixiesMessages.groupAfternoon)
    expect(drawer().textContent).toContain(defaultPixiesMessages.groupEarlier)
    const rows = drawer().querySelectorAll('[data-testid="pixies-session-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.hasAttribute('data-active')).toBe(true)
    const contextRows = drawer().querySelectorAll('[data-testid="pixies-context-row"]')
    expect(contextRows).toHaveLength(3)
    expect(contextRows[0]?.textContent).toContain(defaultPixiesMessages.roleUser)
    expect(contextRows[1]?.textContent).toContain(defaultPixiesMessages.roleAssistant)
    expect(contextRows[2]?.textContent).toContain(defaultPixiesMessages.roleSystem)
    expect(drawer().querySelector('[data-testid="pixies-new-session"]')).toBeNull()
    expect(container.querySelector('[data-testid="pixies-new-session"]')).not.toBeNull()

    fireEvent.click(backdrop()!)
    expect(backdrop()).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(backdrop()).toBeNull()

    fireEvent.click(toggle())
    fireEvent.click(container.querySelector('[data-testid="pixies-history-close"]')!)
    expect(backdrop()).toBeNull()

    act(() => { setIds(['a', 'b']) })
    fireEvent.click(toggle())
    expect(drawer().querySelectorAll('[data-testid="pixies-session-row"]')).toHaveLength(2)
    act(() => { disposer?.() })
    container.remove()
  })

  it('returns to the conversation after picking a session from the popup', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode } = fakeBridge()
    const { panel, selected } = sessionPanelFixture()
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, undefined, panel)
    })
    act(() => { emitMode('expanded') })
    act(() => { store.appendMessage({ role: 'user', text: '上一轮问题' }) })
    const toggle = (): Element => container.querySelector('[data-testid="pixies-history-toggle"]')!
    fireEvent.click(toggle())
    const rows = container.querySelectorAll('[data-testid="pixies-session-row"]')
    fireEvent.click(rows[1]!)
    expect(selected).toEqual(['b'])
    expect(container.querySelector('[data-testid="pixies-history-backdrop"]')).toBeNull()
    expect(store.getState().messages).toEqual([])
    fireEvent.click(toggle())
    expect(container.querySelectorAll('[data-testid="pixies-session-row"]')[1]?.hasAttribute('data-active')).toBe(true)
    act(() => { disposer?.() })
    container.remove()
  })

  it('creates a fresh session from the always-visible header action', async () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode } = fakeBridge()
    let unblock: (() => void) | undefined
    const blocker = new Promise<void>((resolve) => { unblock = () => { resolve() } })
    const { panel, created } = sessionPanelFixture({ createBlocker: blocker })
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, undefined, panel)
    })
    act(() => { emitMode('expanded') })
    act(() => { store.appendMessage({ role: 'user', text: '上一轮问题' }) })
    expect(container.querySelector('[data-testid="pixies-history-backdrop"]')).toBeNull()

    const button = (): HTMLButtonElement => container.querySelector('[data-testid="pixies-new-session"]')!
    expect(button().textContent).toBe(defaultPixiesMessages.newSessionShort)
    expect(button().getAttribute('aria-label')).toBe(defaultPixiesMessages.newSession)
    await act(async () => { fireEvent.click(button()) })
    expect(button().disabled).toBe(true)
    expect(button().textContent).toBe(defaultPixiesMessages.newSessionPending)
    fireEvent.click(button())
    expect(created).toEqual([])

    await act(async () => { unblock?.() })
    expect(created).toEqual([sid('created-1')])
    expect(button().disabled).toBe(false)
    expect(button().textContent).toBe(defaultPixiesMessages.newSessionShort)
    expect(store.getState().messages).toEqual([])
    expect(container.querySelector('[data-testid="pixies-new-session-error"]')).toBeNull()
    fireEvent.click(container.querySelector('[data-testid="pixies-history-toggle"]')!)
    const fresh = [...container.querySelectorAll('[data-testid="pixies-session-row"]')]
      .find(row => row.textContent?.includes('新建的会话'))
    expect(fresh?.hasAttribute('data-active')).toBe(true)
    act(() => { disposer?.() })
    container.remove()
  })

  it('keeps the conversation and reports a failed session creation outside the popup', async () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode } = fakeBridge()
    const { panel } = sessionPanelFixture({ createError: new Error('host refused') })
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, undefined, panel)
    })
    act(() => { emitMode('expanded') })
    act(() => { store.appendMessage({ role: 'user', text: '上一轮问题' }) })
    fireEvent.click(container.querySelector('[data-testid="pixies-history-toggle"]')!)
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="pixies-new-session"]')!)
    })
    expect(container.querySelector('[data-testid="pixies-history-backdrop"]')).toBeNull()
    const error = container.querySelector('[data-testid="pixies-new-session-error"]')?.textContent
    expect(error).toContain(defaultPixiesMessages.newSessionFailed)
    expect(error).toContain('host refused')
    expect(store.getState().messages).toHaveLength(1)
    const button = container.querySelector('[data-testid="pixies-new-session"]') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe(defaultPixiesMessages.newSessionShort)
    act(() => { disposer?.() })
    container.remove()
  })

  it('asks for a second confirmation before removing a session row', async () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode } = fakeBridge()
    const { panel, selected, removed } = sessionPanelFixture()
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, undefined, panel)
    })
    act(() => { emitMode('expanded') })
    fireEvent.click(container.querySelector('[data-testid="pixies-history-toggle"]')!)

    const deletes = (): Element[] => [...container.querySelectorAll('[data-testid="pixies-session-delete"]')]
    const confirm = (): Element | null => container.querySelector('[data-testid="pixies-session-delete-confirm"]')
    expect(deletes()).toHaveLength(3)
    fireEvent.click(deletes()[1]!)
    expect(confirm()?.textContent).toContain(defaultPixiesMessages.deleteSessionConfirm)
    expect(removed).toEqual([])
    expect(selected).toEqual([])

    fireEvent.click(container.querySelector('[data-testid="pixies-session-delete-cancel"]')!)
    expect(confirm()).toBeNull()
    expect(removed).toEqual([])

    fireEvent.click(deletes()[1]!)
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="pixies-session-delete-accept"]')!)
    })
    expect(removed).toEqual([sid('b')])
    expect(confirm()).toBeNull()
    expect(container.querySelectorAll('[data-testid="pixies-session-row"]')).toHaveLength(2)
    expect(selected).toEqual([])
    act(() => { disposer?.() })
    container.remove()
  })

  it('hides archived sessions and moves the follow off a deleted current session', async () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode } = fakeBridge()
    const { panel, removed } = sessionPanelFixture({ hiddenIds: ['c'] })
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, undefined, panel)
    })
    act(() => { emitMode('expanded') })
    fireEvent.click(container.querySelector('[data-testid="pixies-history-toggle"]')!)
    const rows = (): Element[] => [...container.querySelectorAll('[data-testid="pixies-session-row"]')]
    expect(rows()).toHaveLength(2)
    expect(rows().some(row => row.getAttribute('aria-label') === '更早的会话')).toBe(false)
    expect(rows()[0]?.hasAttribute('data-active')).toBe(true)

    fireEvent.click(container.querySelectorAll('[data-testid="pixies-session-delete"]')[0]!)
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="pixies-session-delete-accept"]')!)
    })
    expect(removed).toEqual([sid('a')])
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.getAttribute('aria-label')).toBe('下午的会话')
    expect(rows()[0]?.hasAttribute('data-active')).toBe(true)
    act(() => { disposer?.() })
    container.remove()
  })

  it('reports a failed removal without hiding the row', async () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode } = fakeBridge()
    const { panel, removed } = sessionPanelFixture({ removeError: new Error('archive refused') })
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, undefined, panel)
    })
    act(() => { emitMode('expanded') })
    fireEvent.click(container.querySelector('[data-testid="pixies-history-toggle"]')!)
    fireEvent.click(container.querySelectorAll('[data-testid="pixies-session-delete"]')[1]!)
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="pixies-session-delete-accept"]')!)
    })
    expect(container.querySelector('[data-testid="pixies-session-delete-error"]')?.textContent)
      .toContain('archive refused')
    expect(container.querySelectorAll('[data-testid="pixies-session-row"]')).toHaveLength(3)
    expect(removed).toEqual([sid('b')])
    expect(container.querySelector('[data-testid="pixies-session-delete-confirm"]')).toBeNull()
    act(() => { disposer?.() })
    container.remove()
  })

  it('disables delete actions while a removal is in flight', async () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode } = fakeBridge()
    let unblock: (() => void) | undefined
    const blocker = new Promise<void>((resolve) => { unblock = () => { resolve() } })
    const { panel, removed } = sessionPanelFixture({ removeBlocker: blocker })
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, undefined, panel)
    })
    act(() => { emitMode('expanded') })
    fireEvent.click(container.querySelector('[data-testid="pixies-history-toggle"]')!)
    fireEvent.click(container.querySelectorAll('[data-testid="pixies-session-delete"]')[0]!)
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="pixies-session-delete-accept"]')!)
    })
    const button = (): HTMLButtonElement => container.querySelector('[data-testid="pixies-session-delete"]')!
    expect(button().disabled).toBe(true)
    expect(removed).toEqual([sid('a')])
    await act(async () => { unblock?.() })
    expect(button().disabled).toBe(false)
    expect(container.querySelectorAll('[data-testid="pixies-session-row"]')).toHaveLength(2)
    act(() => { disposer?.() })
    container.remove()
  })

  it('hides the icon from the right-click menu in both window modes', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, iconCalls, emitMode } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })
    const shell = (): Element => container.querySelector('[data-pixies-shell]')!
    expect(container.querySelector('[data-testid="pixies-icon-menu"]')).toBeNull()

    fireEvent.contextMenu(shell())
    expect(container.querySelector('[data-testid="pixies-icon-menu"]')?.textContent)
      .toContain(defaultPixiesMessages.hideIcon)
    fireEvent.click(container.querySelector('[data-testid="pixies-icon-hide"]')!)
    expect(iconCalls).toEqual(['hide'])
    expect(container.querySelector('[data-testid="pixies-icon-menu"]')).toBeNull()

    act(() => { emitMode('expanded') })
    fireEvent.contextMenu(shell())
    expect(container.querySelector('[data-testid="pixies-icon-menu"]')).not.toBeNull()
    fireEvent.click(container.querySelector('[data-testid="pixies-icon-hide"]')!)
    expect(iconCalls).toEqual(['hide', 'hide'])
    act(() => { disposer?.() })
    container.remove()
  })

  it('closes the icon menu on an outside click without hiding the icon', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, iconCalls } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })
    fireEvent.contextMenu(container.querySelector('[data-pixies-shell]')!)
    expect(container.querySelector('[data-testid="pixies-icon-menu"]')).not.toBeNull()
    fireEvent.click(container.querySelector('[data-testid="pixies-icon-menu-backdrop"]')!)
    expect(container.querySelector('[data-testid="pixies-icon-menu"]')).toBeNull()
    expect(iconCalls).toEqual([])
    act(() => { disposer?.() })
    container.remove()
  })

  it('dismisses a shortcut-shown icon when an empty voice round ends', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, iconCalls, emitVoiceCommand } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })
    act(() => { emitVoiceCommand({ type: 'start' }) })
    expect(iconCalls).toEqual([])
    act(() => { emitVoiceCommand({ type: 'stop' }) })
    expect(iconCalls).toEqual(['dismissAutoIcon'])
    act(() => { disposer?.() })
    container.remove()
  })

  it('keeps the icon through listening, thinking and playback before dismissing', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, iconCalls, emitVoiceCommand, emitSpeech, emitVoiceReply } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })
    act(() => { emitVoiceCommand({ type: 'start' }) })
    act(() => { emitSpeech({ type: 'final', text: '你好' }) })
    expect(iconCalls).toEqual([])
    act(() => { emitVoiceReply({ type: 'speaking' }) })
    act(() => { store.appendMessage({ role: 'assistant', text: '你好呀' }) })
    expect(iconCalls).toEqual([])
    act(() => { emitVoiceReply({ type: 'done' }) })
    expect(iconCalls).toEqual(['dismissAutoIcon'])
    act(() => { disposer?.() })
    container.remove()
  })

  it('does not offer the icon menu outside the Electron shell', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, undefined) })
    fireEvent.contextMenu(container.querySelector('[data-pixies-shell]')!)
    expect(container.querySelector('[data-testid="pixies-icon-menu"]')).toBeNull()
    act(() => { disposer?.() })
    container.remove()
  })

  it('shows an empty-catalog note without a sessions face', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitMode } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })
    act(() => { emitMode('expanded') })
    fireEvent.click(container.querySelector('[data-testid="pixies-history-toggle"]')!)
    const popup = container.querySelector('[data-testid="pixies-history-panel"]')
    expect(popup?.textContent).toContain(defaultPixiesMessages.noSessions)
    expect(popup?.querySelector('[data-testid="pixies-new-session"]')).toBeNull()
    expect((container.querySelector('[data-testid="pixies-new-session"]') as HTMLButtonElement).disabled).toBe(true)
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

  it('prompts the shell-selected session instead of the catalog head', async () => {
    const prompts: UsingRecord[] = []
    const { sessions } = sessionsWithUsing(prompts, { state: listState(['a', 'b'], 'a') })
    const selection = createPixiesSessionSelection()
    selection.set(sid('b'))

    await promptPixiesSession(sessions, '切换后的提问', selection)

    expect(prompts).toEqual([{ id: 'b', content: [{ type: 'text', text: '切换后的提问' }], mode: 'queue' }])
  })

  it('falls back to the catalog head when the shell choice is no longer listed', async () => {
    const prompts: UsingRecord[] = []
    const { sessions } = sessionsWithUsing(prompts, { state: listState(['a'], 'a') })
    const selection = createPixiesSessionSelection()
    selection.set(sid('gone'))

    await promptPixiesSession(sessions, '仍然送达', selection)

    expect(prompts[0]?.id).toBe('a')
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

describe('cancelPixiesSession (shortcut stop / replace)', () => {
  interface CancelRecord { id: string }

  /** A retained-reference fake with an optional cancel response. */
  function sessionsWithCancel(opts: {
    state?: SessionListState
    response?: () => { ok: boolean; error?: { code: string; message: string } }
  } = {}): {
    sessions: ISessions
    cancels: CancelRecord[]
    created: string[]
    usingIds: string[]
  } {
    const cancels: CancelRecord[] = []
    const created: string[] = []
    const usingIds: string[] = []
    const sessions = {
      list: {
        getSnapshot: () => opts.state ?? listState(['a'], 'a'),
        subscribe: () => () => {},
      },
      create: async (): Promise<string> => {
        const id = `created-${created.length + 1}`
        created.push(id)
        return id
      },
      using: async (id: string, _options: unknown, operation: (reference: unknown) => unknown) => {
        usingIds.push(id)
        const response = opts.response?.() ?? { ok: true }
        const reference = {
          ready: Promise.resolve(),
          binding: {
            sessionId: id,
            session: {
              cancel: (): Promise<unknown> => {
                cancels.push({ id })
                return Promise.resolve(response)
              },
            },
          },
        }
        return await operation(reference)
      },
    } as unknown as ISessions
    return { sessions, cancels, created, usingIds }
  }

  it('cancels the followed session through a retained reference', async () => {
    const { sessions, cancels, created, usingIds } = sessionsWithCancel()

    await cancelPixiesSession(sessions)

    expect(cancels).toEqual([{ id: 'a' }])
    expect(usingIds).toEqual(['a'])
    expect(created).toEqual([])
  })

  it('cancels the shell-selected session', async () => {
    const { sessions, cancels } = sessionsWithCancel({ state: listState(['a', 'b'], 'a') })
    const selection = createPixiesSessionSelection()
    selection.set(sid('b'))

    await cancelPixiesSession(sessions, selection)

    expect(cancels).toEqual([{ id: 'b' }])
  })

  it('does nothing when the profile has no session', async () => {
    const { sessions, cancels, usingIds } = sessionsWithCancel({ state: listState([], undefined) })

    await cancelPixiesSession(sessions)

    expect(cancels).toEqual([])
    expect(usingIds).toEqual([])
  })

  it('treats an unattached agent as already idle', async () => {
    const { sessions } = sessionsWithCancel({
      response: () => ({ ok: false, error: { code: 'session/not-found', message: 'not attached' } }),
    })

    await expect(cancelPixiesSession(sessions)).resolves.toBeUndefined()
  })

  it('surfaces other cancel failures', async () => {
    const { sessions } = sessionsWithCancel({
      response: () => ({ ok: false, error: { code: 'transport', message: 'host down' } }),
    })

    await expect(cancelPixiesSession(sessions)).rejects.toThrow('transport: host down')
  })
})

describe('voice-command modes and task stop', () => {
  /** Mount with both the transcript and cancel callbacks recorded. */
  function modeBench(): {
    store: ReturnType<typeof createPixiesStore>
    container: HTMLElement
    bridge: ReturnType<typeof fakeBridge>
    cancel: ReturnType<typeof vi.fn>
    finals: string[]
    listening: () => boolean
    dispose: () => void
  } {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const bridge = fakeBridge()
    const cancel = vi.fn()
    const finals: string[] = []
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(
        container, store, defaultPixiesMessages, bridge.bridge,
        (text) => { finals.push(text) }, undefined, cancel,
      )
    })
    return {
      store, container, bridge, cancel, finals,
      listening: () => container.querySelector('[data-testid="pixies-mini"]')!.hasAttribute('data-listening'),
      dispose: () => { act(() => { disposer?.() }); container.remove() },
    }
  }

  it('a replace round cancels the running turn before submitting its draft', () => {
    const b = modeBench()
    act(() => { b.bridge.emitVoiceCommand({ type: 'start', mode: 'replace' }) })
    expect(b.cancel).toHaveBeenCalledTimes(1)
    expect(b.listening()).toBe(true)

    act(() => { b.bridge.emitSpeech({ type: 'partial', text: '打断一下' }) })
    act(() => { b.bridge.emitVoiceCommand({ type: 'stop' }) })
    expect(b.finals).toEqual(['打断一下'])
    expect(b.cancel).toHaveBeenCalledTimes(1)
    b.dispose()
  })

  it('a queue round leaves the running turn alone and still submits', () => {
    const b = modeBench()
    act(() => { b.bridge.emitVoiceCommand({ type: 'start', mode: 'queue' }) })
    act(() => { b.bridge.emitSpeech({ type: 'partial', text: '稍后处理' }) })
    act(() => { b.bridge.emitVoiceCommand({ type: 'stop' }) })

    expect(b.cancel).not.toHaveBeenCalled()
    expect(b.finals).toEqual(['稍后处理'])
    b.dispose()
  })

  it('the stop signal cancels without submitting the recognized draft', () => {
    const b = modeBench()
    act(() => { b.bridge.emitVoiceCommand({ type: 'start', mode: 'queue' }) })
    act(() => { b.bridge.emitSpeech({ type: 'partial', text: '不要提交' }) })
    act(() => { b.bridge.emitVoiceCommand({ type: 'cancel' }) })

    expect(b.cancel).toHaveBeenCalledTimes(1)
    expect(b.finals).toEqual([])
    expect(b.listening()).toBe(false)
    b.dispose()
  })

  it('a running replace round shows the stopped task without speaking it', () => {
    const b = modeBench()
    act(() => { b.bridge.emitMode('expanded') })
    act(() => { b.store.beginThinking('session-1') })
    act(() => { b.bridge.emitVoiceCommand({ type: 'start', mode: 'replace' }) })

    expect(b.cancel).toHaveBeenCalledTimes(1)
    expect(b.container.textContent).toContain(defaultPixiesMessages.taskStopped)
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')?.getAttribute('data-mood'))
      .not.toBe('thinking')
    expect(b.bridge.calls.filter(call => call.startsWith('speakReply:'))).toEqual([])
    b.dispose()
  })

  it('an idle replace round shows and speaks no stop feedback', () => {
    const b = modeBench()
    act(() => { b.bridge.emitVoiceCommand({ type: 'start', mode: 'replace' }) })

    expect(b.cancel).toHaveBeenCalledTimes(1)
    expect(b.store.getState().messages.some(message => message.text === defaultPixiesMessages.taskStopped))
      .toBe(false)
    expect(b.bridge.calls.filter(call => call.startsWith('speakReply:'))).toEqual([])
    b.dispose()
  })

  it('discards a final transcript emitted after the stop signal', () => {
    const b = modeBench()
    act(() => { b.bridge.emitVoiceCommand({ type: 'start', mode: 'queue' }) })
    act(() => { b.bridge.emitSpeech({ type: 'partial', text: '不要提交' }) })
    act(() => { b.bridge.emitVoiceCommand({ type: 'cancel' }) })
    act(() => { b.bridge.emitSpeech({ type: 'final', text: '不要提交' }) })

    expect(b.finals).toEqual([])
    expect(b.cancel).toHaveBeenCalledTimes(1)
    b.dispose()
  })

  it('ignores a malformed mode from the wire', () => {
    const b = modeBench()
    act(() => { b.bridge.emitVoiceCommand({ type: 'start', mode: 'bogus' }) })

    expect(b.listening()).toBe(false)
    expect(b.cancel).not.toHaveBeenCalled()
    b.dispose()
  })
})

describe('expanded conversation interactions', () => {
  /** Mount a shell with a bridge, expand it, and return the interesting nodes. */
  function bench(options: { readonly mode?: PixiesShellMode } = {}): {
    store: ReturnType<typeof createPixiesStore>
    container: HTMLElement
    bridge: ReturnType<typeof fakeBridge>
    cancel: ReturnType<typeof vi.fn>
    input: () => HTMLTextAreaElement
    send: () => HTMLButtonElement
    dispose: () => void
  } {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const bridge = fakeBridge(options)
    const cancel = vi.fn()
    const sent: string[] = []
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(
        container, store, defaultPixiesMessages, bridge.bridge,
        (text) => { sent.push(text) }, undefined, cancel,
      )
    })
    act(() => { bridge.emitMode('expanded') })
    return {
      store,
      container,
      bridge,
      cancel,
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

  it('swaps Send for Stop while a turn runs and shows the stopped task', () => {
    const b = bench()
    act(() => { b.store.beginThinking('session-1') })
    const stop = b.container.querySelector('[data-testid="pixies-stop"]') as HTMLButtonElement
    expect(stop).not.toBeNull()
    expect(stop.getAttribute('aria-label')).toBe(defaultPixiesMessages.stop)
    expect(b.container.querySelector('[data-testid="pixies-send"]')).toBeNull()
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    expect(b.container.querySelector('[data-testid="pixies-work-title"]')?.textContent)
      .toBe(defaultPixiesMessages.thinking)

    fireEvent.click(stop)

    expect(b.cancel).toHaveBeenCalledTimes(1)
    expect(b.container.textContent).toContain(defaultPixiesMessages.taskStopped)
    expect(b.bridge.calls.filter(call => call.startsWith('speakReply:'))).toEqual([])
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    expect(b.container.querySelector('[data-testid="pixies-send"]')).not.toBeNull()
    b.dispose()
  })

  it('collapses on Escape', () => {
    const b = bench()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(b.bridge.calls).toContain('collapse')
    b.dispose()
  })

  it('renders the assistant reply without a separate thinking status bubble', () => {
    const b = bench()
    act(() => { b.store.beginThinking('session-1') })
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    expect(b.container.querySelector('[data-testid="pixies-work-title"]')?.textContent)
      .toBe(defaultPixiesMessages.thinking)
    act(() => {
      b.store.speak({
        id: 'session-1#2', sessionId: 'session-1', character: 'spider-man',
        kind: 'speech', mood: 'happy', text: '我在这儿', seq: 2,
      })
    })
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')?.textContent).toBe('我在这儿')
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')?.getAttribute('data-mood'))
      .not.toBe('thinking')
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

  /** DOM order of work groups and assistant replies in the transcript. */
  function transcriptOrder(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('[data-testid="pixies-work-group"], [data-role="assistant"]'))
      .map(node => node.getAttribute('data-role') === 'assistant' ? 'reply' : 'work')
  }

  /** Open one outer work group and return its ordered rows. */
  function openWorkGroup(container: HTMLElement, index = 0): NodeListOf<Element> {
    const group = container.querySelectorAll('[data-testid="pixies-work-group"]')[index]!
    fireEvent.click(group.querySelector('[data-testid="pixies-work-toggle"]')!)
    return group.querySelectorAll('[data-testid="pixies-process-row"]')
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

  it('speaks only the marked takeaway of a detailed reply', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, calls, emitMode } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })
    act(() => { emitMode('expanded') })

    act(() => {
      speak(store, 'session-1#1', '[voice]已修复登录问题[/voice]\n\n## 详情\n\n- 修改了 3 个文件\n- 跑了测试')
    })
    expect(calls.filter(call => call.startsWith('speakReply:'))).toEqual(['speakReply:已修复登录问题'])
    // The full reply stays visible as rendered Markdown; only the control markers disappear.
    expect(container.textContent).toContain('详情')
    expect(container.textContent).toContain('修改了 3 个文件')
    expect(container.textContent).not.toContain('[voice]')
    expect(container.querySelector('[data-testid="pixies-bubble"] h2')?.textContent).toBe('详情')

    act(() => { disposer?.() })
    container.remove()
  })

  it('speaks only the marked takeaway while the transcript keeps reasoning and the full reply', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, calls, emitMode } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => { disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge) })
    act(() => { emitMode('expanded') })

    // A real turn carries settled reasoning plus a complete reply whose
    // spoken takeaway is marked at the start.
    act(() => { store.settleThinking('session-1', '先核对证据，再组织结论') })
    act(() => {
      speak(store, 'session-1#1',
        '[voice]结论已确认[/voice]\n\n## 核对过程\n\n第一条证据\n\n第二条证据\n\n## 结论\n\n完整结论正文')
    })

    expect(calls.filter(call => call.startsWith('speakReply:'))).toEqual(['speakReply:结论已确认'])
    // Nothing is dropped from the visible transcript: the takeaway sentence,
    // the full structured reply, and the settled reasoning row all stay.
    expect(container.textContent).toContain('结论已确认')
    expect(container.textContent).toContain('核对过程')
    expect(container.textContent).toContain('第二条证据')
    expect(container.textContent).toContain('完整结论正文')
    const group = container.querySelector('[data-testid="pixies-work-group"]')!
    expect(group).not.toBeNull()
    const rows = openWorkGroup(container)
    fireEvent.click(rows[0]!.querySelector('[data-testid="pixies-process-toggle"]')!)
    expect(rows[0]!.querySelector('[data-testid="pixies-process-body"]')?.textContent)
      .toBe('先核对证据，再组织结论')
    expect(container.textContent).not.toContain('[voice]')

    act(() => { disposer?.() })
    container.remove()
  })

  it('keeps every turn\'s work in its own group at its own position', () => {
    const b = expandedBench()
    act(() => { b.store.settleThinking('s', '第一轮推理') })
    act(() => { speak(b.store, 'session-1#1', '第一条回复') })
    act(() => { b.store.beginThinking('s') })
    act(() => { b.store.settleThinking('s', '第二轮推理') })
    act(() => { speak(b.store, 'session-1#2', '第二条回复') })

    expect(b.container.querySelectorAll('[data-testid="pixies-work-group"]')).toHaveLength(2)
    const firstRows = openWorkGroup(b.container, 0)
    const secondRows = openWorkGroup(b.container, 1)
    expect(firstRows).toHaveLength(1)
    expect(secondRows).toHaveLength(1)
    fireEvent.click(firstRows[0]!.querySelector('[data-testid="pixies-process-toggle"]')!)
    expect(firstRows[0]!.querySelector('[data-testid="pixies-process-body"]')?.textContent).toBe('第一轮推理')
    // Groups and rows are independent: expanding one never expands another.
    expect(secondRows[0]!.querySelector('[data-testid="pixies-process-body"]')).toBeNull()
    fireEvent.click(secondRows[0]!.querySelector('[data-testid="pixies-process-toggle"]')!)
    expect(secondRows[0]!.querySelector('[data-testid="pixies-process-body"]')?.textContent).toBe('第二轮推理')

    expect(transcriptOrder(b.container)).toEqual(['work', 'reply', 'work', 'reply'])
    b.dispose()
  })

  it('renders replayed work rows with their persisted reasoning', () => {
    const b = expandedBench()
    act(() => {
      b.store.hydrate([
        { id: 'history-0', role: 'process', text: '历史推理', mood: 'neutral', at: 1, processKind: 'thinking' },
        { id: 'history-1', role: 'assistant', text: '历史回复', mood: 'neutral', at: 2 },
      ])
    })
    const group = b.container.querySelector('[data-testid="pixies-work-group"]')!
    expect(group).not.toBeNull()
    expect(group.querySelector('[data-testid="pixies-process-row"]')).toBeNull()
    const rows = openWorkGroup(b.container)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.querySelector('[data-testid="pixies-process-body"]')).toBeNull()
    fireEvent.click(rows[0]!.querySelector('[data-testid="pixies-process-toggle"]')!)
    expect(rows[0]!.querySelector('[data-testid="pixies-process-body"]')?.textContent).toBe('历史推理')
    b.dispose()
  })

  it('groups a turn\'s work before the reply with two-level disclosure', () => {
    const b = expandedBench()
    act(() => {
      feedSessionEvent(b.store, 's', { type: 'turn/start', seq: 1, data: { turn: 1 } })
      feedSessionEvent(b.store, 's', { type: 'assistant/message', seq: 2, data: {
        turn: 1, step: 1, message: { content: [
          { type: 'reasoning', text: '先算一下' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"123 * 456"}' },
        ] },
      } })
      feedSessionEvent(b.store, 's', { type: 'tool/result', seq: 3, data: { message: { content: [
        { type: 'tool-result', content: [{ type: 'text', text: '56088\n' }] },
      ] } } })
      feedSessionEvent(b.store, 's', { type: 'assistant/message', seq: 4, data: {
        turn: 1, step: 2, message: { content: [{ type: 'text', text: '结果是 56088' }] },
      } })
    })

    expect(b.container.textContent).toContain('结果是 56088')
    const group = b.container.querySelector('[data-testid="pixies-work-group"]')!
    expect(group).not.toBeNull()
    expect(b.container.querySelectorAll('[data-testid="pixies-work-group"]')).toHaveLength(1)
    // Level 1 is closed by default, and stays before the answer.
    expect(group.querySelector('[data-testid="pixies-work-toggle"]')?.getAttribute('aria-expanded'))
      .toBe('false')
    expect(group.querySelector('[data-testid="pixies-work-toggle"]')?.getAttribute('aria-label'))
      .toBe(defaultPixiesMessages.showProcess)
    expect(group.querySelector('[data-testid="pixies-work-items"]')).toBeNull()
    expect(transcriptOrder(b.container)).toEqual(['work', 'reply'])

    // Level 1 open: every ordered row appears, each still closed.
    const rows = openWorkGroup(b.container)
    expect(rows).toHaveLength(3)
    expect(Array.from(rows).map(row => row.getAttribute('data-kind')))
      .toEqual(['thinking', 'tool-call', 'tool-result'])
    for (const row of rows) {
      expect(row.querySelector('[data-testid="pixies-process-toggle"]')?.getAttribute('aria-expanded'))
        .toBe('false')
      expect(row.querySelector('[data-testid="pixies-process-body"]')).toBeNull()
    }
    expect(rows[0]!.textContent).toContain('先算一下')
    expect(rows[1]!.textContent).toContain('bash({"command":"123 * 456"})')
    expect(rows[2]!.textContent).toContain('56088')

    // Level 2: clicking one row opens only that row's detail.
    fireEvent.click(rows[1]!.querySelector('[data-testid="pixies-process-toggle"]')!)
    expect(rows[1]!.querySelector('[data-testid="pixies-process-body"]')?.textContent)
      .toBe('bash({"command":"123 * 456"})')
    expect(rows[0]!.querySelector('[data-testid="pixies-process-body"]')).toBeNull()
    expect(rows[2]!.querySelector('[data-testid="pixies-process-body"]')).toBeNull()
    b.dispose()
  })

  it('keeps a turn with no final reply recorded instead of dropping it', () => {
    const b = expandedBench()
    act(() => {
      feedSessionEvent(b.store, 's', { type: 'turn/start', seq: 1, data: { turn: 1 } })
      feedSessionEvent(b.store, 's', { type: 'assistant/message', seq: 2, data: {
        turn: 1, step: 1, message: { content: [
          { type: 'reasoning', text: '还在查' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: 'echo hi' },
        ] },
      } })
      feedSessionEvent(b.store, 's', { type: 'tool/result', seq: 3, data: { message: { content: [
        { type: 'tool-result', content: [{ type: 'text', text: 'hi\n' }] },
      ] } } })
      feedSessionEvent(b.store, 's', { type: 'turn/end', seq: 4, data: { turn: 1 } })
    })
    const rows = openWorkGroup(b.container)
    expect(Array.from(rows).map(row => row.getAttribute('data-kind')))
      .toEqual(['thinking', 'tool-call', 'tool-result'])
    expect(b.container.querySelector('[data-role="assistant"]')).toBeNull()
    expect(transcriptOrder(b.container)).toEqual(['work'])
    b.dispose()
  })

  it('renders replayed tool work rows in their recorded order', () => {
    const b = expandedBench()
    act(() => {
      b.store.hydrate([
        { id: 'history-0', role: 'process', text: '历史推理', mood: 'neutral', at: 1, processKind: 'thinking' },
        { id: 'history-1', role: 'process', text: 'bash(echo hi)', mood: 'neutral', at: 2, processKind: 'tool-call' },
        { id: 'history-2', role: 'process', text: 'hi\n', mood: 'neutral', at: 3, processKind: 'tool-result' },
        { id: 'history-3', role: 'assistant', text: '历史回复', mood: 'neutral', at: 4 },
      ])
    })
    const rows = openWorkGroup(b.container)
    expect(rows).toHaveLength(3)
    expect(Array.from(rows).map(row => row.getAttribute('data-kind')))
      .toEqual(['thinking', 'tool-call', 'tool-result'])
    expect(transcriptOrder(b.container)).toEqual(['work', 'reply'])
    fireEvent.click(rows[1]!.querySelector('[data-testid="pixies-process-toggle"]')!)
    expect(rows[1]!.querySelector('[data-testid="pixies-process-body"]')?.textContent).toBe('bash(echo hi)')
    b.dispose()
  })

  it('never shows a thinking bubble; the work group carries the state', () => {
    const b = expandedBench()
    const title = (): string => b.container.querySelector('[data-testid="pixies-work-title"]')?.textContent ?? ''
    act(() => { b.store.beginThinking('s') })
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    expect(title()).toBe(defaultPixiesMessages.thinking)

    act(() => { b.store.appendThinking('s', '先看证据') })
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    expect(title()).toBe(defaultPixiesMessages.thinking)
    expect(b.container.querySelector('[data-testid="pixies-work-group"]')?.hasAttribute('data-active'))
      .toBe(true)

    act(() => { b.store.settleThinking('s', '先看证据') })
    expect(title()).toBe(defaultPixiesMessages.thinkingProcess)
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    b.dispose()
  })

  it('renders assistant replies as full-width documents while keeping user bubbles', () => {
    const b = expandedBench()
    act(() => {
      b.store.appendMessage({ role: 'user', text: '帮我算一下' })
      speak(b.store, 'session-1#1', '## 详情\n\n一段很长的回答')
    })
    const assistant = b.container.querySelector('[data-role="assistant"]') as HTMLElement
    const user = b.container.querySelector('[data-role="user"]') as HTMLElement
    expect(assistant.style.width).toBe('100%')
    expect(assistant.style.background).toBe('')
    expect(assistant.style.border).toBe('')
    expect(assistant.style.borderRadius).toBe('')
    // The Markdown primitive owns code/table scrolling; inherited wrapping
    // would force long code onto broken lines instead of a scrollbar.
    expect(assistant.style.overflowWrap).toBe('')
    expect(assistant.style.whiteSpace).toBe('')
    expect(user.style.background).toContain('linear-gradient')
    expect(user.style.borderRadius).toBe('14px')
    expect(b.container.querySelector('[data-testid="pixies-reply-header"]')?.textContent)
      .toBe(defaultPixiesMessages.roleAssistant)
    b.dispose()
  })

  it('lists live reasoning in the work group instead of a card bubble', () => {
    const b = expandedBench()
    act(() => { b.store.beginThinking('s') })
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    act(() => { b.store.appendThinking('s', '正在整理证据') })
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    const group = b.container.querySelector('[data-testid="pixies-work-group"]')!
    fireEvent.click(group.querySelector('[data-testid="pixies-work-toggle"]')!)
    const row = group.querySelector('[data-testid="pixies-process-row"]')!
    fireEvent.click(row.querySelector('[data-testid="pixies-process-toggle"]')!)
    expect(row.querySelector('[data-testid="pixies-process-body"]')?.textContent).toBe('正在整理证据')
    b.dispose()
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

  it('shows a thinking avatar from the voice-command submit until the reply arrives', () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitSpeech, emitVoiceCommand } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, () => {})
    })
    const mini = (): HTMLElement => container.querySelector('[data-testid="pixies-mini"]')!

    act(() => { emitVoiceCommand({ type: 'start' }) })
    act(() => { emitSpeech({ type: 'partial', text: '今天天气' }) })
    expect(mini().getAttribute('data-listening')).toBe('')
    expect(mini().hasAttribute('data-thinking')).toBe(false)

    act(() => { emitVoiceCommand({ type: 'stop' }) })
    expect(mini().hasAttribute('data-listening')).toBe(false)
    expect(mini().getAttribute('data-thinking')).toBe('')
    expect(mini().getAttribute('aria-label')).toBe(defaultPixiesMessages.statusThinking)
    expect(container.querySelector('[data-pixies-shell]')?.getAttribute('data-thinking')).toBe('')
    expect(container.querySelector('[data-testid="pixies-thinking-ring"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pixies-listening-ring"]')).toBeNull()

    act(() => { speak(store, 'session-1#9', '晴，25 度') })
    expect(mini().hasAttribute('data-thinking')).toBe(false)
    expect(container.querySelector('[data-testid="pixies-thinking-ring"]')).toBeNull()

    act(() => { disposer?.() })
    container.remove()
  })

  it('keeps the work group in progress while the host reports a mid-turn session', () => {
    const b = expandedBench()
    act(() => { b.store.beginThinking('session-1') })
    expect(b.container.textContent).toContain(defaultPixiesMessages.statusThinking)
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    expect(b.container.querySelector('[data-testid="pixies-work-title"]')?.textContent)
      .toBe(defaultPixiesMessages.thinking)
    act(() => { b.store.endThinking('session-1') })
    expect(b.container.querySelector('[data-testid="pixies-bubble"]')).toBeNull()
    expect(b.container.querySelector('[data-testid="pixies-work-group"]')?.hasAttribute('data-active'))
      .not.toBe(true)
    b.dispose()
  })

  it('drops the thinking state when sending the prompt fails', async () => {
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitSpeech, emitVoiceCommand } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge,
        () => Promise.reject(new Error('offline')))
    })
    const mini = (): HTMLElement => container.querySelector('[data-testid="pixies-mini"]')!
    act(() => { emitVoiceCommand({ type: 'start' }) })
    act(() => { emitSpeech({ type: 'partial', text: '在吗' }) })
    await act(async () => { emitVoiceCommand({ type: 'stop' }) })
    expect(mini().hasAttribute('data-thinking')).toBe(false)
    expect(container.querySelector('[data-testid="pixies-thinking-ring"]')).toBeNull()
    act(() => { disposer?.() })
    container.remove()
  })

  it('stops thinking when the host never answers', () => {
    vi.useFakeTimers()
    const store = createPixiesStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { bridge, emitSpeech, emitVoiceCommand } = fakeBridge()
    let disposer: (() => void) | undefined
    act(() => {
      disposer = mountPixiesShell(container, store, defaultPixiesMessages, bridge, () => {})
    })
    const mini = (): HTMLElement => container.querySelector('[data-testid="pixies-mini"]')!
    act(() => { emitVoiceCommand({ type: 'start' }) })
    act(() => { emitSpeech({ type: 'partial', text: '在吗' }) })
    act(() => { emitVoiceCommand({ type: 'stop' }) })
    expect(mini().getAttribute('data-thinking')).toBe('')
    act(() => { vi.runAllTimers() })
    expect(mini().hasAttribute('data-thinking')).toBe(false)
    act(() => { disposer?.() })
    vi.useRealTimers()
    container.remove()
  })
})
