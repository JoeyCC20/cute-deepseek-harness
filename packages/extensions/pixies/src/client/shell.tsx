/**
 * Pixies shell surface: the session-follow feed that keeps the store current
 * from the client sessions domain, and the full-window React mount the pixies
 * Electron shell activates through the `__DSH_PIXIES_SHELL__` page marker.
 * @module @deepseek-ai/dsh-pixies/client/shell
 */

import { createElement, Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  ISessions,
  SessionListState,
  SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PixiesExpandedView, PixiesIconMenu, PixiesMiniView, type PixiesConversationProps } from './conversation.tsx'
import { feedSessionEvent, type SessionEventLike } from './feed.ts'
import { defaultPixiesMessages, resolvePixiesMessages, type PixiesPanelMessages } from './locale.ts'
import { createPixiesStore, type PixiesMessage, type PixiesStore } from './store.ts'
import { spokenReplyText } from './voice-summary.ts'

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

/** How a shortcut-started voice round treats the turn already running. */
export type PixiesShellVoiceCommandMode = 'replace' | 'queue'

/** One voice-command or task-control signal from the Electron preload bridge. */
export interface PixiesShellVoiceCommandEvent {
  readonly type: 'start' | 'stop' | 'cancel'
  /** Present on `start`: `replace` stops the running turn; `queue` leaves it. */
  readonly mode?: PixiesShellVoiceCommandMode
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
  /** Open the standalone settings window (optional on older shells). */
  readonly openSettings?: () => void
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
  /** Hide the floating icon back to the menu bar (optional on older shells). */
  readonly hide?: () => void
  /** End a shortcut-shown icon after its round finishes (optional on older shells). */
  readonly dismissAutoIcon?: () => void
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

/** Narrow one wire payload from the voice-command/task-control channel. */
export function isPixiesVoiceCommandEvent(value: unknown): value is PixiesShellVoiceCommandEvent {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  if (payload.type !== 'start' && payload.type !== 'stop' && payload.type !== 'cancel') return false
  if (payload.mode === undefined) return true
  return payload.mode === 'replace' || payload.mode === 'queue'
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
  /** Choose a session; listeners run even for a repeated choice so the view can reopen its history. */
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
  /** Create a fresh session and make it the followed one; resolves to its id. */
  readonly create: () => Promise<SessionId>
  /** Ids archived by the Workspace Controller; history hides these rows. */
  readonly hiddenIds: () => readonly SessionId[]
  /** Remove one session from history, moving the follow off it when needed. */
  readonly remove: (id: SessionId) => Promise<void>
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
 * Cancel the running turn in the followed session. No session is created: an
 * absent target has nothing to stop, and an unattached Agent is already idle,
 * so `session/not-found` is not reported as a failure.
 * @param sessions - the client sessions face.
 * @param selection - the shell's chosen session, when it has one.
 * @throws when the cancel RPC fails for any other reason.
 */
export async function cancelPixiesSession(
  sessions: ISessions,
  selection?: PixiesSessionSelection,
): Promise<void> {
  const target = pickPixiesSessionId(sessions.list.getSnapshot(), selection?.get())
  if (target === undefined) return
  await sessions.using(target, { source: 'pixiesShell' }, async (reference) => {
    await reference.ready
    const result = await reference.binding.session.cancel()
    if (!result.ok && result.error.code !== 'session/not-found') {
      throw new Error(`${result.error.code}: ${result.error.message}`)
    }
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
 * (`pixiesShell` source) and rebinds when the followed session or the shell's
 * selection changes. The initial open seeds both watermarks so only live
 * output reaches the character; a shell selection instead replays that
 * session's window into the store so the conversation shows the chosen one.
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

  const rebind = (state: SessionListState, replay: boolean): void => {
    const target = pickPixiesSessionId(state, selection?.get())
    if (target === undefined || (target === followedSessionId && !replay)) return
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
      // Replaying into a throwaway store keeps the visible window to one
      // notification and lets every replayed row be marked as history.
      const replayStore = replay ? createPixiesStore() : undefined
      for (const entry of source.getSnapshot().entries) {
        if (entry.type === 'transient') {
          if (entry.event.seq > highWaterTransientSeq) highWaterTransientSeq = entry.event.seq
        } else if (entry.event.seq > highWaterSeq) highWaterSeq = entry.event.seq
        if (replayStore !== undefined) {
          feedSessionEvent(replayStore, binding.sessionId, entry.event, true)
        }
      }
      if (replayStore !== undefined) {
        store.hydrate(replayStore.getState().messages.map((message, index) => ({
          ...message,
          id: `history-${String(index)}`,
          historical: true,
        })))
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

  const unsubscribeList = sessions.list.subscribe(() => { rebind(sessions.list.getSnapshot(), false) })
  const unsubscribeSelection = selection?.subscribe(() => { rebind(sessions.list.getSnapshot(), true) })
  rebind(sessions.list.getSnapshot(), false)
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
  readonly onCancelTask: (() => void | Promise<void>) | undefined
  readonly sessionPanel: PixiesSessionPanel | undefined
}

function ShellPanel({ store, messages, bridge, onSendText, onCancelTask, sessionPanel }: ShellPanelProps): ReactElement {
  const [state, setState] = useState(store.getState)
  const [sessionList, setSessionList] = useState<SessionListState | undefined>(sessionPanel?.getSnapshot())
  const [hiddenSessionIds, setHiddenSessionIds] = useState<readonly SessionId[]>(sessionPanel?.hiddenIds() ?? [])
  const [selectedSessionId, setSelectedSessionId] = useState<SessionId | undefined>(sessionPanel?.selectedId())
  const [creatingSession, setCreatingSession] = useState(false)
  const [newSessionError, setNewSessionError] = useState('')
  const [mode, setMode] = useState<PixiesShellMode>(bridge === undefined ? 'expanded' : 'mini')
  const [listening, setListening] = useState(false)
  const [partial, setPartial] = useState('')
  const [speechError, setSpeechError] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const [voiceReplies, setVoiceReplies] = useState(true)
  const [speaking, setSpeaking] = useState(false)
  const [awaitingReply, setAwaitingReply] = useState(false)
  const [draft, setDraft] = useState('')
  const [iconMenu, setIconMenu] = useState<{ readonly x: number; readonly y: number } | undefined>(undefined)
  const roundActiveRef = useRef(false)
  const copy = useMemo(() => resolvePixiesMessages(messages), [messages])
  // Shortcut callbacks arrive outside React's render flow, so the latest
  // recognized draft and the last spoken reply must live in refs.
  const partialRef = useRef('')
  const spokenIdRef = useRef(lastReply(state.messages)?.id)
  const submittedReplyIdRef = useRef<string | undefined>(undefined)
  // A stop signal discards the live round, including a final transcript the
  // recognizer may still emit after its stdin closes.
  const discardSpeechRef = useRef(false)
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
  const followedSessionId = selectedSessionId ?? sessionList?.current
  const catalogRunning = followedSessionId !== undefined
    && sessionList?.byId[followedSessionId]?.running === true
  const taskRunning = awaitingReply || state.pendingSession !== undefined || catalogRunning
  const cancelTask = useCallback((): void => {
    // Only a live turn produces stop feedback: an idle voice round must not
    // leave a "task stopped" line (or speak one) on every shortcut press.
    if (taskRunning) {
      setAwaitingReply(false)
      const pending = store.getState().pendingSession
      if (pending !== undefined) store.endThinking(pending)
      store.appendMessage({ role: 'system', text: copy.taskStopped, mood: 'neutral' })
      // Control feedback is not a reply: move the playback cursor past it so
      // the voice-reply effect never reads this line aloud.
      const newest = lastReply(store.getState().messages)
      if (newest !== undefined) spokenIdRef.current = newest.id
    }
    void Promise.resolve(onCancelTask?.()).catch((error: unknown) => {
      // An idle session is already handled upstream; other cancel failures stay visible.
      setSpeechError(`${copy.promptFailed}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [onCancelTask, copy, store, taskRunning])
  useEffect(() => store.subscribe(setState), [store])
  // A shortcut-shown icon exists only for the round in progress: listening,
  // thinking and reply playback all keep it visible. The main process decides
  // whether this particular icon is a temporary one.
  useEffect(() => {
    if (bridge?.dismissAutoIcon === undefined) return
    const active = listening || awaitingReply || state.pendingSession !== undefined || speaking
    if (active) { roundActiveRef.current = true; return }
    if (!roundActiveRef.current) return
    roundActiveRef.current = false
    bridge.dismissAutoIcon()
  }, [bridge, listening, awaitingReply, state.pendingSession, speaking])
  useEffect(() => {
    if (sessionPanel === undefined) return
    // A pure selection change keeps the catalog snapshot's identity, so the
    // selected id needs its own state to re-render the active history row.
    const sync = (): void => {
      setSessionList(sessionPanel.getSnapshot())
      setHiddenSessionIds(sessionPanel.hiddenIds())
      setSelectedSessionId(sessionPanel.selectedId())
    }
    sync()
    return sessionPanel.subscribe(sync)
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
  // the host. A marked takeaway is the whole utterance; without one the full
  // reply is spoken. History present at mount is never replayed aloud.
  useEffect(() => {
    const newest = lastReply(state.messages)
    if (newest === undefined || newest.id === spokenIdRef.current) return
    spokenIdRef.current = newest.id
    if (newest.historical === true) return
    if (voiceReplies && bridge?.speakReply !== undefined) bridge.speakReply(spokenReplyText(newest.text))
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
        discardSpeechRef.current = false
        setListening(true)
        setPartialText('')
        setSpeechError('')
        setVoiceError('')
        setAwaitingReply(false)
        // A replace round stops the turn before its transcript is submitted;
        // a queue round leaves it running and relies on the inbox order.
        if (event.mode === 'replace') cancelTask()
        return
      }
      if (event.type === 'cancel') {
        discardSpeechRef.current = true
        setListening(false)
        setPartialText('')
        setAwaitingReply(false)
        cancelTask()
        return
      }
      // A second press ends the round: the recognized draft is still input.
      const recognized = partialRef.current
      setListening(false)
      setPartialText('')
      if (recognized.trim() !== '' && !discardSpeechRef.current) sendText(recognized)
    })
  }, [bridge, sendText, setPartialText, cancelTask])

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
      if (event.type === 'final' && event.text !== '' && !discardSpeechRef.current) {
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
    if (sessionPanel === undefined) return
    // Clicking the already-selected row reopens it too, so a blank transcript
    // can always be restored from that session's log.
    store.clear()
    setAwaitingReply(false)
    setSelectedSessionId(id)
    sessionPanel.select(id)
  }, [sessionPanel, store])

  const onNewSession = useCallback((): void => {
    if (sessionPanel === undefined || creatingSession) return
    setCreatingSession(true)
    setNewSessionError('')
    void sessionPanel.create().then((id) => {
      store.clear()
      setAwaitingReply(false)
      setSelectedSessionId(id)
    }).catch((error: unknown) => {
      setNewSessionError(`${copy.newSessionFailed}: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      setCreatingSession(false)
    })
  }, [sessionPanel, creatingSession, store, copy])

  const onRemoveSession = useCallback(async (id: SessionId): Promise<void> => {
    if (sessionPanel === undefined) return
    await sessionPanel.remove(id)
  }, [sessionPanel])

  const onContextMenu = useCallback((event: MouseEvent<HTMLDivElement>): void => {
    if (bridge?.hide === undefined) return
    event.preventDefault()
    // Clamp into the viewport: the mini window is only 112px wide.
    setIconMenu({
      x: Math.max(4, Math.min(event.clientX, window.innerWidth - 104)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - 48)),
    })
  }, [bridge])
  const onHideIcon = useCallback((): void => {
    bridge?.hide?.()
    setIconMenu(undefined)
  }, [bridge])

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
    taskRunning,
    onStop: cancelTask,
    onExpand,
    onCollapse,
    onMicToggle,
    onVoiceToggle,
    sessionList,
    hiddenSessionIds,
    selectedSessionId,
    onSelectSession,
    onRemoveSession,
    newSessionPending: creatingSession,
    newSessionError,
    onNewSession,
    onContextMenu,
  }
  return createElement(Fragment, null,
    mode === 'mini'
      ? createElement(PixiesMiniView, props)
      : createElement(PixiesExpandedView, props),
    iconMenu !== undefined
      ? createElement(PixiesIconMenu, {
        copy,
        x: iconMenu.x,
        y: iconMenu.y,
        onHide: onHideIcon,
        onClose: () => { setIconMenu(undefined) },
      })
      : null,
  )
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
 * @param onCancelTask - callback for the stop/replace shortcut signals; a
 *   returned Promise's rejection surfaces in the status bubble.
 * @returns a disposer that unmounts the React root.
 */
export function mountPixiesShell(
  container: HTMLElement,
  store: PixiesStore,
  messages: PixiesPanelMessages = defaultPixiesMessages,
  bridge: PixiesShellBridge | undefined = resolvePixiesShellBridge(),
  onFinalTranscript?: (text: string) => void | Promise<void>,
  sessionPanel?: PixiesSessionPanel,
  onCancelTask?: () => void | Promise<void>,
): () => void {
  const root: Root = createRoot(container)
  root.render(createElement(ShellPanel, {
    store, messages, bridge, onSendText: onFinalTranscript, sessionPanel, onCancelTask,
  }))
  return () => { root.unmount() }
}
