/**
 * Wire-safe Pixies presentation payloads, free of cordis/service imports so
 * the future browser half and the Electron shell can consume them without
 * loading this package's Context augmentation.
 * @module @deepseek-ai/dsh-pixies/types
 */

/** Built-in character identities; the set is open for future characters. */
export type PixiesCharacterId = 'spider-man'

/**
 * The character's momentary mood, driving the cartoon's expression.
 * Extensible: consumers fall through unknown moods to a neutral render.
 */
export type PixiesMood = 'neutral' | 'happy' | 'thinking' | 'asking'

/** What a presentation is for: spoken output or an interactive request. */
export type PixiesPresentationKind = 'speech' | 'interaction'

/**
 * One presentation destined for the character's speech bubble. `id` is
 * deterministic and replay-stable (`<sessionId>#<seq>`), so live streaming
 * and recorded-session replay derive identical identities.
 */
export interface PixiesPresentation {
  /** Deterministic identity derived from the source session and sequence. */
  readonly id: string
  /** The session whose agent produced this presentation. */
  readonly sessionId: string
  /** The character that should speak it. */
  readonly character: PixiesCharacterId
  /** Whether this is spoken output or an interactive request. */
  readonly kind: PixiesPresentationKind
  /** The expression the character should wear. */
  readonly mood: PixiesMood
  /** The speech-bubble text. */
  readonly text: string
  /** Source session sequence number (monotonic within the session). */
  readonly seq: number
}

/** A host-side approval or question that entered the answerer waterfall. */
export interface PixiesInteraction {
  /** Which waterfall produced the interaction. */
  readonly kind: 'approval' | 'question'
  /** The session the interaction belongs to. */
  readonly sessionId: string
  /** One-line summary the character can relay ("批准 echo"?). */
  readonly summary: string
}
