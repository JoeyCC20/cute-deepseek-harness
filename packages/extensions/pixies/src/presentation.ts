/**
 * Pure folds from session events to Pixies presentations. No I/O and no
 * clocks: the same event derives the same presentation on live streaming and
 * on recorded-session replay.
 * @module @deepseek-ai/dsh-pixies/presentation
 */

import type { PixiesPresentation } from './types.ts'

/** Structural view of a content block; the content map is merge-extensible, so unknown blocks fall through. */
interface TextBlockLike {
  readonly type?: unknown
  readonly text?: unknown
}

/** Structural view of an `assistant/message` event body, kept free of dsh-llm types for replay safety. */
export interface AssistantMessageBody {
  readonly turn: number
  readonly step: number
  readonly message: {
    /** Model-facing content blocks; the assistant message always carries this. */
    readonly content?: readonly unknown[]
  }
  /** Set when the turn was cancelled mid-stream; the delivered prefix is still speakable. */
  readonly interrupted?: true
}

/**
 * Extract the speakable text of an assistant message body: every `text` block
 * joined by newlines and trimmed. Empty when the message has no content or no
 * text block.
 * @param body - the `assistant/message` event body.
 * @returns the trimmed speech text, or `''` when nothing is speakable.
 */
export function assistantMessageText(body: AssistantMessageBody): string {
  const content = body.message.content
  if (content === undefined) return ''
  let text = ''
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as TextBlockLike
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') continue
    const trimmed = candidate.text.trim()
    if (trimmed === '') continue
    text = text === '' ? trimmed : `${text}\n${trimmed}`
  }
  return text
}

/**
 * Derive one speech presentation from an `assistant/message` event body, or
 * `null` when the message carries no speakable text. The identity is
 * deterministic (`<sessionId>#<seq>`), making replay output identical to live
 * output.
 * @param sessionId - the session that produced the message.
 * @param seq - the event's session sequence number.
 * @param body - the `assistant/message` event body.
 * @returns the presentation, or `null` when there is nothing to speak.
 */
export function presentationFromAssistantMessage(
  sessionId: string,
  seq: number,
  body: AssistantMessageBody,
): PixiesPresentation | null {
  const text = assistantMessageText(body)
  if (text === '') return null
  return {
    id: `${sessionId}#${String(seq)}`,
    sessionId,
    character: 'spider-man',
    kind: 'speech',
    mood: 'neutral',
    text,
    seq,
  }
}
