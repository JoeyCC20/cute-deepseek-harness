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

/** Structural view of a stream chunk or a durable reasoning content block. */
interface TextBlockLike {
  readonly type?: unknown
  readonly text?: unknown
}

/**
 * Read one live reasoning increment. The chunk is a wire payload, so its
 * fields are narrowed structurally rather than trusted as a typed boundary.
 * @param data - an `assistant/live-chunk` event body.
 * @returns the delta text, or undefined for any other chunk kind.
 */
function reasoningDelta(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const chunk: unknown = Reflect.get(data, 'chunk')
  if (typeof chunk !== 'object' || chunk === null) return undefined
  const candidate = chunk as TextBlockLike
  if (candidate.type !== 'reasoning-delta' || typeof candidate.text !== 'string') return undefined
  return candidate.text === '' ? undefined : candidate.text
}

/**
 * Whether a wire payload carries the message body the speech fold requires.
 * The feed sits on a wire boundary, so a truncated payload is skipped rather
 * than letting the projection read `message.content` off a missing object.
 * @param data - an `assistant/message` event body.
 * @returns true when `message` is an object.
 */
function isAssistantMessageBody(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const message: unknown = Reflect.get(data, 'message')
  return typeof message === 'object' && message !== null
}

/**
 * Read the settled reasoning of an assistant message. Recorded-session replay
 * has no client-only live chunks, so the durable content is the only source.
 * @param content - the model-facing content blocks of the message.
 * @returns the joined reasoning text, or undefined when the turn had none.
 */
function reasoningText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content as readonly unknown[]) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as TextBlockLike
    if (candidate.type !== 'reasoning' || typeof candidate.text !== 'string') continue
    const trimmed = candidate.text.trim()
    if (trimmed === '') continue
    text = text === '' ? trimmed : `${text}\n${trimmed}`
  }
  return text === '' ? undefined : text
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
 * Read a human-authored prompt from a `user/message` wire payload. Plugin
 * sources (checkpoints, compaction summaries) are not conversation entries.
 * @param event - one user/message event.
 * @returns the prompt text, or undefined for a non-human or empty payload.
 */
function userText(event: SessionEventLike): string | undefined {
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const source: unknown = Reflect.get(data, 'source')
  if (typeof source !== 'object' || source === null || Reflect.get(source, 'kind') !== 'user') return undefined
  const content: unknown = Reflect.get(data, 'content')
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content as readonly unknown[]) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as TextBlockLike
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') continue
    text = text === '' ? candidate.text : `${text}\n${candidate.text}`
  }
  return text.trim() === '' ? undefined : text
}

/** Structural view of a tool-call content block or a tool/call event body. */
interface ToolCallLike {
  readonly name?: unknown
  readonly arguments?: unknown
}

/**
 * Render one tool call for the process view. Arguments are a wire payload: only
 * the string form is meaningful, and the name alone still identifies a call
 * whose arguments were dropped.
 * @param data - a tool-call content block or a tool/call event body.
 * @returns `name(arguments)`, the bare name, or undefined when unidentifiable.
 */
function toolCallText(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const candidate = data as ToolCallLike
  if (typeof candidate.name !== 'string' || candidate.name === '') return undefined
  const args = typeof candidate.arguments === 'string' ? candidate.arguments : ''
  return args === '' ? candidate.name : `${candidate.name}(${args})`
}

/**
 * Read every tool call embedded in an assistant message's content blocks.
 * @param content - the message's model-facing content blocks.
 * @returns the rendered calls in block order.
 */
function contentToolCalls(content: readonly unknown[]): readonly string[] {
  const calls: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (Reflect.get(block, 'type') !== 'tool-call') continue
    const text = toolCallText(block)
    if (text !== undefined) calls.push(text)
  }
  return calls
}

/**
 * Read the returned text of every tool-result block in a tool/result event.
 * @param event - one tool/result event.
 * @returns the returned texts in block order.
 */
function toolResultTexts(event: SessionEventLike): readonly string[] {
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null) return []
  const message: unknown = Reflect.get(data, 'message')
  if (typeof message !== 'object' || message === null) return []
  const content: unknown = Reflect.get(message, 'content')
  if (!Array.isArray(content)) return []
  const results: string[] = []
  for (const block of content as readonly unknown[]) {
    if (typeof block !== 'object' || block === null || Reflect.get(block, 'type') !== 'tool-result') continue
    const parts: unknown = Reflect.get(block, 'content')
    if (!Array.isArray(parts)) continue
    let text = ''
    for (const part of parts as readonly unknown[]) {
      if (typeof part !== 'object' || part === null || Reflect.get(part, 'type') !== 'text') continue
      const value: unknown = Reflect.get(part, 'text')
      if (typeof value !== 'string' || value === '') continue
      text = text === '' ? value : `${text}\n${value}`
    }
    if (text !== '') results.push(text)
  }
  return results
}

/**
 * Feed one session event into the store: assistant/message becomes the
 * character's speech; assistant/live-chunk reasoning deltas stream into the
 * collapsible thinking block; each settled reasoning, tool call, and tool
 * result is written to the transcript as its own row at the moment it happens,
 * so the conversation keeps the execution order even for turns with no reply;
 * turn/start begins a thinking round, turn/end (or a follow-up
 * assistant/message) ends it. Thinking is the gap between the user sending a
 * prompt and the LLM producing its first visible reply — without an explicit
 * signal the bubble looks frozen during a multi-second call.
 * Live prompts are already appended locally, so `user/message` is folded only
 * when replaying a session's history.
 * @param store - the Pixies store to publish into.
 * @param sessionId - the session that produced the event.
 * @param event - one session event from a follow stream or recorded replay.
 * @param includeUser - fold human user/message events; true only for replay.
 */
export function feedSessionEvent(
  store: PixiesStore,
  sessionId: string,
  event: SessionEventLike,
  includeUser = false,
): void {
  if (event.type === 'user/message') {
    if (!includeUser) return
    const text = userText(event)
    if (text !== undefined) store.appendMessage({ role: 'user', text })
    return
  }
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
  if (event.type === 'tool/call') {
    const text = toolCallText(event.data)
    if (text !== undefined) store.appendProcess(sessionId, { kind: 'tool-call', text })
    return
  }
  if (event.type === 'tool/result') {
    for (const text of toolResultTexts(event)) {
      store.appendProcess(sessionId, { kind: 'tool-result', text })
    }
    return
  }
  if (event.type === 'assistant/live-chunk') {
    const delta = reasoningDelta(event.data)
    if (delta !== undefined) store.appendThinking(sessionId, delta)
    return
  }
  if (event.type !== 'assistant/message') return
  if (!isAssistantMessageBody(event.data)) return
  const body = event.data as AssistantMessageEventData
  const rawContent: unknown = body.message.content
  store.settleThinking(sessionId, reasoningText(rawContent))
  const content = Array.isArray(rawContent) ? rawContent as readonly unknown[] : []
  for (const text of contentToolCalls(content)) {
    store.appendProcess(sessionId, { kind: 'tool-call', text })
  }
  const presentation = presentationFromAssistantMessage(sessionId, event.seq, {
    turn: body.turn,
    step: body.step,
    message: { content },
  })
  if (presentation !== null) {
    store.speak(presentation)
    store.endThinking(sessionId)
  }
}
