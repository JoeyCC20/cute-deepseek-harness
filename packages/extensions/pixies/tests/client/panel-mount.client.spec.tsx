/**
 * @vitest-environment jsdom
 *
 * The standalone panel face mounts beside, not inside, the generic app root.
 * Pixies injects `body>*:not([data-pixies-shell]){display:none!important}`, so
 * an unmarked overlay renders content that the user can never see.
 */

import { fireEvent } from '@testing-library/react'
import {
  PIXIES_PANEL_DISPLAY_ID, PIXIES_PANEL_HEADER, parsePanelPayload,
} from '@deepseek-ai/dsh-pixies-panel/types'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPixiesPanelController } from '../../src/client/panel-answerer.ts'
import type { PixiesPanelBridge } from '../../src/client/panel-bridge.ts'
import { mountPixiesResultPanel } from '../../src/client/panel.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ''
  document.body.style.removeProperty('background')
  document.documentElement.style.removeProperty('background')
})

describe('result-panel item rendering', () => {
  /** Claim a display-only request carrying one payload. */
  function claim(
    controller: ReturnType<typeof createPixiesPanelController>,
    payload: ReturnType<typeof parsePanelPayload>,
  ): void {
    void controller.claim({
      questions: [{
        id: PIXIES_PANEL_DISPLAY_ID,
        question: 'Result panel',
        header: PIXIES_PANEL_HEADER,
        detail: JSON.stringify({ ...payload, interactive: false }),
      }],
    })
  }

  it('renders markdown items and delegates their links through the bridge', () => {
    const payload = parsePanelPayload({
      items: [{ kind: 'text', content: '**粗体** 与 [文档](https://example.com)', format: 'markdown' }],
    })
    const controller = createPixiesPanelController(() => {})
    const openExternal = vi.fn(async () => true)
    const bridge = {
      showResultPanel: () => {},
      setPanelHeight: () => {},
      hideResultPanel: () => {},
      setPanelHover: () => {},
      getPanelSettings: async () => ({}),
      setPanelSettings: async () => ({}),
      openExternal,
      onPanelSettings: () => () => {},
    } as unknown as PixiesPanelBridge
    claim(controller, payload)

    let handle!: ReturnType<typeof mountPixiesResultPanel>
    act(() => { handle = mountPixiesResultPanel({ controller, bridge }) })
    const host = document.getElementById('pixies-result-panel')
    expect(host?.querySelector('strong')?.textContent).toBe('粗体')
    const link = host?.querySelector('a[href="https://example.com"]')
    expect(link).not.toBeNull()
    fireEvent.click(link!)
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
    handle.unmount()
  })

  it('pauses and resumes the auto-hide countdown as the pointer enters and leaves', () => {
    const payload = parsePanelPayload({ items: [{ kind: 'text', content: '结果', format: 'plain' }] })
    const controller = createPixiesPanelController(() => {})
    const setPanelHover = vi.fn()
    const bridge = {
      showResultPanel: () => {},
      setPanelHeight: () => {},
      hideResultPanel: () => {},
      setPanelHover,
      getPanelSettings: async () => ({}),
      setPanelSettings: async () => ({}),
      openExternal: async () => true,
      onPanelSettings: () => () => {},
    } as unknown as PixiesPanelBridge
    claim(controller, payload)
    let handle!: ReturnType<typeof mountPixiesResultPanel>
    act(() => { handle = mountPixiesResultPanel({ controller, bridge }) })
    const panel = document.getElementById('pixies-result-panel')!.firstElementChild!
    act(() => { fireEvent.mouseOver(panel) })
    expect(setPanelHover).toHaveBeenLastCalledWith(true)
    act(() => { fireEvent.mouseOut(panel) })
    expect(setPanelHover).toHaveBeenLastCalledWith(false)
    handle.unmount()
  })

  it('keeps plain text items verbatim', () => {
    const payload = parsePanelPayload({
      items: [{ kind: 'text', content: '**粗体**', format: 'plain' }],
    })
    const controller = createPixiesPanelController(() => {})
    claim(controller, payload)

    let handle!: ReturnType<typeof mountPixiesResultPanel>
    act(() => { handle = mountPixiesResultPanel({ controller, bridge: undefined }) })
    const host = document.getElementById('pixies-result-panel')
    expect(host?.querySelector('strong')).toBeNull()
    expect(host?.textContent).toContain('**粗体**')
    handle.unmount()
  })
})

describe('mountPixiesResultPanel', () => {
  it('mounts a marked overlay outside #root and removes it on teardown', () => {
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)

    const handle = mountPixiesResultPanel({
      controller: createPixiesPanelController(() => {}),
      bridge: undefined,
    })
    const host = document.getElementById('pixies-result-panel')

    expect(host).not.toBeNull()
    expect(host?.parentElement).toBe(document.body)
    expect(host?.hasAttribute('data-pixies-shell')).toBe(true)
    expect(host?.style.position).toBe('fixed')
    expect(appRoot.children).toHaveLength(0)
    expect(document.body.style.getPropertyValue('background')).toBe('transparent')
    expect(document.body.style.getPropertyPriority('background')).toBe('important')
    expect(document.documentElement.style.getPropertyValue('background')).toBe('transparent')

    handle.unmount()
    expect(document.getElementById('pixies-result-panel')).toBeNull()
    expect(document.body.style.getPropertyValue('background')).toBe('')
  })

  it('restores a pre-existing inline background on teardown', () => {
    document.body.style.background = 'red'
    const handle = mountPixiesResultPanel({
      controller: createPixiesPanelController(() => {}),
      bridge: undefined,
    })
    expect(document.body.style.getPropertyValue('background')).toBe('transparent')

    handle.unmount()
    expect(document.body.style.background).toBe('red')
    document.body.style.removeProperty('background')
  })
})
