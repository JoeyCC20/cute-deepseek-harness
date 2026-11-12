/** Result-panel bridge helpers and the question-waterfall controller. */
import { afterEach, describe, expect, it } from 'vitest'
import {
  PIXIES_PANEL_DISPLAY_ID,
  PIXIES_PANEL_HEADER,
  parsePanelPayload,
} from '@deepseek-ai/dsh-pixies-panel/types'
import type { AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import {
  createPixiesPanelController,
} from '../../src/client/panel-answerer.ts'
import {
  panelImageUrl,
  readPanelSettings,
  resolvePixiesPanelBridge,
} from '../../src/client/panel-bridge.ts'

function request(items: readonly unknown[], interactive: boolean): AskUserQuestionRequestEvent {
  const questions = [{
    id: PIXIES_PANEL_DISPLAY_ID,
    question: 'Result panel',
    header: PIXIES_PANEL_HEADER,
    detail: JSON.stringify({
      ...parsePanelPayload({ items }),
      interactive,
    }),
  }]
  return { questions }
}

const textItems = [{ kind: 'text', content: 'hi' }]
const choiceItems = [{ kind: 'choice', question: 'Proceed?', options: [{ label: 'Yes' }], multi_select: false }]

afterEach(() => {
  delete (globalThis as Record<string, unknown>).dshPixies
})

describe('panel-bridge wire helpers', () => {
  it('narrows only a complete settings snapshot', () => {
    expect(readPanelSettings({ enabled: true, autoHideMs: 10_000 }))
      .toEqual({ enabled: true, autoHideMs: 10_000 })
    expect(readPanelSettings({ enabled: false, autoHideMs: null }))
      .toEqual({ enabled: false, autoHideMs: null })
    expect(readPanelSettings({ autoHideMs: 500 })).toBeUndefined()
    expect(readPanelSettings({ enabled: true, autoHideMs: 'never' })).toBeUndefined()
    expect(readPanelSettings(null)).toBeUndefined()
  })

  it('keeps remote URLs and routes local paths through the Host file API', () => {
    expect(panelImageUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(panelImageUrl('http://example.com/a.png')).toBe('http://example.com/a.png')
    expect(panelImageUrl('/tmp/my chart.png')).toBe('/api/file?path=%2Ftmp%2Fmy%20chart.png')
  })

  it('resolves the bridge only when every method is present', () => {
    const bridge = {
      showResultPanel: () => {},
      hideResultPanel: () => {},
      getPanelSettings: async () => ({}),
      setPanelSettings: async () => ({}),
      openExternal: async () => true,
      onPanelSettings: () => () => {},
    }
    expect(resolvePixiesPanelBridge()).toBeUndefined()
    ;(globalThis as Record<string, unknown>).dshPixies = { showResultPanel: () => {} }
    expect(resolvePixiesPanelBridge()).toBeUndefined()
    ;(globalThis as Record<string, unknown>).dshPixies = bridge
    expect(resolvePixiesPanelBridge()).toBe(bridge)
  })
})

describe('createPixiesPanelController', () => {
  it('delegates requests that are not panel-owned', () => {
    const shown: unknown[] = []
    const controller = createPixiesPanelController((payload) => { shown.push(payload) })
    expect(controller.claim({ questions: [{ id: 'x', question: 'q', header: 'Other UI' }] })).toBeUndefined()
    expect(shown).toHaveLength(0)
    expect(controller.getSnapshot().pending).toBeUndefined()
  })

  it('renders a non-interactive panel and acknowledges it immediately', async () => {
    const shown: unknown[] = []
    const controller = createPixiesPanelController((payload) => { shown.push(payload) })
    const result = controller.claim(request(textItems, false))
    expect(result).toBeDefined()
    await expect(result).resolves.toEqual({ answers: [] })
    expect(shown).toHaveLength(1)
    expect(controller.getSnapshot().pending?.payload.items[0]?.kind).toBe('text')
    expect(controller.getSnapshot().awaitingAnswer).toBe(false)
  })

  it('waits for a choice answer and resolves it on submit', async () => {
    const controller = createPixiesPanelController(() => {})
    const result = controller.claim(request(choiceItems, true))
    expect(controller.getSnapshot().awaitingAnswer).toBe(true)
    controller.submit({ answers: [{ id: 'item-0', selected: ['Yes'] }] })
    await expect(result).resolves.toEqual({ answers: [{ id: 'item-0', selected: ['Yes'] }] })
    expect(controller.getSnapshot().awaitingAnswer).toBe(false)
  })

  it('supersedes an unanswered choice with the next result and rejects on dispose', async () => {
    const controller = createPixiesPanelController(() => {})
    const first = controller.claim(request(choiceItems, true))
    const rejection = expect(first).rejects.toThrow(/superseded/)
    await controller.claim(request(textItems, false))
    await rejection

    const second = controller.claim(request(choiceItems, true))
    const disposed = expect(second).rejects.toThrow(/disposed/)
    controller.dispose()
    await disposed
    expect(controller.getSnapshot().pending).toBeUndefined()
  })
})
