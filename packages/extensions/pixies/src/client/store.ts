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
  const listeners = new Set<PixiesListener>()
  const emit = (): void => {
    const state: PixiesClientState = { latest, interaction }
    for (const listener of listeners) listener(state)
  }
  return {
    getState: () => ({ latest, interaction }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    speak: (presentation) => { latest = presentation; emit() },
    setInteraction: (next) => { interaction = next; emit() },
    clear: () => { latest = undefined; interaction = undefined; emit() },
  }
}
