/**
 * Pixies shell surface: the session-follow feed that keeps the store current
 * from the client sessions domain, and the full-window React mount the pixies
 * Electron shell activates through the `__DSH_PIXIES_SHELL__` page marker.
 * @module @deepseek-ai/dsh-pixies/client/shell
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  ISessions,
  SessionListState,
  SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PixiesExpandedView, PixiesMiniView, type PixiesConversationProps } from './conversation.tsx'
import { feedSessionEvent, type SessionEventLike } from './feed.ts'
import { defaultPixiesMessages, resolvePixiesMessages, type PixiesPanelMessages } from './locale.ts'
import type { PixiesMessage, PixiesStore } from './store.ts'

export { defaultPixiesMessages, resolvePixiesMessages } from './locale.ts'
export type { PixiesPanelMessages, PixiesResolvedMessages } from './locale.ts'

/** One speech-input event forwarded by the Electron preload bridge. */
export type PixiesShellSpeechEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'partial'; readonly text: string }
  | { readonly type: 'final'; readonly text: string }
  | { readonly type: 'error'; readonly message: string }

/** One speech-output event forwarded by the Electron preload bridge. */
export type PixiesShellVoiceEvent =
  | { readonly type: 'speaking' }
  | { readonly type: 'done' }
  | { readonly type: 'cancelled' }
  | { readonly type: 'error'; readonly message: string }

/** The global voice-command shortcut's start/stop signal. */
export interface PixiesShellVoiceCommandEvent {
  readonly type: 'start' | 'stop'
}

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
  /** Send one pointermove delta while the user drags the floating window. */
  readonly dragBy: (deltaX: number, deltaY: number) => void
  /** Query the mode the main process owns (optional on older shells). */
  readonly getMode?: () => Promise<unknown>
  /** Finish a drag gesture (optional on older shells). */
  readonly endDrag?: () => void
  readonly onSpeech: (listener: (event: PixiesShellSpeechEvent) => void) => () => void
  readonly onMode: (listener: (mode: PixiesShellMode) => void) => () => void
  /** Optional on older shells: speak one assistant reply through the host. */
  readonly speakReply?: (text: string) => void
  /** Optional on older shells: stop the reply currently being spoken. */
  readonly cancelReply?: () => void
  /** Optional on older shells: speaking/done/error events (wire payloads). */
  readonly onVoiceReply?: (listener: (event: unknown) => void) => () => void
  /** Optional on older shells: the global voice-command shortcut signal. */
  readonly onVoiceCommand?: (listener: (event: unknown) => void) => () => void
}

/** Whether an unknown bridge payload names a real shell mode. */
function isShellMode(value: unknown): value is PixiesShellMode {
  return value === 'mini' || value === 'expanded'
}

/** Give up on a silent host so the avatar never spins forever. */
const AWAITING_REPLY_TIMEOUT_MS = 90_000

/** Narrow one wire payload from the speech-output channel. */
export function isPixiesVoiceReplyEvent(value: unknown): value is PixiesShellVoiceEvent {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  if (payload.type === 'speaking' || payload.type === 'done' || payload.type === 'cancelled') return true
  return payload.type === 'error' && typeof payload.message === 'string'
}

/** Narrow one wire payload from the voice-command shortcut channel. */
export function isPixiesVoiceCommandEvent(value: unknown): value is PixiesShellVoiceCommandEvent {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as Record<string, unknown>).type
  return type === 'start' || type === 'stop'
}

/** Newest non-user entry in the visible history (a reply or a turn failure). */
function lastReply(messages: readonly PixiesMessage[]): PixiesMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role !== 'user') return message
  }
  return undefined
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
    || typeof bridge.dragBy !== 'function'
    || typeof bridge.onSpeech !== 'function' || typeof bridge.onMode !== 'function') return undefined
  return candidate as PixiesShellBridge
}

/**
 * A local session preference shared by the event follow, the prompt sender,
 * and the history panel. The host never projects `SessionListState.current`,
 * so Pixies keeps its own selection instead of writing the host catalog.
 */
export interface PixiesSessionSelection {
  /** The explicitly chosen session, or undefined to follow the catalog head. */
  readonly get: () => SessionId | undefined
  /** Choose a session; a repeated choice is a no-op. */
  readonly set: (id: SessionId) => void
  /** Observe selection changes. */
  readonly subscribe: (listener: () => void) => () => void
}

/** Create the in-window session selection owned by one plugin application. */
export function createPixiesSessionSelection(): PixiesSessionSelection {
  let selected: SessionId | undefined
  const listeners = new Set<() => void>()
  return {
    get: () => selected,
    set: (id) => {
      if (selected === id) return
      selected = id
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * The catalog and selection face the expanded panel renders. `subscribe`
 * covers both catalog mutations and selection changes, so one subscription
 * keeps the history drawer live.
 */
export interface PixiesSessionPanel {
  readonly getSnapshot: () => SessionListState
  readonly subscribe: (listener: () => void) => () => void
  readonly selectedId: () => SessionId | undefined
  readonly select: (id: SessionId) => void
}

/**
 * Send one prompt as a queued text message into the followed session (the same
 * selection the character follows), creating that session first when the
 * profile has none. The prompt runs under `sessions.using`, which retains the
 * target: a binding exists only for a retained generation. Failures propagate
 * to the caller so the bubble can say why.
 * @param sessions - the client sessions face.
 * @param text - the prompt text; blank text is dropped.
 * @param selection - the shell's chosen session, when it has one.
 * @throws when session creation, retention, or the prompt RPC fails.
 */
export async function promptPixiesSession(
  sessions: ISessions,
  text: string,
  selection?: PixiesSessionSelection,
): Promise<void> {
  if (text.trim() === '') return
  const selected = pickPixiesSessionId(sessions.list.getSnapshot(), selection?.get())
  const target = selected !== undefined ? selected : await sessions.create()
  await sessions.using(target, { source: 'pixiesShell' }, async (reference) => {
    await reference.ready
    const result = await reference.binding.session.prompt([{ type: 'text', text }], 'queue')
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  })
}

/**
 * Pick the session the character follows: an explicit shell choice, then the
 * catalog's own current preference, then the first host-listed session. A
 * preference that is no longer listed cannot strand the follow on a dead id.
 * @param state - the sessions list snapshot.
 * @param preferred - the shell's chosen session, when it has one.
 * @returns the followed session id, or undefined while no session exists.
 */
export function pickPixiesSessionId(state: SessionListState, preferred?: SessionId): SessionId | undefined {
  if (preferred !== undefined && state.ids.includes(preferred)) return preferred
  if (state.current !== undefined && state.ids.includes(state.current)) return state.current
  return state.ids.length > 0 ? state.ids[0] : undefined
}

/** Disposable handle for the session follow. */
export interface PixiesSessionFollow {
  /** Stop following and release every subscription. */
  readonly dispose: () => void
}

/**
 * Follow the target session's event window and feed every newly appended
 * durable event and client-only live chunk into the store. Transient rows have
 * fractional seqs on a different axis from durable logs, so they carry their
 * own watermark. The follow retains the followed session for its own lifetime
 * (`pixiesShell` source), rebinds when the followed session or the shell's
 * selection changes, and seeds both watermarks after the initial history open
 * so only live output reaches the character.
 * @param sessions - the client sessions face.
 * @param store - the Pixies store to publish into.
 * @param selection - the shell's chosen session, when it has one.
 * @returns a disposable follow handle.
 */
export function followPixiesSession(
  sessions: ISessions,
  store: PixiesStore,
  selection?: PixiesSessionSelection,
): PixiesSessionFollow {
  let disposeEvents: (() => void) | undefined
  let held: SessionReference | undefined
  let followedSessionId: SessionId | undefined
  let highWaterSeq = -1
  let highWaterTransientSeq = -1
  let generation = 0
  let disposed = false

  const releaseEvents = (): void => {
    disposeEvents?.()
    disposeEvents = undefined
  }

  const rebind = (state: SessionListState): void => {
    const target = pickPixiesSessionId(state, selection?.get())
    if (target === undefined || target === followedSessionId) return
    const ticket = ++generation
    releaseEvents()
    followedSessionId = target
    highWaterSeq = -1
    highWaterTransientSeq = -1
    held?.release()
    const reference = sessions.retain(target, { source: 'pixiesShell' })
    held = reference
    void reference.ready.then((binding) => {
      // A rebind or dispose may have superseded this reference meanwhile.
      if (disposed || ticket !== generation) return
      const source = binding.eventSource
      for (const entry of source.getSnapshot().entries) {
        if (entry.type === 'transient') {
          if (entry.event.seq > highWaterTransientSeq) highWaterTransientSeq = entry.event.seq
        } else if (entry.event.seq > highWaterSeq) highWaterSeq = entry.event.seq
      }
      disposeEvents = source.subscribe(() => {
        for (const entry of source.getSnapshot().entries) {
          const event: SessionEventLike = entry.event
          if (entry.type === 'transient') {
            if (event.seq <= highWaterTransientSeq) continue
            highWaterTransientSeq = event.seq
          } else {
            if (event.seq <= highWaterSeq) continue
            highWaterSeq = event.seq
          }
          feedSessionEvent(store, binding.sessionId, event)
        }
      })
    }).catch(() => {
      // The open attempt failed (session vanished, transport dropped): stay
      // detached; the next list mutation retries through rebind.
    })
  }

  const refresh = (): void => { rebind(sessions.list.getSnapshot()) }
  const unsubscribeList = sessions.list.subscribe(refresh)
  const unsubscribeSelection = selection?.subscribe(refresh)
  refresh()
  return {
    dispose: () => {
      disposed = true
      generation += 1
      unsubscribeList()
      unsubscribeSelection?.()
      releaseEvents()
      held?.release()
      held = undefined
      followedSessionId = undefined
    },
  }
}

/** Props owned by the shell mount; the conversation views receive the rest. */
interface ShellPanelProps {
  readonly store: PixiesStore
  readonly messages: PixiesPanelMessages
  readonly bridge: PixiesShellBridge | undefined
  readonly onSendText: ((text: string) => void | Promise<void>) | undefined
  readonly sessionPanel: PixiesSessionPanel | undefined
}

function ShellPanel({ store, messages, bridge, onSendText, sessionPanel }: ShellPanelProps): ReactElement {
  const [state, setState] = useState(store.getState)
  const [sessionList, setSessionList] = useState<SessionListState | undefined>(sessionPanel?.getSnapshot())
  const [mode, setMode] = useState<PixiesShellMode>(bridge === undefined ? 'expanded' : 'mini')
  const [listening, setListening] = useState(false)
  const [partial, setPartial] = useState('')
  const [speechError, setSpeechError] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const [voiceReplies, setVoiceReplies] = useState(true)
  const [speaking, setSpeaking] = useState(false)
  const [awaitingReply, setAwaitingReply] = useState(false)
  const [draft, setDraft] = useState('')
  const copy = useMemo(() => resolvePixiesMessages(messages), [messages])
  // Shortcut callbacks arrive outside React's render flow, so the latest
  // recognized draft and the last spoken reply must live in refs.
  const partialRef = useRef('')
  const spokenIdRef = useRef(lastReply(state.messages)?.id)
  const submittedReplyIdRef = useRef<string | undefined>(undefined)
  const setPartialText = useCallback((text: string): void => {
    partialRef.current = text
    setPartial(text)
  }, [])
  const sendText = useCallback((text: string): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    // Thinking feedback starts with the submit itself: the host's turn/start
    // arrives later (or not at all), so session events alone leave a gap.
    submittedReplyIdRef.current = lastReply(store.getState().messages)?.id
    setAwaitingReply(true)
    store.appendMessage({ role: 'user', text: trimmed })
    void Promise.resolve(onSendText?.(trimmed)).catch((error: unknown) => {
      setSpeechError(`${copy.promptFailed}: ${error instanceof Error ? error.message : String(error)}`)
      setAwaitingReply(false)
    })
  }, [onSendText, store, copy])
  useEffect(() => store.subscribe(setState), [store])
  useEffect(() => {
    if (sessionPanel === undefined) return
    return sessionPanel.subscribe(() => { setSessionList(sessionPanel.getSnapshot()) })
  }, [sessionPanel])

  // Any new non-user entry (a reply or a turn failure) ends the wait, even if
  // the turn/end event is late or missing.
  useEffect(() => {
    if (!awaitingReply) return
    const newest = lastReply(state.messages)
    if (newest !== undefined && newest.id !== submittedReplyIdRef.current) setAwaitingReply(false)
  }, [state.messages, awaitingReply])

  useEffect(() => {
    if (!awaitingReply) return
    const timer = setTimeout(() => { setAwaitingReply(false) }, AWAITING_REPLY_TIMEOUT_MS)
    return () => { clearTimeout(timer) }
  }, [awaitingReply])

  // Voice-first results: the newest reply (or turn failure) is spoken through
  // the host. History present at mount is never replayed aloud.
  useEffect(() => {
    const newest = lastReply(state.messages)
    if (newest === undefined || newest.id === spokenIdRef.current) return
    spokenIdRef.current = newest.id
    if (voiceReplies && bridge?.speakReply !== undefined) bridge.speakReply(newest.text)
  }, [state.messages, voiceReplies, bridge])

  useEffect(() => {
    if (bridge?.onVoiceReply === undefined) return
    return bridge.onVoiceReply((event: unknown) => {
      if (!isPixiesVoiceReplyEvent(event)) return
      if (event.type === 'speaking') {
        setSpeaking(true)
        setVoiceError('')
        return
      }
      setSpeaking(false)
      if (event.type === 'error') setVoiceError(`${copy.voiceFailed}: ${event.message}`)
    })
  }, [bridge, copy])

  useEffect(() => {
    if (bridge?.onVoiceCommand === undefined) return
    return bridge.onVoiceCommand((event: unknown) => {
      if (!isPixiesVoiceCommandEvent(event)) return
      if (event.type === 'start') {
        setListening(true)
        setPartialText('')
        setSpeechError('')
        setVoiceError('')
        setAwaitingReply(false)
        return
      }
      // A second press ends the round: the recognized draft is still input.
      const recognized = partialRef.current
      setListening(false)
      setPartialText('')
      if (recognized.trim() !== '') sendText(recognized)
    })
  }, [bridge, sendText, setPartialText])

  // The main process owns the real geometry. Reconcile on mount so a tray
  // shortcut or a restored expanded session cannot leave the renderer showing
  // the wrong surface.
  useEffect(() => {
    if (bridge?.getMode === undefined) return
    let alive = true
    void bridge.getMode().then((value) => {
      if (alive && isShellMode(value)) setMode(value)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [bridge])

  useEffect(() => {
    if (bridge === undefined) return
    const offMode = bridge.onMode((value) => {
      if (isShellMode(value)) setMode(value)
    })
    const offSpeech = bridge.onSpeech((event) => {
      if (event.type === 'partial') {
        setListening(true)
        setPartialText(event.text)
        setSpeechError('')
        return
      }
      if (event.type === 'ready') {
        setListening(true)
        setPartialText('')
        setSpeechError('')
        return
      }
      // final and error both end the listening round.
      setListening(false)
      setPartialText('')
      bridge.stopSpeech()
      if (event.type === 'final' && event.text !== '') {
        setSpeechError('')
        sendText(event.text)
      } else if (event.type === 'error') {
        setSpeechError(`${copy.speechFailed}: ${event.message}`)
      }
    })
    return () => { offMode(); offSpeech() }
  }, [bridge, sendText, copy, setPartialText])

  const onMicToggle = useCallback((): void => {
    if (bridge === undefined) {
      setSpeechError(copy.speechUnavailable)
      return
    }
    if (listening) {
      // Stopping produces no further event, but the already-recognized draft
      // is still the user's input: send it instead of dropping it.
      const recognized = partialRef.current
      bridge.stopSpeech()
      setListening(false)
      setPartialText('')
      if (recognized.trim() !== '') sendText(recognized)
      return
    }
    // Feedback starts with the click: while the macOS authorization prompt is
    // pending the speech CLI emits nothing at all.
    setListening(true)
    setPartialText('')
    setSpeechError('')
    setAwaitingReply(false)
    bridge.startSpeech()
  }, [listening, bridge, sendText, copy, setPartialText])

  const onVoiceToggle = useCallback((): void => {
    const next = !voiceReplies
    setVoiceReplies(next)
    if (!next) {
      bridge?.cancelReply?.()
      setSpeaking(false)
      setVoiceError('')
    }
  }, [voiceReplies, bridge])

  const onSend = useCallback((text: string): void => {
    if (text.trim() === '') return
    sendText(text)
    setDraft('')
  }, [sendText])
  const onExpand = useCallback((): void => { bridge?.expand() }, [bridge])
  const onCollapse = useCallback((): void => { bridge?.collapse() }, [bridge])
  const onSelectSession = useCallback((id: SessionId): void => {
    if (sessionPanel === undefined || id === sessionPanel.selectedId()) return
    // The visible transcript belongs to the old session; a new selection
    // starts a fresh window instead of mixing two conversations.
    store.clear()
    setAwaitingReply(false)
    sessionPanel.select(id)
  }, [sessionPanel, store])

  const props: PixiesConversationProps = {
    copy,
    state,
    bridge,
    listening,
    partial,
    error: speechError,
    voiceError,
    speaking,
    voiceReplies,
    awaitingReply,
    draft,
    onDraftChange: setDraft,
    onSend,
    onExpand,
    onCollapse,
    onMicToggle,
    onVoiceToggle,
    sessionList,
    selectedSessionId: sessionPanel?.selectedId(),
    onSelectSession,
  }
  return mode === 'mini'
    ? createElement(PixiesMiniView, props)
    : createElement(PixiesExpandedView, props)
}

/**
 * Mount the character overlay into a full-window container, keep it live from
 * the store, and honor the optional Electron bridge: with a bridge the window
 * starts as the mini peek avatar (click = expand) and both text and speech
 * input queue prompts through `onFinalTranscript`; without one the panel
 * renders expanded on a plain web page.
 * @param container - the overlay mount point (owned by this function).
 * @param store - the Pixies store to render from.
 * @param messages - shell interaction copy (locale-owned).
 * @param bridge - the preload bridge; defaults to a global-scope lookup.
 * @param onFinalTranscript - callback for each submitted prompt; a returned
 *   Promise's rejection (send failure) surfaces in the status bubble.
 * @param sessionPanel - the live catalog/selection rendered by the history drawer.
 * @returns a disposer that unmounts the React root.
 */
export function mountPixiesShell(
  container: HTMLElement,
  store: PixiesStore,
  messages: PixiesPanelMessages = defaultPixiesMessages,
  bridge: PixiesShellBridge | undefined = resolvePixiesShellBridge(),
  onFinalTranscript?: (text: string) => void | Promise<void>,
  sessionPanel?: PixiesSessionPanel,
): () => void {
  const root: Root = createRoot(container)
  root.render(createElement(ShellPanel, { store, messages, bridge, onSendText: onFinalTranscript, sessionPanel }))
  return () => { root.unmount() }
}
