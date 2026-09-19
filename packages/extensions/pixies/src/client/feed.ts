/**
 * Client-side session-event feed: folds `assistant/message` events into the
 * store using the same replay-stable derivation as the host half, so live and
 * replay output agree. Client-safe: consumes a structural event, no
 * `dsh-session` import.
 * @module @deepseek-ai/dsh-pixies/client/feed
 */

import { presentationFromAssistantMessage } from '../presentation.ts'
import type { PixiesStore } from './store.ts'

/** Minimal session-event shape the feed consumes. */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

/** The `assistant/message` event body, structurally narrowed. */
export interface AssistantMessageEventData {
  readonly turn: number
  readonly step: number
  readonly message: { readonly content?: readonly unknown[] }
}

/**
 * Feed one session event into the store: assistant/message becomes the
 * character's speech; everything else is ignored.
 * @param store - the Pixies store to publish into.
 * @param sessionId - the session that produced the event.
 * @param event - one session event from a follow stream or recorded replay.
 */
export function feedSessionEvent(store: PixiesStore, sessionId: string, event: SessionEventLike): void {
  if (event.type !== 'assistant/message') return
  const presentation = presentationFromAssistantMessage(sessionId, event.seq, event.data as AssistantMessageEventData)
  if (presentation !== null) store.speak(presentation)
}
