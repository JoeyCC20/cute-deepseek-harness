/**
 * Pixies character presentation components: a Spider-Man head mark, a speech
 * bubble, and the combined panel driven by the store. Components carry no
 * hardcoded user-facing copy — interaction labels arrive as props from the
 * locale-owned caller.
 * @module @deepseek-ai/dsh-pixies/client/character
 */

import { createElement, type CSSProperties, type ReactElement } from 'react'
import type { PixiesInteraction, PixiesMood } from '../types.ts'
import type { PixiesClientState } from './store.ts'

/** Spider-Man head mark (mask + white eyes), placeholder art. */
export function PixiesCharacter({ size = 96 }: { size?: number }): ReactElement {
  return createElement('svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 100 100',
      role: 'img',
      'data-testid': 'pixies-character',
    },
    createElement('circle', { cx: 50, cy: 50, r: 48, fill: '#d81e27' }),
    createElement('circle', { cx: 50, cy: 50, r: 38, fill: '#1a1a1a' }),
    createElement('path', {
      d: 'M50 12 C34 20 26 34 26 52 C26 70 34 84 50 88 C66 84 74 70 74 52 C74 34 66 20 50 12 Z',
      fill: '#d81e27',
    }),
    createElement('ellipse', { cx: 38, cy: 46, rx: 12, ry: 15, fill: '#ffffff' }),
    createElement('ellipse', { cx: 62, cy: 46, rx: 12, ry: 15, fill: '#ffffff' }),
    createElement('ellipse', { cx: 38, cy: 46, rx: 5, ry: 8, fill: '#111111' }),
    createElement('ellipse', { cx: 62, cy: 46, rx: 5, ry: 8, fill: '#111111' }),
  )
}

const BUBBLE_STYLE: CSSProperties = {
  maxWidth: 240,
  padding: '10px 14px',
  borderRadius: 14,
  background: '#ffffff',
  color: '#111111',
  fontSize: 14,
  lineHeight: 1.4,
  boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
}

/** One speech bubble with a mood marker for styling hooks. */
export function PixiesBubble({ text, mood = 'neutral' }: { text: string; mood?: PixiesMood }): ReactElement {
  return createElement('div',
    { role: 'status', 'data-mood': mood, 'data-testid': 'pixies-bubble', style: BUBBLE_STYLE },
    text,
  )
}

const PANEL_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
}

/** Localized interaction labels; copy is owned by the locale caller. */
export interface PixiesPanelMessages {
  readonly approval: string
  readonly question: string
  /** Mini→expand click label (shell bridge present only). */
  readonly expand?: string
  /** Mic click label (shell bridge present only). */
  readonly mic?: string
  /** Mic active-state label. */
  readonly micActive?: string
  /** Collapse-to-mini click label. */
  readonly collapse?: string
  /** Bubble placeholder while listening with no partial text yet. */
  readonly listening?: string
  /** Bubble headline for a failed speech round (the reason is appended by the caller). */
  readonly speechFailed?: string
}

function interactionText(interaction: PixiesInteraction, messages: PixiesPanelMessages): string {
  return `${interaction.kind === 'approval' ? messages.approval : messages.question}${interaction.summary === '' ? '' : `：${interaction.summary}`}`
}

/**
 * The character plus its current speech: the latest presentation, or the
 * pending interaction when nothing is being spoken, or the live speech
 * draft while the mic is listening (the draft bubble replaces the spoken
 * one). Renders nothing while the store is empty and not listening, unless
 * `showIdleCharacter` keeps the character mark visible (the shell window's
 * always-on tray identity).
 * @param state - current store snapshot.
 * @param messages - localized interaction copy.
 * @param showIdleCharacter - render the bare character while the store is idle.
 * @param speechDraft - live speech-input draft (listening flag + partial text),
 * or `error`: the reason the last speech round failed. A failed round is the
 * only signal the user gets from the mic, so it always speaks.
 */
export function PixiesPanel({ state, messages, showIdleCharacter = false, speechDraft }: {
  state: PixiesClientState
  messages: PixiesPanelMessages
  showIdleCharacter?: boolean
  speechDraft?: { readonly listening: boolean; readonly partial: string; readonly error?: string }
}): ReactElement | null {
  const { latest, interaction } = state
  const listening = speechDraft?.listening === true
  const speechError = speechDraft?.error !== undefined && speechDraft.error !== '' ? speechDraft.error : undefined
  const draftText = listening
    ? (speechDraft?.partial !== undefined && speechDraft.partial !== '' ? speechDraft.partial : messages.listening)
    : undefined
  if (latest === undefined && interaction === undefined && draftText === undefined && speechError === undefined) {
    if (!showIdleCharacter) return null
    return createElement('div', { 'data-testid': 'pixies-panel', style: PANEL_STYLE },
      createElement(PixiesCharacter),
    )
  }
  if (speechError !== undefined) {
    return createElement('div', { 'data-testid': 'pixies-panel', style: PANEL_STYLE },
      createElement(PixiesCharacter),
      createElement(PixiesBubble, { text: speechError, mood: 'asking' }),
    )
  }
  if (draftText !== undefined) {
    return createElement('div', { 'data-testid': 'pixies-panel', style: PANEL_STYLE },
      createElement(PixiesCharacter),
      createElement(PixiesBubble, { text: draftText, mood: 'asking' }),
    )
  }
  const text = latest?.text ?? (interaction !== undefined ? interactionText(interaction, messages) : '')
  const mood = latest?.mood ?? (interaction !== undefined ? 'asking' : 'neutral')
  return createElement('div', { 'data-testid': 'pixies-panel', style: PANEL_STYLE },
    createElement(PixiesCharacter),
    createElement(PixiesBubble, { text, mood }),
  )
}

const CONTROL_BUTTON_STYLE: CSSProperties = {
  border: 'none',
  borderRadius: 999,
  width: 40,
  height: 40,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  background: 'rgba(17,17,17,0.72)',
  color: '#ffffff',
  boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
  padding: 0,
}

/**
 * The mic toggle for speech input; `active` marks a live listening round.
 * @param active - whether speech recognition is running.
 * @param label - localized aria-label.
 * @param onClick - click handler (start/stop speech).
 */
export function PixiesMicButton({ active, label, onClick }: {
  active: boolean
  label: string
  onClick: () => void
}): ReactElement {
  return createElement('button',
    {
      type: 'button',
      'aria-label': label,
      'data-testid': 'pixies-mic',
      'data-active': active ? '' : undefined,
      style: { ...CONTROL_BUTTON_STYLE, background: active ? '#d81e27' : 'rgba(17,17,17,0.72)' },
      onClick,
    },
    createElement('svg',
      {
        width: 18,
        height: 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      createElement('rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }),
      createElement('path', { d: 'M5 10v1a7 7 0 0 0 14 0v-1' }),
      createElement('path', { d: 'M12 18v4' }),
    ),
  )
}

/**
 * The collapse button that shrinks the panel back to the mini peek avatar.
 * @param label - localized aria-label.
 * @param onClick - click handler (collapse).
 */
export function PixiesCollapseButton({ label, onClick }: {
  label: string
  onClick: () => void
}): ReactElement {
  return createElement('button',
    {
      type: 'button',
      'aria-label': label,
      'data-testid': 'pixies-collapse',
      style: CONTROL_BUTTON_STYLE,
      onClick,
    },
    createElement('svg',
      {
        width: 18,
        height: 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      createElement('path', { d: 'M6 14l6-6 6 6' }),
    ),
  )
}
