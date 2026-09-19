/**
 * Pixies shell surface: the session-follow feed that keeps the store current
 * from the client sessions domain, and the full-window React mount the pixies
 * Electron shell activates through the `__DSH_PIXIES_SHELL__` page marker.
 * @module @deepseek-ai/dsh-pixies/client/shell
 */

import { createElement, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  ISessions,
  SessionEventSource,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  PixiesCharacter,
  PixiesCollapseButton,
  PixiesMicButton,
  PixiesPanel,
  type PixiesPanelMessages,
} from './character.tsx'
import { feedSessionEvent, type SessionEventLike } from './feed.ts'
import type { PixiesStore } from './store.ts'

/** Shell interaction copy owned by this plugin (components stay copy-free). */
export const defaultPixiesMessages: PixiesPanelMessages = {
  approval: 'Pixies needs your approval',
  question: 'Pixies has a question',
  expand: 'Expand Pixies',
  mic: 'Speak',
  micActive: 'Listening',
  collapse: 'Collapse',
  listening: 'Listening…',
  speechFailed: 'Voice input failed',
}

/** One speech-input event forwarded by the Electron preload bridge. */
export type PixiesShellSpeechEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'partial'; readonly text: string }
  | { readonly type: 'final'; readonly text: string }
  | { readonly type: 'error'; readonly message: string }

/** The two shell window modes: the corner mini avatar and the full panel. */
export type PixiesShellMode = 'mini' | 'expanded'

/**
 * Structural face of the optional Electron preload bridge
 * (`window.dshPixies`); absent on plain web pages, where every call site
 * guards and the shell stays `expanded`.
 */
export interface PixiesShellBridge {
  readonly expand: () => void
  readonly collapse: () => void
  readonly startSpeech: () => void
  readonly stopSpeech: () => void
  readonly onSpeech: (listener: (event: PixiesShellSpeechEvent) => void) => () => void
  readonly onMode: (listener: (mode: PixiesShellMode) => void) => () => void
}

/**
 * Read the preload bridge from the global scope when it is fully present.
 * @returns the bridge, or undefined outside the Pixies Electron shell.
 */
export function resolvePixiesShellBridge(): PixiesShellBridge | undefined {
  const candidate: unknown = (globalThis as Record<string, unknown>).dshPixies
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const bridge = candidate as Record<string, unknown>
  if (typeof bridge.expand !== 'function' || typeof bridge.collapse !== 'function'
    || typeof bridge.startSpeech !== 'function' || typeof bridge.stopSpeech !== 'function'
    || typeof bridge.onSpeech !== 'function' || typeof bridge.onMode !== 'function') return undefined
  return candidate as PixiesShellBridge
}

/**
 * Send one speech final transcript as a queued prompt into the followed
 * session (the same selection the character follows), creating that session
 * first when the profile has none: a transcript is user input, so it must
 * never be dropped silently — a freshly installed profile has no session, and
 * without one the whole voice round-trip would end here.
 * @param sessions - the client sessions face.
 * @param text - the transcript text; blank text is dropped.
 */
export async function promptPixiesSession(sessions: ISessions, text: string): Promise<void> {
  if (text.trim() === '') return
  const selected = pickPixiesSessionId(sessions.list.getSnapshot())
  const target = selected !== undefined && sessions.binding(selected) !== undefined
    ? selected
    : await sessions.create()
  void sessions.binding(target)?.session.prompt([{ type: 'text', text }], 'queue')
}

/**
 * Pick the session the character follows: the current selection when present,
 * otherwise the first host-listed session.
 * @param state - the sessions list snapshot.
 * @returns the followed session id, or undefined while no session exists.
 */
export function pickPixiesSessionId(state: SessionListState): SessionId | undefined {
  if (state.current !== undefined) return state.current
  return state.ids.length > 0 ? state.ids[0] : undefined
}

/** Disposable handle for the session follow. */
export interface PixiesSessionFollow {
  /** Stop following and release every subscription. */
  readonly dispose: () => void
}

/**
 * Follow the target session's durable event window and feed every newly
 * appended `assistant/message` into the store. The watermark seeds at bind
 * time, so history is never replayed — only live output reaches the
 * character. Rebinds when the followed session changes.
 * @param sessions - the client sessions face.
 * @param store - the Pixies store to publish into.
 * @returns a disposable follow handle.
 */
export function followPixiesSession(sessions: ISessions, store: PixiesStore): PixiesSessionFollow {
  let disposeEvents: (() => void) | undefined
  let followedSessionId: SessionId | undefined
  let highWaterSeq = -1

  const rebind = (state: SessionListState): void => {
    const target = pickPixiesSessionId(state)
    if (target === undefined || target === followedSessionId) return
    const binding = sessions.binding(target)
    if (binding === undefined) return
    disposeEvents?.()
    followedSessionId = target
    highWaterSeq = -1
    subscribeEvents(target, binding.eventSource)
  }

  const subscribeEvents = (sessionId: SessionId, source: SessionEventSource): void => {
    for (const entry of source.getSnapshot().entries) {
      if (entry.type === 'event' && entry.event.seq > highWaterSeq) highWaterSeq = entry.event.seq
    }
    disposeEvents = source.subscribe(() => {
      for (const entry of source.getSnapshot().entries) {
        if (entry.type !== 'event') continue
        const event: SessionEventLike = entry.event
        if (event.seq <= highWaterSeq) continue
        highWaterSeq = event.seq
        feedSessionEvent(store, sessionId, event)
      }
    })
  }

  const unsubscribeList = sessions.list.subscribe(() => { rebind(sessions.list.getSnapshot()) })
  rebind(sessions.list.getSnapshot())
  return {
    dispose: () => {
      unsubscribeList()
      disposeEvents?.()
      disposeEvents = undefined
      followedSessionId = undefined
    },
  }
}

const SHELL_OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-end',
  padding: 16,
  pointerEvents: 'none',
}

const SHELL_MINI_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
}

const MINI_BUTTON_STYLE: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  pointerEvents: 'auto',
  borderRadius: '50%',
  lineHeight: 0,
}

const CONTROLS_STYLE: CSSProperties = {
  display: 'flex',
  gap: 12,
  marginTop: 4,
  pointerEvents: 'auto',
}

function ShellPanel({ store, messages, bridge, onFinalTranscript }: {
  store: PixiesStore
  messages: PixiesPanelMessages
  bridge: PixiesShellBridge | undefined
  onFinalTranscript: ((text: string) => void) | undefined
}): ReactElement {
  const [state, setState] = useState(store.getState)
  const [mode, setMode] = useState<PixiesShellMode>(bridge === undefined ? 'expanded' : 'mini')
  const [listening, setListening] = useState(false)
  const [partial, setPartial] = useState('')
  const [speechError, setSpeechError] = useState('')
  useEffect(() => store.subscribe(setState), [store])
  useEffect(() => {
    if (bridge === undefined) return
    const offMode = bridge.onMode(setMode)
    const offSpeech = bridge.onSpeech((event) => {
      if (event.type === 'partial') {
        setListening(true)
        setPartial(event.text)
        setSpeechError('')
        return
      }
      if (event.type === 'ready') {
        setListening(true)
        setPartial('')
        setSpeechError('')
        return
      }
      // final and error both end the listening round.
      setListening(false)
      setPartial('')
      bridge.stopSpeech()
      if (event.type === 'final' && event.text !== '') {
        setSpeechError('')
        onFinalTranscript?.(event.text)
      } else if (event.type === 'error') {
        // A failed round is the only feedback the mic can give: the speech CLI
        // reports why (missing authorization, no input device, engine failure),
        // so it must reach the bubble instead of being dropped here.
        setSpeechError(`${messages.speechFailed ?? 'Voice input failed'}: ${event.message}`)
      }
    })
    return () => { offMode(); offSpeech() }
  }, [bridge, onFinalTranscript, messages])
  if (mode === 'mini') {
    return createElement('div', { style: SHELL_MINI_STYLE, 'data-pixies-shell': '', 'data-mode': 'mini' },
      createElement('button',
        {
          type: 'button',
          'data-testid': 'pixies-mini',
          'aria-label': messages.expand ?? 'Expand',
          style: MINI_BUTTON_STYLE,
          onClick: () => { bridge?.expand() },
        },
        createElement(PixiesCharacter, { size: 80 }),
      ),
    )
  }
  return createElement('div', { style: SHELL_OVERLAY_STYLE, 'data-pixies-shell': '', 'data-mode': 'expanded' },
    createElement(PixiesPanel, {
      state,
      messages,
      showIdleCharacter: true,
      speechDraft: { listening, partial, error: speechError },
    }),
    createElement('div', { style: CONTROLS_STYLE },
      createElement(PixiesMicButton, {
        active: listening,
        label: listening ? (messages.micActive ?? 'Listening') : (messages.mic ?? 'Speak'),
        onClick: () => {
          if (listening) {
            // Stopping produces no further event, but the already-recognized
            // draft is still the user's input: send it instead of dropping it.
            // (Tapping the mic again means "I'm done" — without this the
            // transcript shown mid-round is silently lost.)
            const recognized = partial
            bridge?.stopSpeech()
            setListening(false)
            setPartial('')
            if (recognized.trim() !== '') onFinalTranscript?.(recognized)
            return
          }
          // Feedback starts with the click, not with the first event: while the
          // macOS authorization prompt is pending the CLI emits nothing at all,
          // and a click that shows nothing is indistinguishable from a dead app.
          setListening(true)
          setPartial('')
          setSpeechError('')
          bridge?.startSpeech()
        },
      }),
      createElement(PixiesCollapseButton, {
        label: messages.collapse ?? 'Collapse',
        onClick: () => { bridge?.collapse() },
      }),
    ),
  )
}

/**
 * Mount the character overlay into a full-window container, keep it live from
 * the store, and honor the optional Electron bridge: with a bridge the window
 * starts as the mini peek avatar (click = expand) and the mic routes speech
 * input (final transcript → `onFinalTranscript`); without one the panel
 * renders expanded and static (plain web pages).
 * @param container - the overlay mount point (owned by this function).
 * @param store - the Pixies store to render from.
 * @param messages - shell interaction copy.
 * @param bridge - the preload bridge; defaults to a global-scope lookup.
 * @param onFinalTranscript - callback for each final speech transcript.
 * @returns a disposer that unmounts the React root.
 */
export function mountPixiesShell(
  container: HTMLElement,
  store: PixiesStore,
  messages: PixiesPanelMessages = defaultPixiesMessages,
  bridge: PixiesShellBridge | undefined = resolvePixiesShellBridge(),
  onFinalTranscript?: (text: string) => void,
): () => void {
  const root: Root = createRoot(container)
  root.render(createElement(ShellPanel, { store, messages, bridge, onFinalTranscript }))
  return () => { root.unmount() }
}
