/** Feed unit tests (test-validation phase2b method 5): assistant/message folds into the store. */
import { describe, expect, it } from 'vitest'
import { createPixiesStore } from '../../src/client/store.ts'
import { feedSessionEvent } from '../../src/client/feed.ts'
import type { SessionEventLike } from '../../src/client/feed.ts'

function event(type: string, seq: number, data: unknown): SessionEventLike {
  return { type, seq, data }
}

describe('feedSessionEvent', () => {
  it('publishes a speech presentation from assistant/message', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('assistant/message', 3, {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: '你好' }] },
    }))
    expect(store.getState().latest).toMatchObject({ sessionId: 'session-1', kind: 'speech', text: '你好', seq: 3 })
  })

  it('ignores events without speakable text', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('assistant/message', 4, {
      turn: 1,
      step: 1,
      message: { content: [] },
    }))
    expect(store.getState().latest).toBeUndefined()
  })

  it('ignores non-assistant events', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('user/message', 2, { content: [] }))
    expect(store.getState().latest).toBeUndefined()
  })

  it('folds human user messages only when replaying history', () => {
    const store = createPixiesStore()
    const body = {
      id: 'user-1', role: 'user',
      content: [{ type: 'text', text: '帮我查一下' }],
      source: { kind: 'user' },
    }
    feedSessionEvent(store, 'session-1', event('user/message', 2, body))
    expect(store.getState().messages).toEqual([])
    feedSessionEvent(store, 'session-1', event('user/message', 2, body), true)
    expect(store.getState().messages).toMatchObject([{ role: 'user', text: '帮我查一下' }])
  })

  it('skips plugin-authored user messages during replay', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('user/message', 2, {
      content: [{ type: 'text', text: '压缩摘要' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), true)
    expect(store.getState().messages).toEqual([])
  })

  it('turn/start marks the session pending, turn/end clears it', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('turn/start', 1, { turn: 1 }))
    expect(store.getState().pendingSession).toBe('session-1')
    feedSessionEvent(store, 'session-1', event('turn/end', 99, { turn: 1 }))
    expect(store.getState().pendingSession).toBeUndefined()
  })

  it('surfaces a failed turn as a visible system message instead of going blank', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('turn/start', 1, { turn: 1 }))
    feedSessionEvent(store, 'session-1', event('turn/end', 2, {
      turn: 1,
      reason: { kind: 'error', error: { message: 'llm-deepseek: no API key' } },
    }))
    expect(store.getState().pendingSession).toBeUndefined()
    expect(store.getState().messages).toMatchObject([
      { role: 'system', text: 'llm-deepseek: no API key', mood: 'asking' },
    ])
  })

  it('keeps a normal or aborted turn silent', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('turn/end', 2, { turn: 1, reason: { kind: 'abort' } }))
    feedSessionEvent(store, 'session-1', event('turn/end', 3, {}))
    feedSessionEvent(store, 'session-1', event('turn/end', 4, null))
    expect(store.getState().messages).toEqual([])
  })

  it('the first assistant/message clears the pending marker', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('turn/start', 1, { turn: 1 }))
    feedSessionEvent(store, 'session-1', event('assistant/message', 3, {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: '你好' }] },
    }))
    expect(store.getState().pendingSession).toBeUndefined()
    expect(store.getState().latest?.text).toBe('你好')
  })

  it('streams live reasoning deltas into the thinking round', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('assistant/live-chunk', 1.1, {
      attemptId: 'a', turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先' },
    }))
    feedSessionEvent(store, 'session-1', event('assistant/live-chunk', 1.2, {
      attemptId: 'a', turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '再查' },
    }))
    expect(store.getState().thinking).toEqual({ sessionId: 'session-1', text: '先再查', active: true })
  })

  it('ignores live chunks that are not reasoning deltas', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('assistant/live-chunk', 1.1, {
      chunk: { type: 'text-delta', index: 0, text: '正文' },
    }))
    feedSessionEvent(store, 'session-1', event('assistant/live-chunk', 1.2, { chunk: null }))
    feedSessionEvent(store, 'session-1', event('assistant/live-chunk', 1.3, null))
    expect(store.getState().thinking).toBeUndefined()
  })

  it('settles the stream with the durable reasoning block on replay', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('assistant/live-chunk', 1.1, {
      chunk: { type: 'reasoning-delta', index: 0, text: '草稿' },
    }))
    feedSessionEvent(store, 'session-1', event('assistant/message', 3, {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'reasoning', text: '完整推理' },
          { type: 'text', text: '答案' },
        ],
      },
    }))
    expect(store.getState().thinking).toEqual({ sessionId: 'session-1', text: '完整推理', active: false })
    expect(store.getState().latest?.text).toBe('答案')
  })

  it('reconstructs reasoning from a durable message without live chunks', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('assistant/message', 3, {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'reasoning', text: '回放推理' }] },
    }))
    expect(store.getState().thinking).toEqual({ sessionId: 'session-1', text: '回放推理', active: false })
  })

  it('narrows malformed live chunk payloads', () => {
    const store = createPixiesStore()
    const payloads: unknown[] = [
      'not an object',
      {},
      { chunk: 'not an object' },
      { chunk: { type: 'reasoning-delta', index: 0 } },
      { chunk: { type: 'reasoning-delta', index: 0, text: '' } },
      { chunk: { type: 'reasoning-delta', index: 0, text: 42 } },
    ]
    for (const data of payloads) {
      feedSessionEvent(store, 'session-1', event('assistant/live-chunk', 1.1, data))
    }
    expect(store.getState().thinking).toBeUndefined()
  })

  it('narrows malformed durable payloads and joins reasoning blocks', () => {
    const payloads: unknown[] = [
      'not an object',
      { message: null },
      { message: { content: 'not an array' } },
      { message: { content: [null, 3, { type: 'text', text: '正文' }] } },
      { message: { content: [{ type: 'reasoning' }, { type: 'reasoning', text: 42 }, { type: 'reasoning', text: '  ' }] } },
    ]
    for (const data of payloads) {
      const store = createPixiesStore()
      feedSessionEvent(store, 'session-1', event('assistant/message', 3, data))
      expect(store.getState().thinking).toBeUndefined()
    }

    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('assistant/message', 4, {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'reasoning', text: 'A' }, { type: 'reasoning', text: 'B' }] },
    }))
    expect(store.getState().thinking?.text).toBe('A\nB')
  })

  it('keeps the live text when the durable message has no reasoning', () => {
    const store = createPixiesStore()
    feedSessionEvent(store, 'session-1', event('assistant/live-chunk', 1.1, {
      chunk: { type: 'reasoning-delta', index: 0, text: '只有 live' },
    }))
    feedSessionEvent(store, 'session-1', event('assistant/message', 3, {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: '答案' }] },
    }))
    expect(store.getState().thinking).toEqual({ sessionId: 'session-1', text: '只有 live', active: false })
  })
})
