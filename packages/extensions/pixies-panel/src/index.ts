/**
 * Model-facing `show_result_panel` tool over `ctx.tools`, `ctx.userQuestions`,
 * and `ctx.systemPrompt`. The tool is a Service Provider: it owns the tool
 * schema, normalizes one bounded panel payload, and (for choice items) pauses
 * on the user-questions waterfall until the Pixies panel answers. The panel
 * window itself is a Consumer owned by the Pixies Electron shell.
 *
 * @module @deepseek-ai/dsh-pixies-panel
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  assertNever,
  encodePanelDetail,
  PIXIES_PANEL_DISPLAY_ID,
  PIXIES_PANEL_HEADER,
  panelChoiceId,
  panelResultMeta,
  parsePanelPayload,
  type PixiesPanelAnswer,
  type PixiesPanelItem,
  type PixiesPanelPayload,
} from './types.ts'

export {
  assertNever,
  decodePanelDetail,
  encodePanelDetail,
  PIXIES_PANEL_DISPLAY_ID,
  PIXIES_PANEL_HEADER,
  panelChoiceId,
  panelImageSource,
  panelLinkUrl,
  panelResultMeta,
  parsePanelPayload,
  parsePanelPayloadWire,
  PIXIES_PANEL_VERSION,
  MAX_PANEL_ITEMS,
} from './types.ts'
export type {
  PixiesPanelAnswer,
  PixiesPanelChoiceOption,
  PixiesPanelItem,
  PixiesPanelItemKind,
  PixiesPanelPayload,
} from './types.ts'

/** Function-plugin identity for the host composition row. */
export const name = 'pixies-panel'

/** Services the tool consumes; `userQuestions` is only awaited for choices. */
export const inject = ['tools', 'userQuestions']

const DESCRIPTION = 'Show a compact, self-contained result panel to the user. '
  + 'Call it when you have a concrete result worth seeing outside the transcript: an image, a computed or queried result, '
  + 'a set of links, or a short choice the user must make (confirm/authorize/select). '
  + 'Decide for yourself whether the result benefits from a panel; do NOT call it for short plain-text answers, '
  + 'intermediate reasoning steps, or progress updates. '
  + 'Each item has a `kind` of "image" (local path or http(s) URL in `source`), "text" (`content`, optional `format` markdown), '
  + '"choice" (`question`, non-empty `options` with labels, optional `multi_select`), or "link" (`label`, http(s) `url`). '
  + 'A choice item pauses the call until the user answers; the selected labels are returned. '
  + 'Whether you can call this tool, and whether you can interpret images, depends on your own capabilities.'

/** Convert one normalized item into a user-questions item, if it needs a human answer. */
function questionForItem(item: PixiesPanelItem, index: number, payload: PixiesPanelPayload): AskUserQuestionItem | undefined {
  switch (item.kind) {
    case 'image': return undefined
    case 'text': return undefined
    case 'link': return undefined
    case 'choice': return {
      id: panelChoiceId(index),
      question: item.question,
      header: PIXIES_PANEL_HEADER,
      // The first question carries the whole payload. The Client answerer
      // decodes it to render the panel, so no new session event is needed.
      ...index === payload.items.findIndex(candidate => candidate.kind === 'choice')
        ? { detail: encodePanelDetail(payload) }
        : {},
      options: item.options.map(option => ({
        label: option.label,
        ...option.description !== undefined ? { description: option.description } : {},
      })),
      multiSelect: item.multiSelect,
    }
    default: return assertNever(item)
  }
}

/**
 * A panel with no choice still needs one forwarded question to carry its
 * payload to the Client. The panel answerer acknowledges it with no answers,
 * so a pure presentation never waits for a human decision.
 * @param payload - normalized panel payload.
 * @returns the display-only question carrying the whole payload.
 */
function displayQuestion(payload: PixiesPanelPayload): AskUserQuestionItem {
  return {
    id: PIXIES_PANEL_DISPLAY_ID,
    question: 'Result panel',
    header: PIXIES_PANEL_HEADER,
    detail: encodePanelDetail(payload),
    options: [{ label: 'OK' }],
    multiSelect: false,
  }
}

/**
 * Register the tool as a Cordis effect. The registry's own `register()` returns
 * a disposer, so wrapping it in `ctx.effect()` unregisters on HMR/plugin teardown.
 * @param ctx - host root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'show_result_panel',
    description: DESCRIPTION,
    parameters: {
      title: { type: 'string', description: 'Optional short heading for the panel.' },
      items: {
        type: 'array',
        required: true,
        description: 'One to twelve result items, rendered in order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              enum: ['image', 'text', 'choice', 'link'],
              required: true,
              description: 'image, text, choice, or link.',
            },
            source: { type: 'string', description: 'image: a local file path or an http(s) URL.' },
            alt: { type: 'string', description: 'image: alternative text.' },
            content: { type: 'string', description: 'text: the content to show.' },
            format: { type: 'string', enum: ['plain', 'markdown'], description: 'text: plain (default) or markdown.' },
            question: { type: 'string', description: 'choice: the question to ask.' },
            options: {
              type: 'array',
              description: 'choice: selectable answers.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string', required: true, description: 'Short answer label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff.' },
                },
              },
            },
            multi_select: { type: 'boolean', description: 'choice: allow more than one selected label.' },
            label: { type: 'string', description: 'link: the clickable text.' },
            url: { type: 'string', description: 'link: an absolute http(s) URL opened in the default browser.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shown: { type: 'boolean', required: true },
          items: { type: 'integer', required: true },
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.answers.length === 0
          ? `Shown a result panel with ${value.items} item(s).`
          : `Shown a result panel with ${value.items} item(s). User answers: ${JSON.stringify(value.answers)}`,
      }],
      presentationMeta: (args, value) => {
        try {
          return panelResultMeta(parsePanelPayload(args), value.answers)
        } catch {
          // Replay-only presenters degrade to no UI fact for obsolete payloads.
          return {}
        }
      },
    },
    async execute(args, exec) {
      const payload = parsePanelPayload(args)
      const questions = payload.items
        .map((item, index) => questionForItem(item, index, payload))
        .filter((question): question is AskUserQuestionItem => question !== undefined)
      if (questions.length === 0) questions.push(displayQuestion(payload))
      const result = await ctx.userQuestions.ask({
        questions,
        ...exec.agent !== undefined ? { agent: exec.agent } : {},
        signal: exec.signal,
      })
      const answers: PixiesPanelAnswer[] = []
      for (const answer of result.answers) {
        if (answer.id === PIXIES_PANEL_DISPLAY_ID) continue
        answers.push({
          id: answer.id,
          selected: [...answer.selected],
          ...answer.custom !== undefined ? { custom: answer.custom } : {},
        })
      }
      return { shown: true, items: payload.items.length, answers }
    },
  })), 'pixies-panel: show_result_panel')
}
