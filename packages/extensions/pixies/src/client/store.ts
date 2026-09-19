/**
 * Client-side reactive store for the Pixies character: the latest speech
 * presentation and the pending interaction the character should react to.
 * Pure and framework-free so it is unit-testable on node.
 * @module @deepseek-ai/dsh-pixies/client/store
 */

import type { PixiesInteraction, PixiesPresentation } from '../types.ts'

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
}

/** State-change listener. */
export type PixiesListener = (state: PixiesClientState) => void

/** The store surface consumed by the character panel and the client entry. */
export interface PixiesStore {
  readonly getState: () => PixiesClientState
  readonly subscribe: (listener: PixiesListener) => () => void
  /** Publish one speech presentation. */
  readonly speak: (presentation: PixiesPresentation) => void
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
 * @returns a store with no presentation and no pending interaction.
 */
export function createPixiesStore(): PixiesStore {
  let latest: PixiesPresentation | undefined
  let interaction: PixiesInteraction | undefined
  let pendingSession: string | undefined
  const listeners = new Set<PixiesListener>()
  const emit = (): void => {
    const state: PixiesClientState = { latest, interaction, pendingSession }
    for (const listener of listeners) listener(state)
  }
  return {
    getState: () => ({ latest, interaction, pendingSession }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    speak: (presentation) => { latest = presentation; emit() },
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
    clear: () => { latest = undefined; interaction = undefined; pendingSession = undefined; emit() },
  }
}
