/**
 * The two Pixies shell surfaces: a peeking, freely draggable Spider-Man avatar
 * and the expanded conversation panel (drag header, message history, composer,
 * voice input). All product copy comes from the locale dictionary; all styling
 * is inline so the transparent Electron window needs no host stylesheet.
 * @module @deepseek-ai/dsh-pixies/client/conversation
 */

import { createElement, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import {
  PixiesCharacter,
  PixiesCollapseButton,
  PixiesListeningRing,
  PixiesMicButton,
  PixiesThinkingRing,
  PixiesVoiceButton,
} from './character.tsx'
import type { PixiesResolvedMessages } from './locale.ts'
import type { PixiesClientState, PixiesMessage, PixiesMessageRole } from './store.ts'
import type { PixiesShellBridge, PixiesShellMode } from './shell.tsx'
import { usePixiesWindowDrag } from './window-drag.ts'

/** Everything either view needs; the shell owns the interaction state. */
export interface PixiesConversationProps {
  readonly copy: PixiesResolvedMessages
  readonly state: PixiesClientState
  readonly bridge: PixiesShellBridge | undefined
  readonly listening: boolean
  readonly partial: string
  readonly error: string
  /** A speech-output failure, shown apart from the conversation bubble. */
  readonly voiceError: string
  /** Whether a reply is currently being spoken. */
  readonly speaking: boolean
  /** Whether assistant replies are spoken aloud. */
  readonly voiceReplies: boolean
  /** Waiting for the first reply after a submitted prompt. */
  readonly awaitingReply: boolean
  readonly draft: string
  readonly onDraftChange: (value: string) => void
  readonly onSend: (text: string) => void
  readonly onExpand: () => void
  readonly onCollapse: () => void
  readonly onMicToggle: () => void
  readonly onVoiceToggle: () => void
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
const MINI_ROOT: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
  userSelect: 'none',
  background: 'transparent',
}
const MINI_BUTTON: CSSProperties = {
  width: 96,
  height: 96,
  border: '1px solid rgba(255,255,255,0.22)',
  borderRadius: '50%',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  background: 'radial-gradient(circle at 34% 26%, rgba(255,255,255,0.24), rgba(20,22,32,0.94) 72%)',
  boxShadow: '0 12px 30px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.20)',
  transition: 'transform 160ms ease, box-shadow 160ms ease',
  position: 'relative',
}
const MINI_BADGE: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  width: 11,
  height: 11,
  borderRadius: '50%',
  border: '2px solid rgba(20,22,32,0.94)',
}
/** Distinct avatar styling while the shortcut is accepting a voice command. */
const MINI_LISTENING_BUTTON: CSSProperties = {
  border: '2px solid rgba(255,75,82,0.90)',
  background: 'radial-gradient(circle at 34% 26%, rgba(255,120,120,0.38), rgba(48,16,22,0.96) 72%)',
  boxShadow: '0 0 0 6px rgba(255,75,82,0.18), 0 16px 36px rgba(0,0,0,0.52), inset 0 1px 0 rgba(255,255,255,0.26)',
}
/** Distinct avatar styling while the agent is thinking after a voice command. */
const MINI_THINKING_BUTTON: CSSProperties = {
  border: '2px solid rgba(90,169,255,0.90)',
  background: 'radial-gradient(circle at 34% 26%, rgba(120,180,255,0.34), rgba(16,32,58,0.96) 72%)',
  boxShadow: '0 0 0 6px rgba(90,169,255,0.18), 0 16px 36px rgba(0,0,0,0.52), inset 0 1px 0 rgba(255,255,255,0.26)',
}
const MINI_VOICE_ERROR: CSSProperties = {
  position: 'absolute',
  bottom: 6,
  left: 8,
  width: 12,
  height: 12,
  borderRadius: '50%',
  border: '2px solid rgba(20,22,32,0.94)',
  background: '#ffa64d',
}
const VOICE_ERROR_HINT: CSSProperties = {
  fontSize: 10.5,
  color: '#ffd7a6',
  textAlign: 'center',
  overflowWrap: 'anywhere',
}
const EXPANDED_ROOT: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  padding: 8,
  pointerEvents: 'auto',
  color: '#f4f5fa',
  fontFamily: FONT,
  background: 'transparent',
}
const CARD: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderRadius: 20,
  border: '1px solid rgba(255,255,255,0.13)',
  background: 'linear-gradient(158deg, rgba(31,33,47,0.97), rgba(13,14,23,0.98))',
  boxShadow: '0 18px 48px rgba(0,0,0,0.50), inset 0 1px 0 rgba(255,255,255,0.09)',
  backdropFilter: 'blur(24px)',
}
const HEADER: CSSProperties = {
  height: 62,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '0 12px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: 'linear-gradient(90deg, rgba(216,30,39,0.20), rgba(216,30,39,0.01))',
}
const TITLE: CSSProperties = { fontSize: 14, fontWeight: 600, letterSpacing: 0.2 }
const SUBTITLE: CSSProperties = { fontSize: 11, opacity: 0.62, marginTop: 2 }
const STATUS_DOT: CSSProperties = { width: 7, height: 7, borderRadius: '50%', marginRight: 5, display: 'inline-block' }
const HEADER_BUTTON: CSSProperties = {
  width: 30,
  height: 30,
  background: 'rgba(255,255,255,0.08)',
  boxShadow: 'none',
  color: 'rgba(255,255,255,0.85)',
}
const HISTORY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '14px 14px 8px',
  scrollbarWidth: 'thin',
}
const WELCOME: CSSProperties = {
  margin: 'auto',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 10,
  textAlign: 'center',
  padding: '8px 18px 22px',
}
const WELCOME_TITLE: CSSProperties = { fontSize: 15, fontWeight: 600 }
const WELCOME_HINT: CSSProperties = { fontSize: 12, lineHeight: 1.6, opacity: 0.65 }
const INTERACTION: CSSProperties = {
  alignSelf: 'center',
  maxWidth: '92%',
  fontSize: 12,
  padding: '6px 12px',
  borderRadius: 999,
  background: 'rgba(255,166,77,0.16)',
  border: '1px solid rgba(255,166,77,0.35)',
  color: '#ffd7a6',
  overflowWrap: 'anywhere',
}
const COMPOSER: CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 12px 9px',
  borderTop: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(0,0,0,0.16)',
}
const COMPOSER_ROW: CSSProperties = { display: 'flex', alignItems: 'flex-end', gap: 8 }
const INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 44,
  maxHeight: 96,
  resize: 'none',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.07)',
  color: '#f4f5fa',
  padding: '10px 11px',
  fontSize: 13,
  lineHeight: 1.45,
  outline: 'none',
  fontFamily: 'inherit',
}
const HINT: CSSProperties = { fontSize: 10.5, opacity: 0.42, textAlign: 'center' }
const ICON_BUTTON: CSSProperties = { width: 38, height: 38, borderRadius: 12 }
const SEND_BUTTON: CSSProperties = {
  ...ICON_BUTTON,
  border: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  padding: 0,
  color: '#ffffff',
  background: 'linear-gradient(140deg, #ff4b52, #c91520)',
  boxShadow: '0 4px 14px rgba(216,30,39,0.38)',
}

function rowStyle(role: PixiesMessageRole): CSSProperties {
  return { display: 'flex', justifyContent: role === 'user' ? 'flex-end' : 'flex-start' }
}

function bubbleStyle(role: PixiesMessageRole, mood: string): CSSProperties {
  const base: CSSProperties = {
    maxWidth: '84%',
    padding: '9px 12px',
    borderRadius: 14,
    fontSize: 13,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  }
  if (role === 'user') {
    return { ...base, background: 'linear-gradient(140deg, #3f6dff, #5a44d6)', color: '#fff', borderBottomRightRadius: 4 }
  }
  if (mood === 'error' || mood === 'asking') {
    return { ...base, background: 'rgba(255,166,77,0.16)', border: '1px solid rgba(255,166,77,0.35)', color: '#ffd7a6', borderBottomLeftRadius: 4 }
  }
  return {
    ...base,
    background: 'rgba(255,255,255,0.09)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderBottomLeftRadius: 4,
  }
}

/** The live status bubble: failure, listening draft, or thinking. */
interface LiveBubble {
  readonly text: string
  readonly mood: 'asking' | 'thinking' | 'error'
}

/**
 * Thinking covers the whole wait: the renderer marks it at submit time, and the
 * host's turn/start marker keeps it alive across long turns.
 */
function isThinking(props: PixiesConversationProps): boolean {
  return props.awaitingReply || props.state.pendingSession !== undefined
}

function liveBubble(props: PixiesConversationProps): LiveBubble | undefined {
  if (props.error !== '') return { text: props.error, mood: 'error' }
  if (props.listening) return { text: props.partial !== '' ? props.partial : props.copy.listening, mood: 'asking' }
  if (isThinking(props)) return { text: props.copy.thinking, mood: 'thinking' }
  return undefined
}

function statusOf(props: PixiesConversationProps): { readonly text: string; readonly color: string } {
  if (props.listening) return { text: props.copy.statusListening, color: '#ff4b52' }
  if (props.speaking) return { text: props.copy.statusSpeaking, color: '#ffc247' }
  if (isThinking(props)) return { text: props.copy.statusThinking, color: '#5aa9ff' }
  return { text: props.copy.statusIdle, color: '#4ade80' }
}

/**
 * Mini mode: one round avatar that is both the drag handle and the
 * tap-to-expand target. The drag hook's click suppression keeps a real drag
 * from opening the panel.
 */
export function PixiesMiniView(props: PixiesConversationProps): ReactElement {
  const drag = usePixiesWindowDrag(props.bridge)
  const [hovered, setHovered] = useState(false)
  const accepting = props.listening
  const thinking = isThinking(props)
  const showThinking = thinking && !accepting && !props.speaking
  const activeStyle = accepting ? MINI_LISTENING_BUTTON : showThinking ? MINI_THINKING_BUTTON : undefined
  const mood = accepting || props.state.interaction !== undefined
    ? 'asking'
    : showThinking ? 'thinking' : 'neutral'
  const badgeColor = accepting
    ? '#ff4b52'
    : props.speaking
      ? '#ffc247'
      : thinking
        ? '#5aa9ff'
        : props.state.messages.length > 0 ? '#ff4b52' : '#4ade80'
  return createElement('div', {
    'data-pixies-shell': '',
    'data-mode': 'mini' as PixiesShellMode,
    'data-listening': accepting ? '' : undefined,
    'data-thinking': showThinking ? '' : undefined,
    'data-speaking': props.speaking ? '' : undefined,
    ...drag.containerProps,
    style: { ...MINI_ROOT, ...drag.containerProps.style },
  },
  createElement('button', {
    type: 'button',
    'data-testid': 'pixies-mini',
    'data-listening': accepting ? '' : undefined,
    'data-thinking': showThinking ? '' : undefined,
    'aria-label': accepting
      ? props.copy.voiceCommandListening
      : showThinking ? props.copy.statusThinking : props.copy.expand,
    style: {
      ...MINI_BUTTON,
      ...(activeStyle ?? {}),
      transform: hovered || activeStyle !== undefined ? 'scale(1.06)' : 'scale(1)',
      boxShadow: activeStyle?.boxShadow
        ?? (hovered
          ? '0 16px 36px rgba(0,0,0,0.52), inset 0 1px 0 rgba(255,255,255,0.26)'
          : MINI_BUTTON.boxShadow),
    },
    onPointerEnter: () => { setHovered(true) },
    onPointerLeave: () => { setHovered(false) },
    onClick: props.onExpand,
  },
  createElement(PixiesCharacter, { size: 78, mood, glow: true }),
  accepting
    ? createElement(PixiesListeningRing)
    : showThinking ? createElement(PixiesThinkingRing) : null,
  createElement('span', { style: { ...MINI_BADGE, background: badgeColor } }),
  props.voiceError !== '' ? createElement('span', {
    'data-testid': 'pixies-voice-error',
    'aria-label': props.voiceError,
    style: MINI_VOICE_ERROR,
  }) : null,
  ),
  )
}

/** One message row; only the newest assistant entry carries the smoke-test bubble marker. */
function MessageRow({ message, marker }: { message: PixiesMessage; marker: boolean }): ReactElement {
  return createElement('div', { style: rowStyle(message.role) },
    createElement('div', {
      'data-testid': marker ? 'pixies-bubble' : undefined,
      'data-mood': marker ? message.mood : undefined,
      role: marker ? 'status' : undefined,
      style: bubbleStyle(message.role, message.mood),
    }, message.text),
  )
}

/**
 * Expanded mode: a draggable header, a scrollable conversation, and a composer
 * with text and voice input. Enter sends, Shift+Enter inserts a newline, and
 * Escape collapses back to the avatar.
 */
export function PixiesExpandedView(props: PixiesConversationProps): ReactElement {
  const drag = usePixiesWindowDrag(props.bridge)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const live = liveBubble(props)
  const status = statusOf(props)
  const messages = props.state.messages
  const lastAssistant = messages.reduce<number>((found, message, index) =>
    message.role === 'assistant' ? index : found, -1)
  const showWelcome = messages.length === 0 && live === undefined && props.state.interaction === undefined

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const node = listRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [messages.length, live?.text])
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') props.onCollapse()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [props.onCollapse])

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    props.onSend(props.draft)
  }

  return createElement('div', {
    'data-pixies-shell': '',
    'data-mode': 'expanded' as PixiesShellMode,
    style: EXPANDED_ROOT,
  },
  createElement('div', { style: CARD },
    createElement('div', {
      'data-testid': 'pixies-drag-bar',
      ...drag.containerProps,
      style: { ...HEADER, ...drag.containerProps.style },
    },
    createElement(PixiesCharacter, {
      size: 36,
      mood: props.listening ? 'asking' : isThinking(props) ? 'thinking' : 'neutral',
    }),
    createElement('div', { style: { flex: 1, minWidth: 0 } },
      createElement('div', { style: TITLE }, props.copy.title),
      createElement('div', { style: SUBTITLE },
        createElement('span', { style: { ...STATUS_DOT, background: status.color } }),
        status.text,
        ' · ',
        props.copy.subtitle,
      ),
    ),
    createElement(PixiesVoiceButton, {
      active: props.voiceReplies,
      speaking: props.speaking,
      label: props.voiceReplies ? props.copy.voiceOn : props.copy.voiceOff,
      style: HEADER_BUTTON,
      onClick: props.onVoiceToggle,
    }),
    createElement(PixiesCollapseButton, {
      label: props.copy.collapse,
      style: HEADER_BUTTON,
      onClick: props.onCollapse,
    }),
    ),
    createElement('div', { ref: listRef, role: 'log', style: HISTORY_STYLE },
      showWelcome ? createElement('div', { style: WELCOME },
        createElement(PixiesCharacter, { size: 76, glow: true }),
        createElement('div', { style: WELCOME_TITLE }, props.copy.welcome),
        createElement('div', { style: WELCOME_HINT }, props.copy.empty),
      ) : null,
      props.state.interaction !== undefined ? createElement('div', { style: INTERACTION },
        props.state.interaction.kind === 'approval' ? props.copy.approval : props.copy.question,
        props.state.interaction.summary === '' ? '' : `：${props.state.interaction.summary}`,
      ) : null,
      ...messages.map((message, index) => createElement(MessageRow, {
        key: message.id,
        message,
        marker: live === undefined && index === lastAssistant,
      })),
      live !== undefined ? createElement('div', { style: rowStyle('assistant') },
        createElement('div', {
          'data-testid': 'pixies-bubble',
          'data-mood': live.mood,
          role: 'status',
          style: bubbleStyle('assistant', live.mood),
        }, live.text),
      ) : null,
    ),
    createElement('div', { style: COMPOSER },
      createElement('div', { style: COMPOSER_ROW },
        createElement('textarea', {
          'data-testid': 'pixies-input',
          'aria-label': props.copy.inputLabel,
          placeholder: props.copy.placeholder,
          rows: 2,
          value: props.draft,
          style: INPUT,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { props.onDraftChange(event.target.value) },
          onKeyDown: onInputKeyDown,
          ref: inputRef,
        }),
        createElement(PixiesMicButton, {
          active: props.listening,
          label: props.listening ? props.copy.micActive : props.copy.mic,
          style: { ...ICON_BUTTON, background: props.listening ? '#d81e27' : 'rgba(255,255,255,0.10)' },
          onClick: props.onMicToggle,
        }),
        createElement('button', {
          type: 'button',
          'data-testid': 'pixies-send',
          'aria-label': props.copy.send,
          disabled: props.draft.trim() === '',
          style: {
            ...SEND_BUTTON,
            opacity: props.draft.trim() === '' ? 0.45 : 1,
            cursor: props.draft.trim() === '' ? 'default' : 'pointer',
          },
          onClick: () => { props.onSend(props.draft) },
        },
        createElement('svg', {
          width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        }, createElement('path', { d: 'M4 12h15M13 6l6 6-6 6' })),
        ),
      ),
      createElement('div', { style: HINT }, props.copy.sendHint),
      props.voiceError !== '' ? createElement('div', {
        'data-testid': 'pixies-voice-error',
        style: VOICE_ERROR_HINT,
      }, props.voiceError) : null,
    ),
  ),
  )
}
