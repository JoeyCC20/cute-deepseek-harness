/** Host tool and wire-contract tests for `show_result_panel`. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService, { type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import * as panel from '@deepseek-ai/dsh-pixies-panel'
import {
  decodePanelDetail,
  PIXIES_PANEL_DISPLAY_ID,
  PIXIES_PANEL_HEADER,
  panelChoiceId,
  panelImageSource,
  panelLinkUrl,
  panelResultMeta,
  parsePanelPayload,
  parsePanelPayloadWire,
  PIXIES_PANEL_VERSION,
} from '@deepseek-ai/dsh-pixies-panel/types'

const signal = new AbortController().signal

async function setup(onQuestion?: (request: AskUserQuestionRequest) => void): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  ctx.on('user-questions/request', (request) => {
    onQuestion?.(request)
    // The shipped panel answerer acknowledges a display-only panel at once.
    if (decodePanelDetail(request)?.interactive === false) {
      return Promise.resolve({ answers: [] })
    }
    return Promise.resolve({ answers: request.questions.map(question => ({ id: question.id, selected: [] })) })
  })
  await ctx.plugin(panel)
  return ctx
}

function execute(ctx: Context, args: unknown, callId = 'panel-1') {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(callId),
    name: 'show_result_panel',
    arguments: args,
  })
}

const imageArgs = {
  title: 'Result',
  items: [
    { kind: 'image', source: 'https://example.com/a.png', alt: 'A chart' },
    { kind: 'text', content: '**42**', format: 'markdown' },
    { kind: 'link', label: 'Docs', url: 'https://example.com/docs' },
  ],
}

describe('parsePanelPayload', () => {
  it('normalizes the four item kinds and marks interactivity', () => {
    const payload = parsePanelPayload({
      ...imageArgs,
      items: [...imageArgs.items, {
        kind: 'choice', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No', description: 'Stop' }],
      }],
    })
    expect(payload.version).toBe(PIXIES_PANEL_VERSION)
    expect(payload.title).toBe('Result')
    expect(payload.interactive).toBe(true)
    expect(payload.items).toEqual([
      { kind: 'image', source: 'https://example.com/a.png', alt: 'A chart' },
      { kind: 'text', content: '**42**', format: 'markdown' },
      { kind: 'link', label: 'Docs', url: 'https://example.com/docs' },
      { kind: 'choice', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No', description: 'Stop' }], multiSelect: false },
    ])
  })

  it('defaults text format and choice multi-select', () => {
    const payload = parsePanelPayload({ items: [{ kind: 'text', content: 'hi' }] })
    expect(payload.items[0]).toEqual({ kind: 'text', content: 'hi', format: 'plain' })
    expect(payload.interactive).toBe(false)
  })

  it('rejects an empty items array and an unknown kind', () => {
    expect(() => parsePanelPayload({ items: [] })).toThrow(/non-empty/)
    expect(() => parsePanelPayload({ items: [{ kind: 'video', source: 'x' }] })).toThrow(/kind/)
  })

  it('bounds the item count', () => {
    const items = Array.from({ length: 13 }, () => ({ kind: 'text', content: 'x' }))
    expect(() => parsePanelPayload({ items })).toThrow(/at most 12/)
  })

  it('rejects non-http(s) URL schemes and local paths containing a NUL byte', () => {
    expect(() => panelImageSource('file:///etc/passwd', 'source')).toThrow(/http\(s\)/)
    expect(() => panelImageSource('javascript:alert(1)', 'source')).toThrow(/http\(s\)/)
    expect(() => panelImageSource('/tmp/a\u0000.png', 'source')).toThrow(/NUL/)
    expect(panelImageSource('/tmp/a.png', 'source')).toBe('/tmp/a.png')
    expect(panelLinkUrl('http://example.com/a', 'url')).toBe('http://example.com/a')
    expect(() => panelLinkUrl('ftp://example.com', 'url')).toThrow(/http\(s\)/)
    expect(() => panelLinkUrl('not-a-url', 'url')).toThrow(/absolute/)
  })

  it('rejects a choice without options and a link without a label', () => {
    expect(() => parsePanelPayload({ items: [{ kind: 'choice', question: 'Q' }] })).toThrow(/options/)
    expect(() => parsePanelPayload({ items: [{ kind: 'link', url: 'https://example.com' }] })).toThrow(/label/)
  })
})

describe('panel detail wire contract', () => {
  it('round-trips a normalized payload only for panel-owned questions', () => {
    const original = parsePanelPayload(imageArgs)
    const request = { questions: [{ id: 'x', question: 'q', header: PIXIES_PANEL_HEADER, detail: JSON.stringify(original) }] }
    expect(decodePanelDetail(request)).toEqual(original)
    expect(decodePanelDetail({ questions: [{ header: 'Other UI' }] })).toBeUndefined()
    expect(decodePanelDetail({ questions: [{ header: PIXIES_PANEL_HEADER, detail: '{' }] })).toBeUndefined()
    expect(decodePanelDetail(null)).toBeUndefined()
  })

  it('rejects a malformed normalized payload', () => {
    expect(() => parsePanelPayloadWire({ version: 99, items: [], interactive: false })).toThrow(/version/)
    expect(() => parsePanelPayloadWire({ version: 1, items: [{ kind: 'text', content: 'x' }], interactive: 'yes' })).toThrow(/interactive/)
  })

  it('projects a pure, lossless result meta', () => {
    const payload = parsePanelPayload(imageArgs)
    const answers = [{ id: panelChoiceId(0), selected: ['Yes'], custom: 'note' }]
    const meta = panelResultMeta(payload, answers)
    expect(meta).toEqual({
      pixiesPanel: {
        version: 1,
        title: 'Result',
        items: payload.items.map(item => ({ ...item })),
        interactive: false,
        answers: [{ id: panelChoiceId(0), selected: ['Yes'], custom: 'note' }],
      },
    })
    expect(panelResultMeta(payload, answers)).toEqual(meta)
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta)
  })
})

describe('show_result_panel tool', () => {
  it('registers a model-facing schema with the four kinds', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'show_result_panel')
    expect(schema).toMatchObject({
      name: 'show_result_panel',
      parameters: { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] },
    })
    const properties = (schema?.parameters as { properties: { items: { items: { properties: Record<string, unknown> } } } })
      .properties.items.items.properties
    expect(properties).toHaveProperty('kind')
    expect(properties).toHaveProperty('source')
    expect(properties).toHaveProperty('options')
    expect(properties).toHaveProperty('url')
  })

  it('sends a display-only question for a non-interactive panel and returns once acknowledged', async () => {
    const seen: AskUserQuestionRequest[] = []
    const ctx = await setup((request) => { seen.push(request) })
    const result = await execute(ctx, imageArgs)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.questions[0]).toMatchObject({
      id: PIXIES_PANEL_DISPLAY_ID,
      header: PIXIES_PANEL_HEADER,
    })
    expect(decodePanelDetail(seen[0])).toEqual(parsePanelPayload(imageArgs))
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'Shown a result panel with 3 item(s).' }],
    })
  })

  it('pauses on the question seam for a choice and returns the answer', async () => {
    const seen: AskUserQuestionRequest[] = []
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    ctx.on('user-questions/request', (request) => {
      seen.push(request)
      return Promise.resolve({ answers: [{ id: request.questions[0]?.id ?? '', selected: ['Yes'] }] })
    })
    await ctx.plugin(panel)
    const result = await execute(ctx, {
      items: [{ kind: 'choice', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.questions[0]).toMatchObject({ id: panelChoiceId(0), header: PIXIES_PANEL_HEADER })
    expect(decodePanelDetail(seen[0])?.items[0]?.kind).toBe('choice')
    expect(result).toMatchObject({ isError: false })
    expect(JSON.stringify(result)).toContain('"selected":["Yes"]')
  })

  it('surfaces malformed arguments as a tool error instead of a UI crash', async () => {
    const ctx = await setup()
    const result = await execute(ctx, { items: [{ kind: 'link', label: 'x', url: 'javascript:alert(1)' }] })
    expect(result.isError).toBe(true)
  })

  it('unregisters the tool when its plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    const fiber = await ctx.plugin(panel)
    expect(ctx.tools.schemas().some(tool => tool.name === 'show_result_panel')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(tool => tool.name === 'show_result_panel')).toBe(false)
  })
})
