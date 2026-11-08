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
    expect(store.getState()).toEqual({
      latest: undefined,
      interaction: undefined,
      pendingSession: undefined,
      thinking: undefined,
      messages: [],
    })

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
    expect(store.getState()).toEqual({
      latest: undefined,
      interaction: undefined,
      pendingSession: undefined,
      thinking: undefined,
      messages: [],
    })
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

  it('streams reasoning deltas into one active round and keeps it after settling', () => {
    const store = createPixiesStore()
    store.beginThinking('s')
    store.appendThinking('s', '先看')
    store.appendThinking('s', '再查')
    expect(store.getState().thinking).toEqual({ sessionId: 's', text: '先看再查', active: true })

    store.settleThinking('s', undefined)
    expect(store.getState().thinking).toEqual({ sessionId: 's', text: '先看再查', active: false })
    expect(store.getState().pendingSession).toBe('s')
  })

  it('replaces live deltas with the durable reasoning on settlement', () => {
    const store = createPixiesStore()
    store.appendThinking('s', '草稿')
    store.settleThinking('s', '完整推理')
    expect(store.getState().thinking).toEqual({ sessionId: 's', text: '完整推理', active: false })
  })

  it('reconstructs a settled round from durable reasoning alone', () => {
    const store = createPixiesStore()
    store.settleThinking('s', '回放内容')
    expect(store.getState().thinking).toEqual({ sessionId: 's', text: '回放内容', active: false })
  })

  it('starts a fresh round on the next user prompt or turn/start', () => {
    const store = createPixiesStore()
    store.appendThinking('s', '上一轮')
    store.settleThinking('s', undefined)
    store.appendMessage({ role: 'user', text: '新问题' })
    expect(store.getState().thinking).toBeUndefined()

    store.appendThinking('s', '新推理')
    store.settleThinking('s', undefined)
    store.beginThinking('s')
    expect(store.getState().thinking).toBeUndefined()
    store.appendThinking('s', '下一轮')
    expect(store.getState().thinking?.text).toBe('下一轮')
  })

  it('ends the stream on turn/end and on a visible reply', () => {
    const store = createPixiesStore()
    store.appendThinking('s', '推理中')
    store.beginThinking('s')
    store.endThinking('s')
    expect(store.getState().thinking?.active).toBe(false)

    store.appendThinking('s', '又一轮')
    store.speak({ ...presentation('答案'), sessionId: 's' })
    expect(store.getState().thinking?.active).toBe(false)
  })

  it('caps a runaway reasoning stream', () => {
    const store = createPixiesStore()
    store.appendThinking('s', 'x'.repeat(12_100))
    expect(store.getState().thinking?.text).toHaveLength(12_000)
  })

  it('skips empty deltas and no-op settlements', () => {
    const store = createPixiesStore()
    let calls = 0
    store.subscribe(() => { calls += 1 })
    store.appendThinking('s', '')
    store.settleThinking('s', undefined)
    store.settleThinking('s', '')
    expect(store.getState().thinking).toBeUndefined()
    expect(calls).toBe(0)

    store.appendThinking('s', '推理')
    store.settleThinking('s', undefined)
    const settled = calls
    store.settleThinking('s', undefined)
    expect(store.getState().thinking).toEqual({ sessionId: 's', text: '推理', active: false })
    expect(calls).toBe(settled)
  })

  it('ignores deltas from another session after a rebind', () => {
    const store = createPixiesStore()
    store.appendThinking('a', '旧会话')
    store.settleThinking('b', '新会话')
    expect(store.getState().thinking?.text).toBe('旧会话')
    expect(store.getState().thinking?.sessionId).toBe('a')
  })
})
