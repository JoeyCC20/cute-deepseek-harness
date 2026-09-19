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
    feedSessionEvent(store, 'session-1', event('turn/start', 1, { turn: 1 }))
    feedSessionEvent(store, 'session-1', event('user/message', 2, { content: [] }))
    expect(store.getState().latest).toBeUndefined()
  })
})
