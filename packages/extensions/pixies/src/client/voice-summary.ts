/**
 * The spoken-takeaway marker contract for Pixies replies. The model is told
 * (through the model-facing `show_result_panel` tool description) to wrap a
 * short, speakable summary in `[voice]...[/voice]` when a reply is long or
 * dense. The shell speaks only that text; the transcript and result panel keep
 * the full reply with the control markers removed.
 * @module @deepseek-ai/dsh-pixies/client/voice-summary
 */

/** Opening control marker for the spoken takeaway. */
export const VOICE_SUMMARY_OPEN = '[voice]'

/** Closing control marker for the spoken takeaway. */
export const VOICE_SUMMARY_CLOSE = '[/voice]'

/** One marked takeaway; the first well-formed pair wins. */
const MARKED = /\[voice\]([\s\S]*?)\[\/voice\]/u

/** A well-formed pair, replaced by its own text for on-screen display. */
const MARKED_GLOBAL = /\[voice\]([\s\S]*?)\[\/voice\]/gu

/** A stray marker half must never be read aloud as punctuation. */
const STRAY_MARKER = /\[\/?voice\]/gu

/**
 * Extract the takeaway the model marked for speech.
 * @param text - the full assistant reply.
 * @returns the trimmed takeaway, or undefined when there is no usable marker.
 */
export function voiceSummary(text: string): string | undefined {
  const marked = MARKED.exec(text)?.[1]
  if (marked === undefined) return undefined
  const summary = marked.trim()
  return summary === '' ? undefined : summary
}

/**
 * Choose what the speech helper reads aloud.
 * @param text - the full assistant reply.
 * @returns the marked takeaway, or the whole reply when none is marked.
 */
export function spokenReplyText(text: string): string {
  return voiceSummary(text) ?? text.replace(STRAY_MARKER, ' ').trim()
}

/**
 * Show the whole reply without its control markers. Unpaired markers are left
 * alone so a malformed reply stays visible instead of silently losing text.
 * @param text - the full assistant reply.
 * @returns readable text with the marker pairs removed.
 */
export function visibleReplyText(text: string): string {
  return text
    .replace(MARKED_GLOBAL, '$1')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}
