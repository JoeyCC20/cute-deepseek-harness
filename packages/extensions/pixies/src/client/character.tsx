/**
 * Pixies character presentation components: an illustrated Spider-Man mask, a
 * speech bubble, the legacy combined panel, and the control buttons. Product
 * copy is locale-owned (`locale.ts`); components only render what callers pass.
 * @module @deepseek-ai/dsh-pixies/client/character
 */

import { createElement, useId, type CSSProperties, type ReactElement } from 'react'
import type { PixiesMood } from '../types.ts'
import type { PixiesClientState } from './store.ts'
import { resolvePixiesMessages, type PixiesPanelMessages } from './locale.ts'

export type { PixiesPanelMessages } from './locale.ts'

/** Tapered mask silhouette shared by the fill, outline, and web clipping. */
const HEAD_PATH = 'M50 7 C29 9 14 27 14 50 C14 74 30 93 50 96 C70 93 86 74 86 50 C86 27 71 9 50 7 Z'
const WEB_LINES = [
  'M50 50 L50 8', 'M50 50 L21 19', 'M50 50 L14 50', 'M50 50 L22 81',
  'M50 50 L50 95', 'M50 50 L78 81', 'M50 50 L86 50', 'M50 50 L79 19',
].join(' ')
const LEFT_EYE = 'M18 43 C24 32 38 29 47 39 C45 51 34 58 22 55 C19 52 18 47 18 43 Z'
const RIGHT_EYE = 'M82 43 C76 32 62 29 53 39 C55 51 66 58 78 55 C81 52 82 47 82 43 Z'

/** Accent per mood: the halo and eyes react without changing the identity. */
const MOOD_ACCENT: Record<PixiesMood, { readonly glow: string; readonly eye: string }> = {
  neutral: { glow: '#ff3b45', eye: '#ffffff' },
  happy: { glow: '#ffc247', eye: '#fff8e8' },
  thinking: { glow: '#5aa9ff', eye: '#e9f4ff' },
  asking: { glow: '#ffa64d', eye: '#fff0dc' },
}

/**
 * Illustrated Spider-Man mask with a soft pulsing halo, a web pattern clipped
 * to the head, and mood-reactive eyes. Self-contained SVG: no image assets, no
 * stylesheet, so it renders identically in the transparent Electron window and
 * in plain web pages.
 * @param size - rendered edge length in CSS pixels.
 * @param mood - expression accent.
 * @param glow - whether to draw the animated halo (mini avatar, headers).
 */
export function PixiesCharacter({ size = 96, mood = 'neutral', glow = false }: {
  size?: number
  mood?: PixiesMood
  glow?: boolean
}): ReactElement {
  const prefix = useId().replaceAll(':', '')
  const headGradient = `${prefix}-head`
  const haloGradient = `${prefix}-halo`
  const clip = `${prefix}-clip`
  const accent = MOOD_ACCENT[mood]
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 100 100',
    role: 'img',
    'data-testid': 'pixies-character',
    'data-mood': mood,
    style: { display: 'block', overflow: 'visible' },
  },
  createElement('defs', null,
    createElement('linearGradient', { id: headGradient, x1: '0', y1: '0', x2: '1', y2: '1' },
      createElement('stop', { offset: '0', stopColor: '#ff4b52' }),
      createElement('stop', { offset: '0.55', stopColor: '#d81e27' }),
      createElement('stop', { offset: '1', stopColor: '#9c0d18' }),
    ),
    createElement('radialGradient', { id: haloGradient },
      createElement('stop', { offset: '0', stopColor: accent.glow, stopOpacity: '0.55' }),
      createElement('stop', { offset: '1', stopColor: accent.glow, stopOpacity: '0' }),
    ),
    createElement('clipPath', { id: clip }, createElement('path', { d: HEAD_PATH })),
  ),
  glow ? createElement('circle', {
    cx: 50, cy: 50, r: 49, fill: `url(#${haloGradient})`,
  }, createElement('animate', {
    attributeName: 'opacity', values: '0.6;1;0.6', dur: '3s', repeatCount: 'indefinite',
  })) : null,
  createElement('path', { d: HEAD_PATH, fill: `url(#${headGradient})`, stroke: '#6f0912', strokeWidth: 2 }),
  createElement('g', { clipPath: `url(#${clip})`, stroke: 'rgba(45,0,6,0.38)', strokeWidth: 1.15, fill: 'none' },
    createElement('path', { d: WEB_LINES }),
    createElement('circle', { cx: 50, cy: 50, r: 15, stroke: 'rgba(45,0,6,0.30)' }),
    createElement('circle', { cx: 50, cy: 50, r: 27, stroke: 'rgba(45,0,6,0.26)' }),
    createElement('circle', { cx: 50, cy: 50, r: 39, stroke: 'rgba(45,0,6,0.22)' }),
  ),
  createElement('path', { d: HEAD_PATH, fill: 'none', stroke: 'rgba(255,255,255,0.22)', strokeWidth: 1 }),
  createElement('path', { d: LEFT_EYE, fill: accent.eye, stroke: '#141419', strokeWidth: 2.4, strokeLinejoin: 'round' }),
  createElement('path', { d: RIGHT_EYE, fill: accent.eye, stroke: '#141419', strokeWidth: 2.4, strokeLinejoin: 'round' }),
  createElement('ellipse', { cx: 33, cy: 41, rx: 4, ry: 2.4, fill: 'rgba(90,160,220,0.45)' }),
  createElement('ellipse', { cx: 67, cy: 41, rx: 4, ry: 2.4, fill: 'rgba(90,160,220,0.45)' }),
  )
}

const BUBBLE_STYLE: CSSProperties = {
  maxWidth: 280,
  padding: '10px 14px',
  borderRadius: 14,
  background: 'rgba(255,255,255,0.94)',
  color: '#17181f',
  fontSize: 14,
  lineHeight: 1.5,
  boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
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

function interactionText(interaction: NonNullable<PixiesClientState['interaction']>, messages: PixiesPanelMessages): string {
  const copy = resolvePixiesMessages(messages)
  const headline = interaction.kind === 'approval' ? copy.approval : copy.question
  return `${headline}${interaction.summary === '' ? '' : `：${interaction.summary}`}`
}

/**
 * The legacy character-plus-bubble panel: the latest presentation, or the
 * pending interaction, or the live speech draft. Kept for non-shell pages and
 * existing consumers; the Electron shell renders the conversation view.
 * @param state - current store snapshot.
 * @param messages - localized interaction copy.
 * @param showIdleCharacter - render the bare character while the store is idle.
 * @param speechDraft - live speech-input draft plus the last failure reason.
 */
export function PixiesPanel({ state, messages, showIdleCharacter = false, speechDraft }: {
  state: PixiesClientState
  messages: PixiesPanelMessages
  showIdleCharacter?: boolean
  speechDraft?: { readonly listening: boolean; readonly partial: string; readonly error?: string }
}): ReactElement | null {
  const copy = resolvePixiesMessages(messages)
  const { latest, interaction, pendingSession } = state
  const listening = speechDraft?.listening === true
  const speechError = speechDraft?.error !== undefined && speechDraft.error !== '' ? speechDraft.error : undefined
  const draftText = listening
    ? (speechDraft.partial !== '' ? speechDraft.partial : copy.listening)
    : undefined
  if (latest === undefined && interaction === undefined && draftText === undefined && speechError === undefined
    && pendingSession === undefined) {
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
  if (latest === undefined && state.pendingSession !== undefined) {
    return createElement('div', { 'data-testid': 'pixies-panel', style: PANEL_STYLE },
      createElement(PixiesCharacter),
      createElement(PixiesBubble, { text: copy.thinking, mood: 'thinking' }),
    )
  }
  const text = latest?.text ?? (interaction !== undefined ? interactionText(interaction, messages) : '')
  const mood = latest?.mood ?? (interaction !== undefined ? 'asking' : 'neutral')
  return createElement('div', { 'data-testid': 'pixies-panel', style: PANEL_STYLE },
    createElement(PixiesCharacter),
    createElement(PixiesBubble, { text, mood }),
  )
}

/**
 * Animated halo around the mini avatar: a red pulse while listening, a blue
 * rotating dashed ring while thinking. SVG animation keeps the transparent
 * Electron window stylesheet-free.
 * @param mode - which round is active.
 * @param tone - stroke color.
 * @param testId - stable marker for tests.
 */
function StatusRing({ mode, tone, testId }: {
  mode: 'listening' | 'thinking'
  tone: string
  testId: string
}): ReactElement {
  const thinking = mode === 'thinking'
  return createElement('svg', {
    width: '100%',
    height: '100%',
    viewBox: '0 0 112 112',
    'aria-hidden': true,
    'data-testid': testId,
    style: { position: 'absolute', inset: 0, pointerEvents: 'none' },
  },
  createElement('circle', {
    cx: 56, cy: 56, r: 47, fill: 'none', stroke: tone, strokeWidth: 2, opacity: 0.85,
    strokeDasharray: thinking ? '12 14' : undefined,
    strokeLinecap: thinking ? 'round' : undefined,
  },
  thinking
    ? createElement('animateTransform', {
      attributeName: 'transform', type: 'rotate',
      from: '0 56 56', to: '360 56 56', dur: '2.4s', repeatCount: 'indefinite',
    })
    : createElement('animate', {
      attributeName: 'r', values: '47;54;47', dur: '1.4s', repeatCount: 'indefinite',
    }),
  createElement('animate', {
    attributeName: 'opacity',
    values: thinking ? '0.35;0.95;0.35' : '0.85;0.12;0.85',
    dur: thinking ? '2.4s' : '1.4s',
    repeatCount: 'indefinite',
  }),
  ),
  )
}

/** Red pulsing halo for a live voice-command round. */
export function PixiesListeningRing(): ReactElement {
  return createElement(StatusRing, { mode: 'listening', tone: '#ff4b52', testId: 'pixies-listening-ring' })
}

/** Blue rotating halo for the wait between a submitted prompt and its reply. */
export function PixiesThinkingRing(): ReactElement {
  return createElement(StatusRing, { mode: 'thinking', tone: '#5aa9ff', testId: 'pixies-thinking-ring' })
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
  flexShrink: 0,
}

/** Shared SVG command that both control icons use. */
function ControlIcon({ path }: { path: string }): ReactElement {
  return createElement('svg',
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
    createElement('rect', { x: 9, y: 2, width: 6, height: 12, rx: 3, display: path === 'mic' ? undefined : 'none' }),
    createElement('path', { d: path === 'mic' ? 'M5 10v1a7 7 0 0 0 14 0v-1' : 'M6 14l6-6 6 6' }),
    createElement('path', { d: 'M12 18v4', display: path === 'mic' ? undefined : 'none' }),
  )
}

/**
 * The mic toggle for speech input; `active` marks a live listening round.
 * @param active - whether speech recognition is running.
 * @param label - localized aria-label.
 * @param onClick - click handler (start/stop speech).
 * @param style - caller-owned style overrides.
 */
export function PixiesMicButton({ active, label, onClick, style }: {
  active: boolean
  label: string
  onClick: () => void
  style?: CSSProperties
}): ReactElement {
  return createElement('button',
    {
      type: 'button',
      'aria-label': label,
      'data-testid': 'pixies-mic',
      'data-active': active ? '' : undefined,
      style: {
        ...CONTROL_BUTTON_STYLE,
        background: active ? '#d81e27' : 'rgba(255,255,255,0.10)',
        ...style,
      },
      onClick,
    },
    createElement(ControlIcon, { path: 'mic' }),
  )
}

/** Speaker icon: sound waves when voice replies are on, a cross when muted. */
function VoiceIcon({ muted }: { muted: boolean }): ReactElement {
  return createElement('svg',
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
    createElement('path', { d: 'M11 5 6 9H3v6h3l5 4V5Z' }),
    createElement('path', { d: muted ? 'M17 9l5 6M22 9l-5 6' : 'M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13' }),
  )
}

/**
 * Voice-reply toggle; `active` means assistant replies are spoken, and
 * `speaking` marks an utterance currently in flight.
 * @param active - whether voice replies are enabled.
 * @param speaking - whether a reply is being spoken right now.
 * @param label - localized aria-label.
 * @param onClick - click handler (toggle voice replies).
 * @param style - caller-owned style overrides.
 */
export function PixiesVoiceButton({ active, speaking, label, onClick, style }: {
  active: boolean
  speaking: boolean
  label: string
  onClick: () => void
  style?: CSSProperties
}): ReactElement {
  return createElement('button',
    {
      type: 'button',
      'aria-label': label,
      'data-testid': 'pixies-voice',
      'data-muted': active ? undefined : '',
      'data-speaking': speaking ? '' : undefined,
      style: {
        ...CONTROL_BUTTON_STYLE,
        background: active ? (speaking ? '#c91520' : 'rgba(255,255,255,0.10)') : 'rgba(0,0,0,0.35)',
        ...style,
      },
      onClick,
    },
    createElement(VoiceIcon, { muted: !active }),
  )
}

/**
 * The collapse button that shrinks the panel back to the mini peek avatar.
 * @param label - localized aria-label.
 * @param onClick - click handler (collapse).
 * @param style - caller-owned style overrides.
 */
export function PixiesCollapseButton({ label, onClick, style }: {
  label: string
  onClick: () => void
  style?: CSSProperties
}): ReactElement {
  return createElement('button',
    {
      type: 'button',
      'aria-label': label,
      'data-testid': 'pixies-collapse',
      style: { ...CONTROL_BUTTON_STYLE, ...style },
      onClick,
    },
    createElement(ControlIcon, { path: 'collapse' }),
  )
}
