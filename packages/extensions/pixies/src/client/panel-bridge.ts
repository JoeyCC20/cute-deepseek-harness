/**
 * Renderer-side face of the Pixies result-panel Electron bridge. The main
 * process owns the settings defaults and the timer; this module only narrows
 * wire payloads and keeps local images on the authenticated Host file route.
 * @module @deepseek-ai/dsh-pixies/client/panel-bridge
 */
import { extractMarkdownPlainText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PixiesPanelPayload } from '@deepseek-ai/dsh-pixies-panel/types'
import { visibleReplyText } from './voice-summary.ts'

/** Settings snapshot as returned by the main process. */
export interface PixiesPanelSettingsView {
  /** Master switch; `false` keeps the panel hidden. */
  readonly enabled: boolean
  /** Auto-hide delay, or `null` when the panel stays visible. */
  readonly autoHideMs: number | null
}

/** Structural face of `window.dshPixies` methods the panel needs. */
export interface PixiesPanelBridge {
  /** Wake the panel window for one result and its visible reading length. */
  readonly showResultPanel: (interactive: boolean, characters: number) => void
  /** Resize the window to the measured content height. */
  readonly setPanelHeight: (height: number) => void
  /** Hide the window without destroying its renderer. */
  readonly hideResultPanel: () => void
  /** Read the persisted preferences. */
  readonly getPanelSettings: () => Promise<unknown>
  /** Persist preferences and receive the validated snapshot. */
  readonly setPanelSettings: (value: unknown) => Promise<unknown>
  /** Open an http(s) URL in the default browser. */
  readonly openExternal: (url: string) => Promise<unknown>
  /** Observe preference changes made in another window. */
  readonly onPanelSettings: (listener: (settings: unknown) => void) => () => void
}

/**
 * Narrow one IPC settings payload. The main process owns defaults, so an
 * unexpected shape yields `undefined` rather than a guessed value.
 * @param value - IPC result.
 * @returns the snapshot, or undefined when the shape is not a settings object.
 */
export function readPanelSettings(value: unknown): PixiesPanelSettingsView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.enabled !== 'boolean') return undefined
  const hide: unknown = record.autoHideMs
  if (hide !== null && (typeof hide !== 'number' || !Number.isFinite(hide))) return undefined
  return { enabled: record.enabled, autoHideMs: typeof hide === 'number' ? hide : null }
}

/**
 * Resolve an image source for an `<img>` tag. Remote http(s) URLs load
 * directly; local paths go through the Host's authenticated `/api/file` route,
 * so the renderer never needs a `file:` URL or filesystem access.
 * @param source - validated panel image source.
 * @returns the URL to load.
 */
export function panelImageUrl(source: string): string {
  if (/^https?:\/\//i.test(source)) return source
  return `/api/file?path=${encodeURIComponent(source)}`
}

/**
 * Count the visible characters of one result so the shell can keep it on
 * screen long enough to read. Markdown markup is projected away first.
 * @param payload - claimed result-panel payload.
 * @returns the number of non-whitespace visible characters.
 */
export function panelVisibleCharacters(payload: PixiesPanelPayload): number {
  const count = (text: string): number => text.replace(/\s+/g, '').length
  let characters = 0
  for (const item of payload.items) {
    switch (item.kind) {
      case 'text':
        characters += count(item.format === 'markdown'
          ? extractMarkdownPlainText(visibleReplyText(item.content))
          : visibleReplyText(item.content))
        break
      case 'choice':
        characters += count(item.question)
        for (const option of item.options) characters += count(option.label)
        break
      case 'link':
        characters += count(item.label)
        break
      case 'image':
        characters += count(item.alt ?? '')
        break
    }
  }
  return characters
}

/**
 * Read the panel bridge from the global scope when every method is present.
 * @returns the bridge, or undefined outside the Pixies Electron shell.
 */
export function resolvePixiesPanelBridge(): PixiesPanelBridge | undefined {
  const candidate: unknown = (globalThis as Record<string, unknown>).dshPixies
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const bridge = candidate as Record<string, unknown>
  if (typeof bridge.showResultPanel !== 'function'
    || typeof bridge.setPanelHeight !== 'function'
    || typeof bridge.hideResultPanel !== 'function'
    || typeof bridge.getPanelSettings !== 'function'
    || typeof bridge.setPanelSettings !== 'function'
    || typeof bridge.openExternal !== 'function'
    || typeof bridge.onPanelSettings !== 'function') return undefined
  return candidate as PixiesPanelBridge
}
