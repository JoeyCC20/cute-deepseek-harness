/**
 * The two Pixies shell surfaces: a peeking, freely draggable Spider-Man avatar
 * and the expanded conversation panel (drag header, message history, composer,
 * voice input). All product copy comes from the locale dictionary; all styling
 * is inline so the transparent Electron window needs no host stylesheet.
 * @module @deepseek-ai/dsh-pixies/client/conversation
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import {
  MarkdownDelegateProvider, MarkdownText, type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  PixiesCharacter,
  PixiesCollapseButton,
  PixiesListeningRing,
  PixiesMicButton,
  PixiesThinkingRing,
  PixiesVoiceButton,
} from './character.tsx'
import type { PixiesResolvedMessages } from './locale.ts'
import type { PixiesClientState, PixiesMessage, PixiesMessageRole, PixiesProcessEntry } from './store.ts'
import type { PixiesShellBridge, PixiesShellMode } from './shell.tsx'
import { visibleReplyText } from './voice-summary.ts'
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
  /** Whether a turn is running; the composer swaps Send for Stop. */
  readonly taskRunning: boolean
  /** Stop the running turn. */
  readonly onStop: () => void
  readonly onExpand: () => void
  readonly onCollapse: () => void
  readonly onMicToggle: () => void
  readonly onVoiceToggle: () => void
  /** Host session catalog, absent on plain web pages without a sessions face. */
  readonly sessionList: SessionListState | undefined
  /** The session the character currently follows. */
  readonly selectedSessionId: SessionId | undefined
  /** Switch the followed session from the history drawer. */
  readonly onSelectSession: (id: SessionId) => void
  /** Archived session ids the history popup must hide. */
  readonly hiddenSessionIds: readonly SessionId[]
  /** Remove a session from history after a confirmed action. */
  readonly onRemoveSession: (id: SessionId) => Promise<void>
  /** Whether a fresh session is being created. */
  readonly newSessionPending: boolean
  /** Failure text from the last session creation, or an empty string. */
  readonly newSessionError: string
  /** Create a fresh session and follow it. */
  readonly onNewSession: () => void
  /** Right-click on the floating icon opens the hide menu. */
  readonly onContextMenu: (event: MouseEvent<HTMLDivElement>) => void
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
  position: 'relative',
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
const HISTORY_BUTTON: CSSProperties = {
  ...HEADER_BUTTON,
  border: 'none',
  borderRadius: 10,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const HEADER_NEW_SESSION_BUTTON: CSSProperties = {
  height: 30,
  minWidth: 44,
  flexShrink: 0,
  padding: '0 8px',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 10,
  color: '#ffffff',
  background: 'rgba(255,255,255,0.08)',
  fontFamily: 'inherit',
  fontSize: 11.5,
  cursor: 'pointer',
}
/** Covers the conversation area only, so the header actions stay reachable. */
const HISTORY_BACKDROP: CSSProperties = {
  position: 'absolute',
  top: 62,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 20,
  display: 'flex',
  padding: 10,
  background: 'rgba(5,7,13,0.62)',
  backdropFilter: 'blur(5px)',
}
const HISTORY_POPUP: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '10px 12px 12px',
  borderRadius: 16,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(12,14,24,0.98)',
  boxShadow: '0 18px 44px rgba(0,0,0,0.55)',
  scrollbarWidth: 'thin',
}
const NEW_SESSION_ERROR: CSSProperties = {
  flexShrink: 0,
  padding: '6px 14px',
  borderBottom: '1px solid rgba(255,138,143,0.22)',
  background: 'rgba(255,138,143,0.08)',
  color: '#ff8a8f',
  fontSize: 11.5,
  overflowWrap: 'anywhere',
}
const ICON_MENU_BACKDROP: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 100,
  background: 'transparent',
}
const ICON_MENU: CSSProperties = {
  position: 'absolute',
  zIndex: 101,
  minWidth: 104,
  padding: 4,
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.18)',
  background: 'rgba(18,20,30,0.98)',
  boxShadow: '0 12px 30px rgba(0,0,0,0.55)',
}
const ICON_MENU_BUTTON: CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color: '#f4f5fa',
  fontFamily: 'inherit',
  fontSize: 12,
  textAlign: 'left',
  cursor: 'pointer',
}
const DRAWER_HEAD: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const SECTION: CSSProperties = { fontSize: 10.5, opacity: 0.52, margin: '11px 2px 5px', letterSpacing: 0.4 }
const SESSION_ROW_WRAPPER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  marginBottom: 4,
}
const SESSION_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: 1,
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '7px 9px',
  borderRadius: 10,
  border: '1px solid transparent',
  background: 'rgba(255,255,255,0.05)',
  color: '#f4f5fa',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
  fontSize: 12,
}
const SESSION_ROW_ACTIVE: CSSProperties = {
  border: '1px solid rgba(90,169,255,0.55)',
  background: 'rgba(90,169,255,0.14)',
}
const SESSION_DELETE_BUTTON: CSSProperties = {
  flexShrink: 0,
  width: 30,
  height: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: '1px solid transparent',
  borderRadius: 10,
  background: 'rgba(255,255,255,0.05)',
  color: 'rgba(255,255,255,0.55)',
  cursor: 'pointer',
}
const DELETE_CONFIRM_BAR: CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  padding: '6px 8px',
  borderRadius: 10,
  border: '1px solid rgba(255,138,143,0.30)',
  background: 'rgba(255,138,143,0.08)',
}
const DELETE_CONFIRM_TEXT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 11,
  color: '#ffb3b6',
  overflowWrap: 'anywhere',
}
const DELETE_CONFIRM_BUTTON: CSSProperties = {
  flexShrink: 0,
  padding: '3px 8px',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.08)',
  color: '#ffffff',
  fontFamily: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
}
const DELETE_CONFIRM_ACCEPT: CSSProperties = {
  ...DELETE_CONFIRM_BUTTON,
  background: '#c91520',
  border: '1px solid #ff4b52',
}
const SESSION_TITLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const SESSION_META: CSSProperties = { flexShrink: 0, fontSize: 10, opacity: 0.52 }
const RUNNING_DOT: CSSProperties = { flexShrink: 0, width: 6, height: 6, borderRadius: '50%', background: '#4ade80' }
const DRAWER_NOTE: CSSProperties = { fontSize: 11.5, opacity: 0.5, padding: '3px 2px' }
const CONTEXT_ROW: CSSProperties = {
  fontSize: 11.5,
  opacity: 0.72,
  padding: '3px 2px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const THINKING_TOGGLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 10px',
  border: 'none',
  background: 'transparent',
  color: '#cfe4ff',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11.5,
  textAlign: 'left',
}
const THINKING_STATE: CSSProperties = { flexShrink: 0, marginLeft: 'auto', fontSize: 10, opacity: 0.65 }
const THINKING_BODY: CSSProperties = {
  margin: 0,
  padding: '0 10px 9px',
  maxHeight: 180,
  overflowY: 'auto',
  fontSize: 11.5,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: 'rgba(233,241,255,0.82)',
  fontFamily: 'inherit',
}
const PROCESS_BODY: CSSProperties = {
  ...THINKING_BODY, maxHeight: 320, paddingTop: 8,
  borderTop: '1px solid rgba(255,255,255,0.08)',
}
const WORK_GROUP: CSSProperties = {
  alignSelf: 'flex-start', width: '92%', minWidth: 0, overflow: 'hidden',
  borderRadius: 11, border: '1px solid rgba(90,169,255,0.22)',
  background: 'rgba(90,169,255,0.06)',
}
const WORK_ITEMS: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 5, padding: '0 9px 9px',
}
const WORK_COUNT: CSSProperties = { flexShrink: 0, fontSize: 10, opacity: 0.6 }
const PROCESS_ROW: CSSProperties = {
  alignSelf: 'stretch', width: '100%', minWidth: 0, overflow: 'hidden',
  borderRadius: 8, border: '1px solid rgba(120,170,255,0.16)',
  background: 'rgba(120,170,255,0.04)',
}
const PROCESS_TOGGLE: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0,
  padding: '6px 9px', border: 'none', background: 'transparent',
  color: 'rgba(233,241,255,0.78)', fontFamily: 'inherit',
  fontSize: 11.5, textAlign: 'left', cursor: 'pointer',
}
const PROCESS_KIND_INLINE: CSSProperties = { flexShrink: 0, fontSize: 10, opacity: 0.65 }
const PROCESS_SUMMARY: CSSProperties = {
  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
/** Assistant replies are documents: full width, with no card chrome. */
const REPLY_DOCUMENT: CSSProperties = {
  width: '100%',
  minWidth: 0,
  padding: '1px 0',
  fontSize: 13,
  lineHeight: 1.62,
  color: '#f4f5fa',
}
const REPLY_HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  paddingTop: 4,
  fontSize: 10.5,
  lineHeight: 1.2,
  color: 'rgba(244,245,250,0.55)',
}
const REPLY_NAME: CSSProperties = { flexShrink: 0, letterSpacing: 0.3 }
const REPLY_RULE: CSSProperties = { flex: 1, height: 1, background: 'rgba(255,255,255,0.10)' }
/** Stack a reply and its collapsed process instead of squeezing them side by side. */
const MESSAGE_COLUMN: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 6,
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
  // A neutral assistant reply is the primary reading surface. Leaving it as a
  // card squeezed long Markdown, tables, and code into 84% of the panel; the
  // Markdown primitive owns code and table scrolling once no inherited
  // `overflow-wrap: anywhere` or `white-space: pre-wrap` fights it.
  if (role === 'assistant' && mood === 'neutral') return REPLY_DOCUMENT
  return {
    ...base,
    background: 'rgba(255,255,255,0.09)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderBottomLeftRadius: 4,
  }
}

/** The live status bubble: a failure or a listening draft; thinking lives in the work group. */
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
  // A turn in progress reports its state in the work group, never as its own bubble.
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
    onContextMenu: props.onContextMenu,
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

/**
 * One message row; only the newest assistant entry carries the smoke-test
 * bubble marker. Assistant Markdown is rendered; user and system entries keep
 * their literal text so control feedback cannot be reinterpreted as markup.
 * A conversation entry: assistant replies are full-width documents headed by
 * their role; consecutive work rows are grouped by the transcript renderer.
 */
function MessageRow({ message, marker, labels, openExternalLink, copy }: {
  message: PixiesMessage
  marker: boolean
  labels: MarkdownLabels | undefined
  openExternalLink: (href: string) => void
  copy: PixiesResolvedMessages
}): ReactElement {
  const text = visibleReplyText(message.text)
  const bubble = createElement('div', {
    'data-testid': marker ? 'pixies-bubble' : undefined,
    'data-mood': marker ? message.mood : undefined,
    'data-role': message.role,
    role: marker ? 'status' : undefined,
    style: bubbleStyle(message.role, message.mood),
  }, message.role === 'assistant' && labels !== undefined
    ? createElement(MarkdownDelegateProvider, { openExternalLink,
      children: createElement(MarkdownText, { text, streaming: false, labels, variant: 'compact' }) })
    : text)
  if (message.role !== 'assistant') {
    return createElement('div', { style: rowStyle(message.role) }, bubble)
  }
  return createElement('div', { style: rowStyle(message.role) },
    createElement('div', { style: MESSAGE_COLUMN },
      createElement('div', { 'data-testid': 'pixies-reply-header', style: REPLY_HEADER },
        createElement('span', { style: REPLY_NAME }, copy.roleAssistant),
        createElement('span', { style: REPLY_RULE }),
      ),
      bubble,
    ),
  )
}

/** The drawer's coarse time buckets for the host session catalog. */
type SessionGroup = 'morning' | 'afternoon' | 'earlier'

/** Bucket one session by its last update in the viewer's local time. */
function groupOf(updatedAt: number, now: number): SessionGroup {
  const updated = new Date(updatedAt)
  if (updated.toDateString() !== new Date(now).toDateString()) return 'earlier'
  return updated.getHours() < 12 ? 'morning' : 'afternoon'
}

/** Read every projected session, skipping ids the Workspace Controller archived. */
function sessionRows(list: SessionListState | undefined, now: number, hidden: ReadonlySet<string>): readonly {
  readonly group: SessionGroup
  readonly summary: SessionSummary
}[] {
  if (list === undefined) return []
  const rows: Array<{ readonly group: SessionGroup; readonly summary: SessionSummary }> = []
  const seen = new Set<string>()
  for (const id of list.ids) {
    const summary: SessionSummary | undefined = list.byId[id]
    if (summary === undefined || hidden.has(id)) continue
    rows.push({ group: groupOf(summary.updatedAt, now), summary })
    seen.add(id)
  }
  // The store also carries local fallback rows for live generations that the
  // Host has not listed yet; dropping them hides real sessions from history.
  for (const [id, summary] of Object.entries(list.byId)) {
    if (seen.has(id) || hidden.has(id)) continue
    rows.push({ group: groupOf(summary.updatedAt, now), summary })
  }
  return rows
}

function roleName(message: PixiesMessage, copy: PixiesResolvedMessages): string {
  if (message.role === 'user') return copy.roleUser
  if (message.role === 'assistant') return copy.roleAssistant
  if (message.role === 'process') return processKindLabel(message.processKind ?? 'thinking', copy)
  return copy.roleSystem
}

/** Clock glyph for the history entry; the accessible name comes from copy. */
function historyIcon(): ReactElement {
  return createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  },
  createElement('circle', { cx: 12, cy: 12, r: 9 }),
  createElement('path', { d: 'M12 7v5l3 2' }),
  )
}

/** Trash glyph for the per-session remove action; the accessible name comes from copy. */
function deleteIcon(): ReactElement {
  return createElement('svg', {
    width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  },
  createElement('path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5' }),
  )
}

/** Right-click menu for the floating icon; its only action returns it to the tray. */
export interface PixiesIconMenuProps {
  readonly copy: PixiesResolvedMessages
  readonly x: number
  readonly y: number
  readonly onHide: () => void
  readonly onClose: () => void
}

/** A transparent backdrop closes the menu on any outside click or second right-click. */
export function PixiesIconMenu(props: PixiesIconMenuProps): ReactElement {
  return createElement('div', {
    'data-testid': 'pixies-icon-menu-backdrop',
    style: ICON_MENU_BACKDROP,
    onClick: props.onClose,
    onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      props.onClose()
    },
  },
  createElement('div', {
    'data-testid': 'pixies-icon-menu',
    style: { ...ICON_MENU, left: props.x, top: props.y },
    onClick: (event: MouseEvent<HTMLDivElement>) => { event.stopPropagation() },
  },
  createElement('button', {
    type: 'button',
    'data-testid': 'pixies-icon-hide',
    style: ICON_MENU_BUTTON,
    onClick: props.onHide,
  }, props.copy.hideIcon),
  ),
  )
}

interface HistoryPopupProps {
  readonly copy: PixiesResolvedMessages
  readonly list: SessionListState | undefined
  readonly hiddenSessionIds: readonly SessionId[]
  readonly selectedId: SessionId | undefined
  readonly messages: readonly PixiesMessage[]
  readonly onSelect: (id: SessionId) => void
  readonly onRemove: (id: SessionId) => Promise<void>
  readonly onClose: () => void
}

/**
 * The history popup floats above the conversation instead of taking a flex
 * slot away from the transcript. Each row owns a two-step remove action; the
 * shell owns the removal and the follow switch.
 */
function HistoryPopup(props: HistoryPopupProps): ReactElement {
  const [confirmId, setConfirmId] = useState<SessionId | undefined>(undefined)
  const [pendingId, setPendingId] = useState<SessionId | undefined>(undefined)
  const [removeError, setRemoveError] = useState('')
  const rows = sessionRows(props.list, Date.now(), new Set<string>(props.hiddenSessionIds))
  const groups: readonly { readonly key: SessionGroup; readonly heading: string }[] = [
    { key: 'morning', heading: props.copy.groupMorning },
    { key: 'afternoon', heading: props.copy.groupAfternoon },
    { key: 'earlier', heading: props.copy.groupEarlier },
  ]

  const confirmRemove = async (id: SessionId): Promise<void> => {
    setConfirmId(undefined)
    setPendingId(id)
    setRemoveError('')
    try {
      await props.onRemove(id)
    } catch (error: unknown) {
      setRemoveError(`${props.copy.deleteSessionFailed}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setPendingId(undefined)
    }
  }

  return createElement('div', {
    'data-testid': 'pixies-history-backdrop',
    style: HISTORY_BACKDROP,
    onClick: (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) props.onClose()
    },
  },
  createElement('div', { 'data-testid': 'pixies-history-panel', style: HISTORY_POPUP },
    createElement('div', { style: DRAWER_HEAD },
      createElement('div', { style: { ...TITLE, flex: 1 } }, props.copy.history),
      createElement('button', {
        type: 'button',
        'data-testid': 'pixies-history-close',
        'aria-label': props.copy.historyClose,
        style: HISTORY_BUTTON,
        onClick: props.onClose,
      }, historyIcon()),
    ),
    removeError !== '' ? createElement('div', {
      'data-testid': 'pixies-session-delete-error',
      style: { ...DRAWER_NOTE, color: '#ff8a8f' },
    }, removeError) : null,
    createElement('div', { style: SECTION }, props.copy.sessions),
    rows.length === 0 ? createElement('div', { style: DRAWER_NOTE }, props.copy.noSessions) : null,
    ...groups.map((group) => {
      const members = rows.filter(row => row.group === group.key)
      if (members.length === 0) return null
      return createElement('div', { key: group.key },
        createElement('div', { style: SECTION }, group.heading),
        ...members.map(({ summary }) => {
          const active = summary.id === props.selectedId
          const pending = pendingId === summary.id
          return createElement('div', { key: summary.id, style: SESSION_ROW_WRAPPER },
            createElement('button', {
              type: 'button',
              'data-testid': 'pixies-session-row',
              'data-active': active ? '' : undefined,
              'aria-current': active ? 'true' : undefined,
              'aria-label': summary.displayTitle,
              style: { ...SESSION_ROW, ...(active ? SESSION_ROW_ACTIVE : {}) },
              onClick: () => { props.onSelect(summary.id) },
            },
            summary.running ? createElement('span', { style: RUNNING_DOT }) : null,
            createElement('span', { style: SESSION_TITLE }, summary.displayTitle),
            createElement('span', { style: SESSION_META }, new Date(summary.updatedAt).toLocaleTimeString()),
            ),
            createElement('button', {
              type: 'button',
              'data-testid': 'pixies-session-delete',
              'aria-label': props.copy.deleteSession,
              title: props.copy.deleteSession,
              disabled: props.list === undefined || pendingId !== undefined,
              style: SESSION_DELETE_BUTTON,
              onClick: () => { setConfirmId(summary.id); setRemoveError('') },
            }, deleteIcon()),
            confirmId === summary.id
              ? createElement('div', {
                'data-testid': 'pixies-session-delete-confirm',
                style: DELETE_CONFIRM_BAR,
              },
              createElement('div', { style: DELETE_CONFIRM_TEXT }, props.copy.deleteSessionConfirm),
              createElement('button', {
                type: 'button',
                'data-testid': 'pixies-session-delete-cancel',
                style: DELETE_CONFIRM_BUTTON,
                onClick: () => { setConfirmId(undefined) },
              }, props.copy.deleteSessionCancel),
              createElement('button', {
                type: 'button',
                'data-testid': 'pixies-session-delete-accept',
                disabled: pending,
                style: DELETE_CONFIRM_ACCEPT,
                onClick: () => { void confirmRemove(summary.id) },
              }, pending ? props.copy.deleteSessionPending : props.copy.deleteSessionAccept),
              )
              : null,
          )
        }),
      )
    }),
    createElement('div', { style: SECTION }, props.copy.context),
    createElement('div', { style: DRAWER_NOTE }, `${String(props.messages.length)} ${props.copy.contextCount}`),
    ...props.messages.map(message => createElement('div', {
      key: message.id,
      'data-testid': 'pixies-context-row',
      style: CONTEXT_ROW,
    }, `${roleName(message, props.copy)}: ${visibleReplyText(message.text)}`)),
  ),
  )
}

/** Label for one kind of step in a turn's work. */
function processKindLabel(kind: PixiesProcessEntry['kind'], copy: PixiesResolvedMessages): string {
  if (kind === 'thinking') return copy.processThinking
  if (kind === 'tool-call') return copy.processToolCall
  return copy.processToolResult
}

interface ProcessRowProps {
  readonly kind: PixiesProcessEntry['kind']
  readonly text: string
  readonly copy: PixiesResolvedMessages
}

/** One work step: a one-line preview that opens its full detail on click. */
function ProcessRow(props: ProcessRowProps): ReactElement {
  const [open, setOpen] = useState(false)
  const summary = props.text.replace(/\s+/g, ' ').trim()
  return createElement('div', {
    'data-testid': 'pixies-process-row',
    'data-kind': props.kind,
    style: PROCESS_ROW,
  },
  createElement('button', {
    type: 'button',
    'data-testid': 'pixies-process-toggle',
    'aria-expanded': open,
    'aria-label': open ? props.copy.hideProcess : props.copy.showProcess,
    style: PROCESS_TOGGLE,
    onClick: () => { setOpen(!open) },
  },
  createElement('span', { style: PROCESS_KIND_INLINE }, processKindLabel(props.kind, props.copy)),
  createElement('span', { style: PROCESS_SUMMARY }, summary),
  ),
  open ? createElement('pre', {
    'data-testid': 'pixies-process-body',
    style: PROCESS_BODY,
  }, props.text) : null,
  )
}

interface WorkGroupProps {
  readonly rows: readonly PixiesMessage[]
  /** Live reasoning text that has not settled into its own row yet. */
  readonly streaming: string | undefined
  /** Whether this turn is still running. */
  readonly active: boolean
  readonly copy: PixiesResolvedMessages
}

/** One item in the work group: a settled row or the live reasoning stream. */
interface WorkItem {
  readonly id: string
  readonly kind: PixiesProcessEntry['kind']
  readonly text: string
}

/**
 * One turn's work, collected in place. The outer disclosure is closed by
 * default; opening it lists the ordered rows, and each row opens its detail.
 * While the turn runs its heading reads "thinking"; once a result exists it
 * becomes the settled "thinking process" label.
 */
function WorkGroup(props: WorkGroupProps): ReactElement {
  const [open, setOpen] = useState(false)
  const items: WorkItem[] = props.rows.map(row => ({
    id: row.id,
    kind: row.processKind ?? 'thinking',
    text: row.text,
  }))
  if (props.streaming !== undefined && props.streaming !== '') {
    items.push({ id: 'streaming', kind: 'thinking', text: props.streaming })
  }
  return createElement('div', {
    'data-testid': 'pixies-work-group',
    'data-active': props.active ? '' : undefined,
    style: WORK_GROUP,
  },
  createElement('button', {
    type: 'button',
    'data-testid': 'pixies-work-toggle',
    'aria-expanded': open,
    'aria-label': open ? props.copy.hideProcess : props.copy.showProcess,
    style: THINKING_TOGGLE,
    onClick: () => { setOpen(!open) },
  },
  createElement('span', { 'data-testid': 'pixies-work-title' },
    props.active ? props.copy.thinking : props.copy.thinkingProcess),
  createElement('span', { style: WORK_COUNT }, `· ${String(items.length)}`),
  createElement('span', { style: THINKING_STATE },
    props.active ? props.copy.thinkingStreaming : props.copy.thinkingDone),
  ),
  open ? createElement('div', { 'data-testid': 'pixies-work-items', style: WORK_ITEMS },
    items.map(item => createElement(ProcessRow, {
      key: item.id,
      kind: item.kind,
      text: item.text,
      copy: props.copy,
    })),
  ) : null,
  )
}

/** A message row, or one turn's work group (possibly still in progress). */
type TranscriptBlock =
  | { kind: 'message'; message: PixiesMessage; index: number }
  | {
    kind: 'work'
    rows: PixiesMessage[]
    index: number
    active: boolean
    streaming: string | undefined
  }

/**
 * Group consecutive work rows without moving them: the group stays where the
 * steps happened, before the reply that ended the turn. An in-progress turn
 * folds its live reasoning into the current group, or opens a new one at the
 * tail when it has not written any row yet.
 */
function transcriptBlocks(
  messages: readonly PixiesMessage[],
  active: boolean,
  streaming: string | undefined,
): readonly TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  for (const [index, message] of messages.entries()) {
    const last = blocks[blocks.length - 1]
    if (message.role === 'process') {
      if (last?.kind === 'work') last.rows.push(message)
      else blocks.push({ kind: 'work', rows: [message], index, active: false, streaming: undefined })
      continue
    }
    blocks.push({ kind: 'message', message, index })
  }
  if (!active && streaming === undefined) return blocks
  const last = blocks[blocks.length - 1]
  if (last?.kind === 'work') {
    last.active = active
    last.streaming = streaming
    return blocks
  }
  // A reply already closes its turn; a late turn marker must not open an empty
  // in-progress group after the answer.
  if (last?.kind === 'message' && (last.message.role === 'assistant' || last.message.role === 'system')) {
    return blocks
  }
  blocks.push({ kind: 'work', rows: [], index: messages.length, active, streaming })
  return blocks
}

/**
 * Whether the live reasoning text is already a work row in the transcript, so
 * the in-progress group does not list the same text twice.
 */
function reasoningShownInTranscript(messages: readonly PixiesMessage[], text: string): boolean {
  return messages.some(message => message.role === 'process' && message.processKind === 'thinking'
    && (message.text === text || message.text.endsWith(text) || text.endsWith(message.text)))
}

/** Gear glyph for the settings entry; the accessible name comes from copy. */
function settingsIcon(): ReactElement {
  return createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  },
  createElement('circle', { cx: 12, cy: 12, r: 3 }),
  createElement('path', { d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.36.4.67.73.88.3.2.66.31 1.02.32H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z' }),
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
  const [historyOpen, setHistoryOpen] = useState(false)
  const live = liveBubble(props)
  const status = statusOf(props)
  const messages = props.state.messages
  const lastAssistant = messages.reduce<number>((found, message, index) =>
    message.role === 'assistant' ? index : found, -1)
  const liveText = props.state.thinking?.text ?? ''
  const streaming = liveText !== '' && !reasoningShownInTranscript(messages, liveText)
    ? liveText : undefined
  // Settled reasoning is a result: the heading switches to "thinking process"
  // even when the host's turn/end marker has not arrived yet. A stream still
  // arriving counts as in progress before turn/start lands.
  const thinkingSettled = props.state.thinking !== undefined && !props.state.thinking.active
  const active = !thinkingSettled
    && (isThinking(props) || (props.state.thinking?.active ?? false) || streaming !== undefined)
  const blocks = transcriptBlocks(messages, active, streaming)
  const showWelcome = messages.length === 0 && live === undefined
    && props.state.interaction === undefined && !active && streaming === undefined
  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: props.copy.markdownCopyLabel, copiedLabel: props.copy.markdownCopiedLabel },
    footnotes: props.copy.markdownFootnotes,
  }), [props.copy.markdownCopyLabel, props.copy.markdownCopiedLabel, props.copy.markdownFootnotes])
  const openExternalLink = useCallback((href: string): void => {
    if (props.bridge?.openExternal !== undefined) void props.bridge.openExternal(href)
  }, [props.bridge])

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const node = listRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [messages.length, live?.text, streaming])
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (historyOpen) { setHistoryOpen(false); return }
      props.onCollapse()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [props.onCollapse, historyOpen])

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    props.onSend(props.draft)
  }

  return createElement('div', {
    'data-pixies-shell': '',
    'data-mode': 'expanded' as PixiesShellMode,
    style: EXPANDED_ROOT,
    onContextMenu: props.onContextMenu,
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
    createElement('button', {
      type: 'button',
      'data-testid': 'pixies-new-session',
      'data-pending': props.newSessionPending ? '' : undefined,
      'aria-label': props.copy.newSession,
      'aria-busy': props.newSessionPending,
      title: props.copy.newSession,
      disabled: props.newSessionPending || props.sessionList === undefined,
      style: HEADER_NEW_SESSION_BUTTON,
      onClick: () => { props.onNewSession(); setHistoryOpen(false) },
    }, props.newSessionPending ? props.copy.newSessionPending : props.copy.newSessionShort),
    createElement('button', {
      type: 'button',
      'data-testid': 'pixies-history-toggle',
      'data-open': historyOpen ? '' : undefined,
      'aria-expanded': historyOpen,
      'aria-label': historyOpen ? props.copy.historyClose : props.copy.historyOpen,
      style: HISTORY_BUTTON,
      onClick: () => { setHistoryOpen(!historyOpen) },
    }, historyIcon()),
    createElement('button', {
      type: 'button',
      'data-testid': 'pixies-settings-toggle',
      'aria-label': props.copy.settingsOpen,
      style: HISTORY_BUTTON,
      onClick: () => { props.bridge?.openSettings?.() },
    }, settingsIcon()),
    createElement(PixiesCollapseButton, {
      label: props.copy.collapse,
      style: HEADER_BUTTON,
      onClick: props.onCollapse,
    }),
    ),
    props.newSessionError !== ''
      ? createElement('div', {
        'data-testid': 'pixies-new-session-error',
        role: 'alert',
        style: NEW_SESSION_ERROR,
      }, props.newSessionError)
      : null,
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
      ...blocks.map(block => block.kind === 'work'
        ? createElement('div', {
          key: `work-${String(block.index)}`,
          style: rowStyle('process'),
        }, createElement(WorkGroup, {
          rows: block.rows,
          streaming: block.streaming,
          active: block.active,
          copy: props.copy,
        }))
        : createElement(MessageRow, {
          key: block.message.id,
          message: block.message,
          marker: live === undefined && block.index === lastAssistant,
          labels: markdownLabels,
          openExternalLink,
          copy: props.copy,
        })),
      live !== undefined ? createElement('div', { style: rowStyle('assistant') },
        createElement('div', {
          'data-testid': 'pixies-bubble',
          'data-mood': live.mood,
          role: 'status',
          style: bubbleStyle('assistant', live.mood),
        }, visibleReplyText(live.text)),
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
        props.taskRunning
          ? createElement('button', {
            type: 'button',
            'data-testid': 'pixies-stop',
            'aria-label': props.copy.stop,
            style: { ...SEND_BUTTON, cursor: 'pointer' },
            onClick: props.onStop,
          },
          createElement('svg', {
            width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
            strokeWidth: 2, 'aria-hidden': true,
          }, createElement('rect', { x: 7, y: 7, width: 10, height: 10, rx: 1, fill: 'currentColor' })),
          )
          : createElement('button', {
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
    historyOpen ? createElement(HistoryPopup, {
      copy: props.copy,
      list: props.sessionList,
      hiddenSessionIds: props.hiddenSessionIds,
      selectedId: props.selectedSessionId,
      messages,
      onSelect: (id: SessionId) => {
        props.onSelectSession(id)
        setHistoryOpen(false)
      },
      onRemove: props.onRemoveSession,
      onClose: () => { setHistoryOpen(false) },
    }) : null,
  ),
  )
}
