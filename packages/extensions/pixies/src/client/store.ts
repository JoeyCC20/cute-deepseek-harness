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
  let messages: readonly PixiesMessage[] = []
  let sequence = 0
  const listeners = new Set<PixiesListener>()
  const emit = (): void => {
    const state: PixiesClientState = { latest, interaction, pendingSession, messages }
    for (const listener of listeners) listener(state)
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
    getState: () => ({ latest, interaction, pendingSession, messages }),
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
      append({ role: 'assistant', text: presentation.text, mood: presentation.mood }, presentation.id)
      emit()
    },
    appendMessage: (draft) => {
      append(draft, `local-${String(sequence + 1)}`)
      emit()
    },
    setInteraction: (next) => { interaction = next; emit() },
    beginThinking: (sessionId) => {
      if (pendingSession === sessionId) return
      pendingSession = sessionId
      emit()
    },
    endThinking: (sessionId) => {
      // endThinking clears only when the caller's session owns the marker,
      // so a late turn/end from a previous session cannot erase the live one.
      if (pendingSession !== undefined && pendingSession !== sessionId) return
      if (pendingSession === undefined) return
      pendingSession = undefined
      emit()
    },
    clear: () => {
      latest = undefined
      interaction = undefined
      pendingSession = undefined
      messages = []
      emit()
    },
  }
}
