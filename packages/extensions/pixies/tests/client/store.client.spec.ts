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

  it('hydrate replaces the visible window in one notification', () => {
    const store = createPixiesStore()
    store.speak(presentation('旧的'))
    let calls = 0
    store.subscribe(() => { calls += 1 })
    store.hydrate([
      { id: 'history-0', role: 'user', text: '问', mood: 'neutral', at: 1, historical: true },
      { id: 'history-1', role: 'assistant', text: '答', mood: 'neutral', at: 2, historical: true },
    ])
    expect(calls).toBe(1)
    expect(store.getState().latest).toBeUndefined()
    expect(store.getState().messages.map(message => message.text)).toEqual(['问', '答'])
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

  it('writes every settled reasoning step as its own ordered row', () => {
    const store = createPixiesStore()
    store.beginThinking('s')
    store.settleThinking('s', '先查证据')
    store.settleThinking('s', '再算结果')
    store.settleThinking('s', undefined) // the speaking message carries no reasoning
    store.speak(presentation('答案'))
    expect(store.getState().messages.map(message => ({ role: message.role, kind: message.processKind, text: message.text })))
      .toEqual([
        { role: 'process', kind: 'thinking', text: '先查证据' },
        { role: 'process', kind: 'thinking', text: '再算结果' },
        { role: 'assistant', kind: undefined, text: '答案' },
      ])
  })

  it('keeps every turn separate instead of inheriting the previous one', () => {
    const store = createPixiesStore()
    store.settleThinking('s', '第一轮推理')
    store.speak(presentation('第一轮'))
    store.beginThinking('s')
    store.speak({ ...presentation('第二轮'), id: 'session-1#2', seq: 2 })
    const messages = store.getState().messages
    expect(messages).toHaveLength(3)
    expect(messages[0]?.role).toBe('process')
    expect(messages[1]?.text).toBe('第一轮')
    expect(messages[2]?.text).toBe('第二轮')
  })

  it('keeps a tool-only round with no reply instead of discarding it next turn', () => {
    const store = createPixiesStore()
    store.settleThinking('s', '回放推理')
    store.speak(presentation('历史回复'))
    const history = store.getState().messages
    store.hydrate(history.map(message => ({ ...message, historical: true })))
    expect(store.getState().messages[0]?.text).toBe('回放推理')

    store.beginThinking('s')
    store.settleThinking('s', '无回复的推理')
    store.appendProcess('s', { kind: 'tool-call', text: 'bash(echo hi)' })
    store.endThinking('s')
    store.beginThinking('s') // next turn starts; the tool-only round must stay
    store.speak({ ...presentation('新回复'), id: 'session-1#3', seq: 3 })
    expect(store.getState().messages.map(message => message.text))
      .toEqual(['回放推理', '历史回复', '无回复的推理', 'bash(echo hi)', '新回复'])
  })

  it('settles a live-only reasoning stream into one row', () => {
    const store = createPixiesStore()
    store.beginThinking('session-1')
    store.appendThinking('session-1', '先看证据')
    store.appendThinking('session-1', '再算结果')
    store.settleThinking('session-1', undefined) // no durable reasoning block
    store.speak(presentation('答案是 42'))
    expect(store.getState().messages.map(message => message.text))
      .toEqual(['先看证据再算结果', '答案是 42'])
    expect(store.getState().messages[0]?.processKind).toBe('thinking')
  })

  it('writes tool work in event order before the reply and drops adjacent duplicates', () => {
    const store = createPixiesStore()
    store.beginThinking('session-1')
    store.settleThinking('session-1', '需要算一下')
    store.appendProcess('session-1', { kind: 'tool-call', text: 'bash({"command":"123 * 456"})' })
    // The same call is emitted as both a content block and a tool/call event.
    store.appendProcess('session-1', { kind: 'tool-call', text: 'bash({"command":"123 * 456"})' })
    store.appendProcess('session-1', { kind: 'tool-result', text: '56088\n' })
    store.settleThinking('session-1', '核对无误')
    store.speak(presentation('结果是 56088'))
    expect(store.getState().messages.map(message => ({ kind: message.processKind, text: message.text })))
      .toEqual([
        { kind: 'thinking', text: '需要算一下' },
        { kind: 'tool-call', text: 'bash({"command":"123 * 456"})' },
        { kind: 'tool-result', text: '56088\n' },
        { kind: 'thinking', text: '核对无误' },
        { kind: undefined, text: '结果是 56088' },
      ])
  })

  it('keeps the ordered transcript across hydrate and a following turn', () => {
    const store = createPixiesStore()
    store.appendProcess('session-1', { kind: 'tool-call', text: 'bash(echo hi)' })
    store.speak(presentation('第一轮'))
    const history = store.getState().messages
    store.hydrate(history.map(message => ({ ...message, historical: true })))
    expect(store.getState().messages.map(message => message.text))
      .toEqual(['bash(echo hi)', '第一轮'])

    store.beginThinking('session-1')
    store.speak({ ...presentation('第二轮'), id: 'session-1#2', seq: 2 })
    expect(store.getState().messages.at(-1)?.text).toBe('第二轮')
    expect(store.getState().messages.at(-1)?.role).toBe('assistant')
  })
})
