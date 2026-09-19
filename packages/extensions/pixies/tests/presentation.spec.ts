/**
 * Pure-fold tests for presentation derivation (test-validation method 2,
 * "会话回放派生"): same event in, same presentation out — replay-stable.
 */
import { describe, expect, it } from 'vitest'
import { assistantMessageText, presentationFromAssistantMessage } from '../src/presentation.ts'
import type { AssistantMessageBody } from '../src/presentation.ts'

function body(content: readonly unknown[] | undefined, interrupted?: true): AssistantMessageBody {
  return {
    turn: 1,
    step: 1,
    message: content === undefined ? {} : { content },
    ...(interrupted === undefined ? {} : { interrupted }),
  }
}

describe('assistantMessageText', () => {
  it('joins every text block with newlines and trims', () => {
    const text = assistantMessageText(body([
      { type: 'text', text: '  Hello ' },
      { type: 'tool_call', name: 'echo' },
      { type: 'text', text: 'World' },
    ]))
    expect(text).toBe('Hello\nWorld')
  })

  it('returns empty when content is absent', () => {
    expect(assistantMessageText(body(undefined))).toBe('')
  })

  it('returns empty for only non-text blocks', () => {
    expect(assistantMessageText(body([{ type: 'tool_call', name: 'echo' }]))).toBe('')
  })

  it('returns empty for blank text', () => {
    expect(assistantMessageText(body([{ type: 'text', text: '   ' }]))).toBe('')
  })

  it('ignores non-object blocks and malformed text', () => {
    expect(assistantMessageText(body(['plain', { type: 'text' }, null]))).toBe('')
  })
})

describe('presentationFromAssistantMessage', () => {
  it('derives a deterministic speech presentation from a text message', () => {
    const presentation = presentationFromAssistantMessage('session-1', 7, body([
      { type: 'text', text: '你好' },
    ]))
    expect(presentation).toEqual({
      id: 'session-1#7',
      sessionId: 'session-1',
      character: 'spider-man',
      kind: 'speech',
      mood: 'neutral',
      text: '你好',
      seq: 7,
    })
  })

  it('is replay-stable: same inputs derive the same presentation', () => {
    const event = body([{ type: 'text', text: 'stable' }])
    expect(presentationFromAssistantMessage('s', 3, event))
      .toEqual(presentationFromAssistantMessage('s', 3, event))
  })

  it('returns null when there is nothing speakable', () => {
    expect(presentationFromAssistantMessage('session-1', 1, body([]))).toBeNull()
    expect(presentationFromAssistantMessage('session-1', 1, body(undefined))).toBeNull()
    expect(presentationFromAssistantMessage('session-1', 1, body([{ type: 'tool_call', name: 'echo' }]))).toBeNull()
  })

  it('still derives from an interrupted message that delivered a prefix', () => {
    const presentation = presentationFromAssistantMessage('session-1', 9, body([
      { type: 'text', text: 'partial' },
    ], true))
    expect(presentation?.text).toBe('partial')
    expect(presentation?.id).toBe('session-1#9')
  })
})
