/**
 * Pure preferences and auto-hide policy for the standalone Pixies result
 * panel. The Electron shell owns the file I/O and the timer; keeping the
 * decisions here lets the lifecycle be tested without a display.
 * @module @deepseek-ai/dsh-pixies-app/panel-settings
 */

/** Persisted preferences for the result panel. */
export interface PixiesPanelSettings {
  /** Master switch; `false` keeps the panel hidden for every call. */
  readonly enabled: boolean
  /** Milliseconds before auto-hide; `null` keeps the panel visible. */
  readonly autoHideMs: number | null
}

/** File name inside Electron's `userData` directory. */
export const PANEL_SETTINGS_FILE = 'pixies-panel.json'

/** Default: panel on, hidden ten seconds after a non-interactive result. */
export const DEFAULT_PANEL_SETTINGS: PixiesPanelSettings = Object.freeze({
  enabled: true,
  autoHideMs: 10_000,
})

/** Shortest time a non-interactive result stays on screen, whatever its size. */
export const MIN_PANEL_VISIBLE_MS = 10_000

/** Normal Chinese silent reading speed, in characters per minute. */
const READING_CHARS_PER_MINUTE = 400

/**
 * Estimate how long one result takes to read, never below the visible floor.
 * @param characters - visible, whitespace-free character count from the renderer.
 * @returns milliseconds of reading time.
 */
export function panelReadingMs(characters: number): number {
  if (!Number.isFinite(characters) || characters <= 0) return MIN_PANEL_VISIBLE_MS
  return Math.max(MIN_PANEL_VISIBLE_MS, Math.ceil(characters * 60_000 / READING_CHARS_PER_MINUTE))
}

/**
 * Parse one settings file or IPC payload. Unknown or hostile shapes fall back
 * field by field to the defaults, so a corrupt file never disables the panel.
 * @param value - decoded JSON or an IPC argument.
 * @returns the validated settings.
 */
export function parsePanelSettings(value: unknown): PixiesPanelSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_PANEL_SETTINGS
  const record = value as Record<string, unknown>
  const enabled = typeof record.enabled === 'boolean'
    ? record.enabled
    : DEFAULT_PANEL_SETTINGS.enabled
  const rawHide: unknown = record.autoHideMs
  let autoHideMs = DEFAULT_PANEL_SETTINGS.autoHideMs
  if (rawHide === null) autoHideMs = null
  else if (typeof rawHide === 'number' && Number.isFinite(rawHide) && rawHide >= 0) {
    autoHideMs = Math.floor(rawHide)
  }
  return { enabled, autoHideMs }
}

/**
 * Decide whether one panel should auto-hide and after how long. Choice panels
 * wait for a human answer and are exempt; disabling auto-hide (`null` or zero)
 * and disabling the panel itself also return no timer. The configured delay is
 * a user floor: longer results stay visible for their estimated reading time.
 * @param settings - current validated settings.
 * @param interactive - whether the payload contains a choice item.
 * @param characters - visible, whitespace-free character count of the result.
 * @returns the delay in milliseconds, or `null` for no auto-hide.
 */
export function panelHideDelay(
  settings: PixiesPanelSettings,
  interactive: boolean,
  characters = 0,
): number | null {
  if (!settings.enabled || interactive) return null
  if (settings.autoHideMs === null || settings.autoHideMs <= 0) return null
  return Math.max(panelReadingMs(characters), settings.autoHideMs)
}
