/**
 * Plugin integration tests (test-validation methods 1 + 2):
 * - waterfall observation: pixies observes approval/question waterfalls,
 *   emits pixies/interaction, and ALWAYS delegates via next() so the existing
 *   answerer chain and fail-closed semantics are preserved.
 * - session derivation: assistant/message events publish pixies/presentation
 *   and update the pixies service projection.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import ApprovalService, { type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { Config, apply } from '../src/index.ts'
import type { PixiesInteraction, PixiesPresentation } from '../src/types.ts'

/**
 * Minimal Agent stand-in mirroring packages/interaction/user-approval's test
 * harness, extended with the session `id` the pixies observers read.
 */
function fakeAgent(seed: Array<{ type: string }> = [{ type: 'turn/start' }, { type: 'user/message' }]): { agent: Agent; appended: Array<{ type: string; data: Record<string, unknown> }> } {
  const appended: Array<{ type: string; data: Record<string, unknown> }> = []
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [...seed]
  const agent = {
    id: 'session-1',
    session: {
      id: 'session-1',
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      append: (type: string, data: Record<string, unknown>) => {
        const event = { type, data }
        events.push(event)
        appended.push(event)
        return event as unknown as SessionEvent
      },
    },
  } as unknown as Agent
  return { agent, appended }
}

function requestOf(agent: Agent, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { agent, toolName: 'echo', ...overrides }
}

async function mounted(overrides: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ApprovalService)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin({ Config, apply }, { character: 'spider-man', ...overrides })
  return ctx
}

describe('waterfall observation', () => {
  it('observes approval/request and delegates — fail-closed outcome unchanged', async () => {
    const ctx = await mounted()
    const interactions: PixiesInteraction[] = []
    ctx.on('pixies/interaction', interaction => interactions.push(interaction))
    const { agent, appended } = fakeAgent()

    const outcome = await ctx.approval.request(requestOf(agent))

    expect(outcome).toBe('unavailable')
    expect(interactions).toHaveLength(1)
    expect(interactions[0]).toMatchObject({ kind: 'approval', sessionId: 'session-1', summary: 'echo' })
    expect(appended.map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
  })

  it('does not short-circuit a downstream answerer that claims', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    // Registered after pixies, so it sits downstream: pixies must delegate.
    ctx.on('approval/request', async () => 'allowed-once' as const)

    const outcome = await ctx.approval.request(requestOf(agent))

    expect(outcome).toBe('allowed-once')
  })

  it('observes user-questions/request and delegates — NO_PROVIDER unchanged', async () => {
    const ctx = await mounted()
    const interactions: PixiesInteraction[] = []
    ctx.on('pixies/interaction', interaction => interactions.push(interaction))

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'q1', question: '继续吗？' }] }))
      .rejects.toThrow('no user-questions answerer accepted the request')
    expect(interactions).toHaveLength(1)
    expect(interactions[0]).toMatchObject({ kind: 'question', summary: '继续吗？' })
  })

  it('stops observing when the config disables it', async () => {
    const ctx = await mounted({ observeApproval: false, observeQuestions: false })
    const interactions: PixiesInteraction[] = []
    ctx.on('pixies/interaction', interaction => interactions.push(interaction))
    const { agent } = fakeAgent()

    await ctx.approval.request(requestOf(agent))
    await expect(ctx.userQuestions.ask({ questions: [{ id: 'q1', question: '继续吗？' }] }))
      .rejects.toThrow('no user-questions answerer accepted the request')

    expect(interactions).toHaveLength(0)
  })
})

describe('session derivation', () => {
  it('publishes a presentation for an assistant/message event and reads back latest()', async () => {
    const ctx = await mounted()
    const presentations: PixiesPresentation[] = []
    ctx.on('pixies/presentation', presentation => presentations.push(presentation))
    const session = { id: 'session-1' } as unknown as Session
    const event = {
      type: 'assistant/message',
      seq: 3,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          id: 'm1',
          source: { kind: 'model' },
          content: [{ type: 'text', text: '你好' }],
        },
      },
    } as unknown as SessionEvent

    ctx.emit('session/event', session, event)

    expect(presentations).toHaveLength(1)
    expect(presentations[0]).toMatchObject({ sessionId: 'session-1', kind: 'speech', text: '你好', seq: 3 })
    expect(ctx.pixies.latest('session-1')?.text).toBe('你好')
  })

  it('ignores assistant/message events with no speakable text', async () => {
    const ctx = await mounted()
    const presentations: PixiesPresentation[] = []
    ctx.on('pixies/presentation', presentation => presentations.push(presentation))
    const session = { id: 'session-1' } as unknown as Session
    const event = {
      type: 'assistant/message',
      seq: 4,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', id: 'm2', source: { kind: 'model' }, content: [] },
      },
    } as unknown as SessionEvent

    ctx.emit('session/event', session, event)

    expect(presentations).toHaveLength(0)
    expect(ctx.pixies.latest('session-1')).toBeUndefined()
  })

  it('ignores non-assistant session events', async () => {
    const ctx = await mounted()
    const presentations: PixiesPresentation[] = []
    ctx.on('pixies/presentation', presentation => presentations.push(presentation))
    const session = { id: 'session-1' } as unknown as Session
    const event = { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as unknown as SessionEvent

    ctx.emit('session/event', session, event)

    expect(presentations).toHaveLength(0)
  })
})

describe('pixies service', () => {
  it('presents directly through ctx.pixies.present()', async () => {
    const ctx = await mounted()
    const presentations: PixiesPresentation[] = []
    ctx.on('pixies/presentation', presentation => presentations.push(presentation))
    const presentation: PixiesPresentation = {
      id: 'session-2#1',
      sessionId: 'session-2',
      character: 'spider-man',
      kind: 'speech',
      mood: 'neutral',
      text: 'direct',
      seq: 1,
    }

    ctx.pixies.present(presentation)

    expect(presentations).toEqual([presentation])
    expect(ctx.pixies.latest('session-2')).toEqual(presentation)
  })
})
