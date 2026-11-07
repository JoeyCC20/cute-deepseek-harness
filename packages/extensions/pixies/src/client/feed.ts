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
 * Read a failed turn's reason from the wire payload. A turn that ends with an
 * error (no API key, provider failure, transport error) produces no
 * assistant/message, so without this the conversation would just go blank.
 * @param event - a turn/end event.
 * @returns the failure message, or undefined for a normal/aborted turn.
 */
function turnFailure(event: SessionEventLike): string | undefined {
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const reason: unknown = Reflect.get(data, 'reason')
  if (typeof reason !== 'object' || reason === null || Reflect.get(reason, 'kind') !== 'error') return undefined
  const error: unknown = Reflect.get(reason, 'error')
  const message: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined
  return typeof message === 'string' && message !== '' ? message : undefined
}

/**
 * Feed one session event into the store: assistant/message becomes the
 * character's speech; turn/start begins a thinking round, turn/end (or a
 * follow-up assistant/message) ends it. Thinking is the gap between the user
 * sending a prompt and the LLM producing its first visible reply — without
 * an explicit signal the bubble looks frozen during a multi-second call.
 * @param store - the Pixies store to publish into.
 * @param sessionId - the session that produced the event.
 * @param event - one session event from a follow stream or recorded replay.
 */
export function feedSessionEvent(store: PixiesStore, sessionId: string, event: SessionEventLike): void {
  if (event.type === 'turn/start') {
    store.beginThinking(sessionId)
    return
  }
  if (event.type === 'turn/end') {
    store.endThinking(sessionId)
    const failure = turnFailure(event)
    if (failure !== undefined) store.appendMessage({ role: 'system', text: failure, mood: 'asking' })
    return
  }
  if (event.type !== 'assistant/message') return
  const presentation = presentationFromAssistantMessage(sessionId, event.seq, event.data as AssistantMessageEventData)
  if (presentation !== null) {
    store.speak(presentation)
    store.endThinking(sessionId)
  }
}
