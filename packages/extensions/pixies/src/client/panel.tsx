/**
 * Lightweight renderer for the standalone Pixies result panel. It derives
 * everything from the claimed question payload; the Electron shell owns the
 * window, the translucent blur, and the auto-hide timer.
 * @module @deepseek-ai/dsh-pixies/client/panel
 */

import {
  createElement, useEffect, useState,
  type CSSProperties, type ReactElement,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { panelChoiceId } from '@deepseek-ai/dsh-pixies-panel/types'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  resolvePixiesMessages, type PixiesPanelMessages, type PixiesResolvedMessages,
} from './locale.ts'
import type { PixiesPanelController } from './panel-answerer.ts'
import { panelImageUrl, type PixiesPanelBridge } from './panel-bridge.ts'

const ROOT: CSSProperties = {
  boxSizing: 'border-box', height: '100vh', overflowY: 'auto',
  padding: '14px 16px 18px', background: 'rgba(255,255,255,.16)',
  color: '#1f2329', fontFamily: '-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
  fontSize: 13, lineHeight: 1.55,
}
const HEADER: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }
const TITLE: CSSProperties = { flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600 }
const CLOSE: CSSProperties = {
  width: 24, height: 24, flexShrink: 0, display: 'grid', placeItems: 'center',
  border: 'none', borderRadius: 12, background: 'rgba(120,120,128,.12)',
  color: 'inherit', cursor: 'pointer',
}
const BLOCK: CSSProperties = { marginBottom: 10 }
const TEXT: CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }
const IMAGE: CSSProperties = { display: 'block', maxWidth: '100%', borderRadius: 8 }
const LINK: CSSProperties = {
  padding: 0, border: 'none', background: 'none', color: '#2563eb',
  cursor: 'pointer', textAlign: 'left', textDecoration: 'underline',
}
const CHOICE_OPTIONS: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }
const OPTION: CSSProperties = {
  padding: '5px 10px', border: '1px solid rgba(60,60,67,.2)', borderRadius: 14,
  background: 'rgba(255,255,255,.45)', color: 'inherit', cursor: 'pointer', fontSize: 12,
}
const OPTION_SELECTED: CSSProperties = { ...OPTION, background: '#2563eb', color: '#fff', borderColor: '#2563eb' }
const SUBMIT: CSSProperties = {
  marginTop: 8, padding: '7px 14px', border: 'none', borderRadius: 8,
  background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13,
}

/** Options for mounting the standalone result-panel face. */
export interface PixiesResultPanelMount {
  /** Controller that owns the claimed waterfall requests. */
  readonly controller: PixiesPanelController
  /** Electron bridge, or undefined outside the desktop shell. */
  readonly bridge: PixiesPanelBridge | undefined
  /** Optional caller-owned localized copy overrides. */
  readonly messages?: PixiesPanelMessages
}

interface PanelProps extends PixiesResultPanelMount {
  readonly copy: PixiesResolvedMessages
}

function CloseMark(): ReactElement {
  return createElement('svg', { width: 11, height: 11, viewBox: '0 0 12 12', 'aria-hidden': true },
    createElement('path', {
      d: 'M2 2 L10 10 M10 2 L2 10', stroke: 'currentColor', strokeWidth: 1.6, fill: 'none',
    }))
}

/**
 * One result panel: title, ordered items, optional choice questions, and a
 * close button that only hides the window (the next result wakes it again).
 */
export function PixiesResultPanel(props: PanelProps): ReactElement {
  const { controller, bridge, copy } = props
  const [snapshot, setSnapshot] = useState(controller.getSnapshot())
  const [selected, setSelected] = useState<Readonly<Record<string, readonly string[]>>>({})
  useEffect(() => controller.subscribe(() => { setSnapshot(controller.getSnapshot()) }), [controller])
  useEffect(() => { setSelected({}) }, [snapshot.pending])

  const pending = snapshot.pending
  if (pending === undefined) return createElement('div', { style: ROOT })
  const { payload, request } = pending

  const close = (): void => {
    // A still-awaited choice would otherwise leave the tool call blocked.
    if (snapshot.awaitingAnswer) controller.submit({ answers: [] })
    bridge?.hideResultPanel()
  }
  const toggle = (id: string, label: string, multiSelect: boolean): void => {
    setSelected((previous) => {
      const current = previous[id] ?? []
      const next = multiSelect
        ? current.includes(label) ? current.filter(value => value !== label) : [...current, label]
        : [label]
      return { ...previous, [id]: next }
    })
  }
  const submit = (): void => {
    controller.submit({
      answers: request.questions.map(question => ({
        id: question.id,
        selected: [...(selected[question.id] ?? [])],
      })),
    })
  }

  const blocks: ReactElement[] = []
  for (const [index, item] of payload.items.entries()) {
    switch (item.kind) {
      case 'image':
        blocks.push(createElement('div', { key: index, style: BLOCK },
          createElement('img', {
            style: IMAGE, src: panelImageUrl(item.source), alt: item.alt ?? copy.panelImageAlt,
          })))
        break
      case 'text':
        blocks.push(createElement('div', { key: index, style: { ...BLOCK, ...TEXT } }, item.content))
        break
      case 'link':
        blocks.push(createElement('div', { key: index, style: BLOCK },
          createElement('button', {
            type: 'button', style: LINK,
            onClick: () => { if (bridge !== undefined) void bridge.openExternal(item.url) },
          }, item.label)))
        break
      case 'choice': {
        const question: AskUserQuestionItem | undefined = request.questions.find(
          candidate => candidate.id === panelChoiceId(index),
        )
        if (question === undefined) break
        blocks.push(createElement('div', { key: index, style: BLOCK },
          createElement('div', null, item.question),
          createElement('div', { style: CHOICE_OPTIONS },
            ...(question.options ?? []).map(option => createElement('button', {
              key: option.label, type: 'button',
              style: (selected[question.id] ?? []).includes(option.label) ? OPTION_SELECTED : OPTION,
              onClick: () => { toggle(question.id, option.label, item.multiSelect) },
            }, option.label)))))
        break
      }
    }
  }

  return createElement('div', { style: ROOT },
    createElement('div', { style: HEADER },
      createElement('div', { style: TITLE }, payload.title ?? copy.panelTitle),
      createElement('button', {
        type: 'button', style: CLOSE, 'aria-label': copy.panelClose, onClick: close,
      }, createElement(CloseMark))),
    ...blocks,
    ...snapshot.awaitingAnswer
      ? [createElement('button', { key: 'submit', type: 'button', style: SUBMIT, onClick: submit }, copy.panelSubmit)]
      : [])
}

/**
 * Mount the panel face into `#root`.
 * @param options - controller, bridge, and optional localized copy overrides.
 * @returns the React root, unmounted by the caller on plugin disposal.
 */
export function mountPixiesResultPanel(options: PixiesResultPanelMount): Root {
  const host = document.getElementById('root')
  if (host === null) throw new Error('pixies result panel: #root is missing')
  const root = createRoot(host)
  root.render(createElement(PixiesResultPanel, {
    ...options,
    copy: resolvePixiesMessages(options.messages),
  }))
  return root
}
