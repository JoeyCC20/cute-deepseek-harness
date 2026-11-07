/** Store unit tests (test-validation phase2b method 5): reactive snapshots, publish, and teardown. */
import { describe, expect, it } from 'vitest'
import { createPixiesStore } from '../../src/client/store.ts'
import type { PixiesInteraction, PixiesPresentation } from '../../src/types.ts'

function presentation(text: string): PixiesPresentation {
  return {
    id: 'session-1#1',
    sessionId: 'session-1',
    character: 'spider-man',
    kind: 'speech',
    mood: 'neutral',
    text,
    seq: 1,
  }
}

describe('createPixiesStore', () => {
  it('starts idle and notifies listeners on speak()', () => {
    const store = createPixiesStore()
    const seen: unknown[] = []
    store.subscribe(state => seen.push(state))
    expect(store.getState()).toEqual({ latest: undefined, interaction: undefined, pendingSession: undefined, messages: [] })

    store.speak(presentation('你好'))
    expect(store.getState().latest?.text).toBe('你好')
    expect(seen).toHaveLength(1)
  })

  it('sets and clears the pending interaction', () => {
    const store = createPixiesStore()
    const interaction: PixiesInteraction = { kind: 'approval', sessionId: 'session-1', summary: 'echo' }
    store.setInteraction(interaction)
    expect(store.getState().interaction).toEqual(interaction)
    store.setInteraction(undefined)
    expect(store.getState().interaction).toBeUndefined()
  })

  it('unsubscribes listeners', () => {
    const store = createPixiesStore()
    let calls = 0
    const unsubscribe = store.subscribe(() => { calls += 1 })
    store.speak(presentation('a'))
    expect(calls).toBe(1)
    unsubscribe()
    store.speak(presentation('b'))
    expect(calls).toBe(1)
  })

  it('clear resets every field', () => {
    const store = createPixiesStore()
    store.speak(presentation('a'))
    store.setInteraction({ kind: 'question', sessionId: 's', summary: 'q' })
    store.beginThinking('s')
    store.clear()
    expect(store.getState()).toEqual({ latest: undefined, interaction: undefined, pendingSession: undefined, messages: [] })
  })

  it('beginThinking marks the session and endThinking clears it', () => {
    const store = createPixiesStore()
    store.beginThinking('s')
    expect(store.getState().pendingSession).toBe('s')
    store.endThinking('s')
    expect(store.getState().pendingSession).toBeUndefined()
  })

  it('endThinking ignores stale sessions and clear overrides', () => {
    const store = createPixiesStore()
    store.beginThinking('live')
    store.endThinking('stale')
    expect(store.getState().pendingSession).toBe('live')
    store.clear()
    expect(store.getState().pendingSession).toBeUndefined()
  })

  it('appends local prompts and assistant replies as an ordered history', () => {
    const store = createPixiesStore()
    store.appendMessage({ role: 'user', text: '你好' })
    store.speak(presentation('我是蜘蛛侠'))
    expect(store.getState().messages.map(({ role, text }) => [role, text]))
      .toEqual([['user', '你好'], ['assistant', '我是蜘蛛侠']])
    expect(store.getState().messages[0]?.mood).toBe('neutral')
    expect(store.getState().messages[1]?.id).toBe('session-1#1')
  })

  it('drops empty drafts but keeps every non-empty one', () => {
    const store = createPixiesStore()
    store.appendMessage({ role: 'system', text: '' })
    expect(store.getState().messages).toEqual([])
    store.appendMessage({ role: 'system', text: '已连接', mood: 'happy' })
    expect(store.getState().messages[0]?.mood).toBe('happy')
  })

  it('clear resets the conversation history', () => {
    const store = createPixiesStore()
    store.appendMessage({ role: 'user', text: '在吗' })
    store.speak(presentation('在'))
    store.clear()
    expect(store.getState().messages).toEqual([])
  })

  it('caps the history so a long-running companion stays bounded', () => {
    const store = createPixiesStore()
    for (let index = 0; index < 210; index += 1) {
      store.appendMessage({ role: 'user', text: `第 ${String(index)} 条` })
    }
    expect(store.getState().messages).toHaveLength(200)
    expect(store.getState().messages[0]?.text).toBe('第 10 条')
  })
})
