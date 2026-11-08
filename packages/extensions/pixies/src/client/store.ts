/**
 * Client-side reactive store for the Pixies character: the latest speech
 * presentation, the pending interaction, and the visible conversation history.
 * Pure and framework-free so it is unit-testable on node.
 * @module @deepseek-ai/dsh-pixies/client/store
 */

import type { PixiesInteraction, PixiesMood, PixiesPresentation } from '../types.ts'

/** Who produced one visible conversation entry. */
export type PixiesMessageRole = 'user' | 'assistant' | 'system'

/** One conversation entry rendered by the expanded panel. */
export interface PixiesMessage {
  readonly id: string
  readonly role: PixiesMessageRole
  readonly text: string
  readonly mood: PixiesMood
  readonly at: number
}

/** The fields a caller supplies when publishing an entry. */
export interface PixiesMessageDraft {
  readonly role: PixiesMessageRole
  readonly text: string
  readonly mood?: PixiesMood
}

/** Cap the in-window history: a desktop companion can stay open for days. */
const MAX_MESSAGES = 200
/** Cap a reasoning stream so a runaway turn cannot grow the window forever. */
const MAX_THINKING_CHARS = 12_000

/** The reasoning stream of the most recent turn, kept after it settles. */
export interface PixiesThinking {
  /** Session that produced the stream; a rebind starts a different round. */
  readonly sessionId: string
  /** Incremental reasoning text, oldest first. */
  readonly text: string
  /** Whether live deltas are still arriving. */
  readonly active: boolean
}

/** One immutable snapshot of the character's display state. */
export interface PixiesClientState {
  /** Latest speech presentation, or undefined when idle. */
  readonly latest: PixiesPresentation | undefined
  /** Latest observed approval/question interaction, or undefined when none. */
  readonly interaction: PixiesInteraction | undefined
  /**
   * The session currently mid-turn waiting for its first assistant reply.
   * Drives the thinking bubble between user/message and assistant/message.
   */
  readonly pendingSession: string | undefined
  /** Reasoning stream of the latest turn, or undefined before any arrives. */
  readonly thinking: PixiesThinking | undefined
  /** Visible conversation history, oldest first. */
  readonly messages: readonly PixiesMessage[]
}

/** State-change listener. */
export type PixiesListener = (state: PixiesClientState) => void

/** The store surface consumed by the character panel and the client entry. */
export interface PixiesStore {
  readonly getState: () => PixiesClientState
  readonly subscribe: (listener: PixiesListener) => () => void
  /** Publish one speech presentation (also appends an assistant message). */
  readonly speak: (presentation: PixiesPresentation) => void
  /** Append one locally produced conversation entry. */
  readonly appendMessage: (draft: PixiesMessageDraft) => void
  /** Set or clear the pending interaction the character should react to. */
  readonly setInteraction: (interaction: PixiesInteraction | undefined) => void
  /** Mark a session as mid-turn; subsequent calls for the same id are no-ops. */
  readonly beginThinking: (sessionId: string) => void
  /** Clear the pending-turn marker; safe to call with no marker set. */
  readonly endThinking: (sessionId: string) => void
  /** Append one live reasoning delta to the active round. */
  readonly appendThinking: (sessionId: string, delta: string) => void
  /** Close the round, replacing the live text with the durable reasoning when available. */
  readonly settleThinking: (sessionId: string, reasoning: string | undefined) => void
  /** Reset every field and notify listeners. */
  readonly clear: () => void
}

/**
 * Create an empty Pixies store.
 * @returns a store with no presentation, no interaction, and no history.
 */
export function createPixiesStore(): PixiesStore {
  let latest: PixiesPresentation | undefined
  let interaction: PixiesInteraction | undefined
  let pendingSession: string | undefined
  let thinking: PixiesThinking | undefined
  let messages: readonly PixiesMessage[] = []
  let sequence = 0
  const listeners = new Set<PixiesListener>()
  const emit = (): void => {
    const state: PixiesClientState = { latest, interaction, pendingSession, thinking, messages }
    for (const listener of listeners) listener(state)
  }
  const finishThinking = (sessionId: string): void => {
    if (thinking?.sessionId === sessionId && thinking.active) thinking = { ...thinking, active: false }
  }
  const append = (draft: PixiesMessageDraft, id: string): void => {
    if (draft.text === '') return
    sequence += 1
    const message: PixiesMessage = {
      id,
      role: draft.role,
      text: draft.text,
      mood: draft.mood ?? 'neutral',
      at: Date.now(),
    }
    messages = [...messages, message].slice(-MAX_MESSAGES)
  }
  return {
    getState: () => ({ latest, interaction, pendingSession, thinking, messages }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    speak: (presentation) => {
      latest = presentation
      // A visible reply ends that session's thinking state even when the
      // turn/end event is late or never arrives (a dropped event must not
      // leave "thinking" covering the answer forever).
      if (pendingSession === presentation.sessionId) pendingSession = undefined
      finishThinking(presentation.sessionId)
      append({ role: 'assistant', text: presentation.text, mood: presentation.mood }, presentation.id)
      emit()
    },
    appendMessage: (draft) => {
      // A user prompt starts a new round, so the previous turn's reasoning is
      // no longer the one the disclosure should show.
      if (draft.role === 'user') thinking = undefined
      append(draft, `local-${String(sequence + 1)}`)
      emit()
    },
    setInteraction: (next) => { interaction = next; emit() },
    beginThinking: (sessionId) => {
      const stale = thinking !== undefined && !thinking.active
      if (stale) thinking = undefined
      if (pendingSession === sessionId && !stale) return
      pendingSession = sessionId
      emit()
    },
    endThinking: (sessionId) => {
      // endThinking clears only when the caller's session owns the marker,
      // so a late turn/end from a previous session cannot erase the live one.
      if (pendingSession !== undefined && pendingSession !== sessionId) return
      if (pendingSession === undefined) return
      pendingSession = undefined
      finishThinking(sessionId)
      emit()
    },
    appendThinking: (sessionId, delta) => {
      if (delta === '') return
      if (thinking === undefined || thinking.sessionId !== sessionId || !thinking.active) {
        thinking = { sessionId, text: delta.slice(-MAX_THINKING_CHARS), active: true }
      } else {
        thinking = { ...thinking, text: `${thinking.text}${delta}`.slice(-MAX_THINKING_CHARS) }
      }
      emit()
    },
    settleThinking: (sessionId, reasoning) => {
      if (thinking === undefined) {
        if (reasoning === undefined || reasoning === '') return
        thinking = { sessionId, text: reasoning.slice(-MAX_THINKING_CHARS), active: false }
      } else if (thinking.sessionId === sessionId) {
        const text = reasoning === undefined || reasoning === '' ? thinking.text : reasoning
        if (!thinking.active && text === thinking.text) return
        thinking = { sessionId, text: text.slice(-MAX_THINKING_CHARS), active: false }
      } else return
      emit()
    },
    clear: () => {
      latest = undefined
      interaction = undefined
      pendingSession = undefined
      thinking = undefined
      messages = []
      emit()
    },
  }
}
