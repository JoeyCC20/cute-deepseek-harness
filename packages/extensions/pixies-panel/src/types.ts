/**
 * Wire-safe result-panel payload and its single structural parser.
 *
 * Host and client both consume `tool/call` arguments at a wire boundary, so
 * they share one authoritative derivation instead of two drifting decoders.
 * @module @deepseek-ai/dsh-pixies-panel/types
 */

/** Payload version baked into every durable `tool/result.meta` projection. */
export const PIXIES_PANEL_VERSION = 1 as const

/** Discriminant of the four v1 panel item shapes. */
export type PixiesPanelItemKind = 'image' | 'text' | 'choice' | 'link'

/** One selectable answer offered by a choice item. */
export interface PixiesPanelChoiceOption {
  readonly label: string
  readonly description?: string
}

/** One normalized item shown in the result panel. */
export type PixiesPanelItem =
  | { readonly kind: 'image'; readonly source: string; readonly alt?: string }
  | { readonly kind: 'text'; readonly content: string; readonly format: 'plain' | 'markdown' }
  | {
    readonly kind: 'choice'
    readonly question: string
    readonly options: readonly PixiesPanelChoiceOption[]
    readonly multiSelect: boolean
  }
  | { readonly kind: 'link'; readonly label: string; readonly url: string }

/** Complete, bounded panel payload derived from `show_result_panel` arguments. */
export interface PixiesPanelPayload {
  readonly version: typeof PIXIES_PANEL_VERSION
  readonly title?: string
  readonly items: readonly PixiesPanelItem[]
  /** Choice items wait for a human answer, so they are exempt from auto-hide. */
  readonly interactive: boolean
}

/** Answer to one choice item, keyed by its stable item id. */
export interface PixiesPanelAnswer {
  readonly id: string
  readonly selected: string[]
  readonly custom?: string
}

/**
 * Exhaustiveness guard for the closed item-kind union.
 * @param value - the value that must be impossible after a complete switch.
 * @returns never; always throws.
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled pixies panel item kind: ${JSON.stringify(value)}`)
}

/**
 * Stable id of the choice item at `index`, echoed in its answer.
 * @param index - zero-based position in the panel's item list.
 * @returns the stable id of that choice question.
 */
export function panelChoiceId(index: number): string {
  return `item-${index}`
}

/**
 * `AskUserQuestionItem.header` value marking a panel-owned question. The
 * answerer claims only requests whose every question carries this header and
 * delegates every other question chain with `next()`.
 */
export const PIXIES_PANEL_HEADER = 'Pixies Result Panel'

/**
 * Id of the display-only question a panel without choice items sends. The
 * answerer acknowledges it with no answers, so a pure presentation never
 * waits for a human decision.
 */
export const PIXIES_PANEL_DISPLAY_ID = 'panel-display'

/**
 * Encode the panel payload into the question detail. This is the sole wire
 * contract between the tool body (Host) and the panel answerer (Client), so
 * the panel never needs a new session event or a second event subscription.
 * @param payload - normalized panel payload.
 * @returns a lossless JSON string for `AskUserQuestionItem.detail`.
 */
export function encodePanelDetail(payload: PixiesPanelPayload): string {
  return JSON.stringify(payload)
}

function parseWireItem(value: unknown, index: number): PixiesPanelItem {
  const path = `items[${index}]`
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  const kind = value.kind
  if (kind === 'image') {
    const source = panelImageSource(value.source, `${path}.source`)
    const alt = value.alt
    if (alt !== undefined && typeof alt !== 'string') throw new Error(`${path}.alt must be a string`)
    return { kind, source, ...alt !== undefined ? { alt } : {} }
  }
  if (kind === 'text') {
    const content = nonEmptyString(value.content, `${path}.content`)
    const format = value.format ?? 'plain'
    if (format !== 'plain' && format !== 'markdown') throw new Error(`${path}.format must be plain or markdown`)
    return { kind, content, format }
  }
  if (kind === 'choice') {
    const question = nonEmptyString(value.question, `${path}.question`)
    if (!Array.isArray(value.options) || value.options.length === 0) throw new Error(`${path}.options must be a non-empty array`)
    const options = value.options.map((option, optionIndex) => parseOption(option, `${path}.options[${optionIndex}]`))
    const multiSelect = value.multiSelect ?? false
    if (typeof multiSelect !== 'boolean') throw new Error(`${path}.multiSelect must be a boolean`)
    return { kind, question, options, multiSelect }
  }
  if (kind === 'link') {
    const label = nonEmptyString(value.label, `${path}.label`)
    const url = panelLinkUrl(value.url, `${path}.url`)
    return { kind, label, url }
  }
  throw new Error(`${path}.kind must be image, text, choice, or link`)
}

/**
 * Validate an already-normalized payload crossing the Host→Client wire.
 * @param value - decoded JSON from a question detail.
 * @returns the validated payload.
 */
export function parsePanelPayloadWire(value: unknown): PixiesPanelPayload {
  if (!isRecord(value)) throw new Error('panel payload must be an object')
  if (value.version !== PIXIES_PANEL_VERSION) throw new Error('unsupported panel payload version')
  const title = value.title
  if (title !== undefined && typeof title !== 'string') throw new Error('title must be a string')
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_PANEL_ITEMS) {
    throw new Error('items must be a non-empty bounded array')
  }
  const items = value.items.map((item, index) => parseWireItem(item, index))
  if (typeof value.interactive !== 'boolean') throw new Error('interactive must be a boolean')
  return {
    version: PIXIES_PANEL_VERSION,
    ...title !== undefined ? { title } : {},
    items,
    interactive: value.interactive,
  }
}

/**
 * Decode a panel-owned question request.
 * @param request - structurally narrowed waterfall payload.
 * @returns the payload, or undefined when the chain belongs to another UI.
 */
export function decodePanelDetail(request: unknown): PixiesPanelPayload | undefined {
  if (typeof request !== 'object' || request === null) return undefined
  const questions: unknown = Reflect.get(request, 'questions')
  if (!Array.isArray(questions) || questions.length === 0) return undefined
  const first: unknown = questions[0]
  if (typeof first !== 'object' || first === null) return undefined
  if (Reflect.get(first, 'header') !== PIXIES_PANEL_HEADER) return undefined
  const detail: unknown = Reflect.get(first, 'detail')
  if (typeof detail !== 'string') return undefined
  try {
    return parsePanelPayloadWire(JSON.parse(detail) as unknown)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value
}

/**
 * Parse an http(s) URL. Other schemes and non-URLs both report `undefined`;
 * the caller decides whether a local path is acceptable in their place.
 * @param value - candidate string.
 * @returns the parsed URL, or undefined when it is not an http(s) URL.
 */
function httpUrl(value: string): URL | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch (_notAnAbsoluteUrl) {
    // A relative path, local path, or malformed URL is not an http(s) URL.
    return undefined
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
}

/**
 * Validate an image source: an http(s) URL or a local path with no NUL byte.
 * Other schemes (`file:`, `javascript:`, …) are refused at the wire boundary.
 * @param value - candidate source.
 * @param path - error path for diagnostics.
 * @returns the accepted source.
 */
export function panelImageSource(value: unknown, path: string): string {
  const source = nonEmptyString(value, path)
  if (source.includes('\0')) throw new Error(`${path} contains a NUL byte`)
  const candidate = httpUrl(source)
  if (candidate === undefined && /^[a-z][a-z0-9+.-]*:/i.test(source)) {
    throw new Error(`${path} must be an http(s) URL or a local path`)
  }
  return source
}

/**
 * Validate a clickable link target. Only http(s) URLs may open the browser.
 * @param value - candidate URL.
 * @param path - error path for diagnostics.
 * @returns the accepted URL string.
 */
export function panelLinkUrl(value: unknown, path: string): string {
  const raw = nonEmptyString(value, path)
  const url = httpUrl(raw)
  if (url === undefined) throw new Error(`${path} must be an absolute http(s) URL`)
  return url.href
}

function parseOption(value: unknown, path: string): PixiesPanelChoiceOption {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  const label = nonEmptyString(value.label, `${path}.label`)
  const description = value.description
  if (description !== undefined && typeof description !== 'string') {
    throw new Error(`${path}.description must be a string`)
  }
  return { label, ...description !== undefined ? { description } : {} }
}

function parseItem(value: unknown, index: number): PixiesPanelItem {
  const path = `items[${index}]`
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  const kind = value.kind
  if (kind === 'image') {
    const source = panelImageSource(value.source, `${path}.source`)
    const alt = value.alt
    if (alt !== undefined && typeof alt !== 'string') throw new Error(`${path}.alt must be a string`)
    return { kind, source, ...alt !== undefined ? { alt } : {} }
  }
  if (kind === 'text') {
    const content = nonEmptyString(value.content, `${path}.content`)
    const format = value.format ?? 'plain'
    if (format !== 'plain' && format !== 'markdown') {
      throw new Error(`${path}.format must be plain or markdown`)
    }
    return { kind, content, format }
  }
  if (kind === 'choice') {
    const question = nonEmptyString(value.question, `${path}.question`)
    if (!Array.isArray(value.options) || value.options.length === 0) {
      throw new Error(`${path}.options must be a non-empty array`)
    }
    const options = value.options.map((option, optionIndex) => parseOption(option, `${path}.options[${optionIndex}]`))
    const multiSelect = value.multi_select ?? false
    if (typeof multiSelect !== 'boolean') throw new Error(`${path}.multi_select must be a boolean`)
    return { kind, question, options, multiSelect }
  }
  if (kind === 'link') {
    const label = nonEmptyString(value.label, `${path}.label`)
    const url = panelLinkUrl(value.url, `${path}.url`)
    return { kind, label, url }
  }
  throw new Error(`${path}.kind must be image, text, choice, or link`)
}

/** Maximum number of items one panel call may carry, bounded for the log. */
export const MAX_PANEL_ITEMS = 12

/**
 * Parse and normalize raw `show_result_panel` arguments into a bounded payload.
 * Pure: no clock, randomness, session state, or I/O. Throws on malformed wire
 * data so both the tool body and the renderer fail the same way.
 * @param args - raw model arguments (already JSON-shaped).
 * @returns the normalized payload.
 */
export function parsePanelPayload(args: unknown): PixiesPanelPayload {
  if (!isRecord(args)) throw new Error('show_result_panel arguments must be an object')
  const title = args.title
  if (title !== undefined && typeof title !== 'string') throw new Error('title must be a string')
  if (!Array.isArray(args.items) || args.items.length === 0) {
    throw new Error('items must be a non-empty array')
  }
  if (args.items.length > MAX_PANEL_ITEMS) throw new Error(`items accepts at most ${MAX_PANEL_ITEMS} entries`)
  const items = args.items.map((item, index) => parseItem(item, index))
  return {
    version: PIXIES_PANEL_VERSION,
    ...title !== undefined ? { title } : {},
    items,
    interactive: items.some(item => item.kind === 'choice'),
  }
}

/** Build the exact JSON projection; its inferred shape is the wire contract. */
function projectPanelMeta(payload: PixiesPanelPayload, answers: readonly PixiesPanelAnswer[]) {
  return {
    pixiesPanel: {
      version: payload.version,
      ...payload.title !== undefined ? { title: payload.title } : {},
      items: payload.items.map(item => ({ ...item })),
      interactive: payload.interactive,
      answers: answers.map(answer => ({
        id: answer.id,
        selected: [...answer.selected],
        ...answer.custom !== undefined ? { custom: answer.custom } : {},
      })),
    },
  }
}

/**
 * Pure projection of the durable `tool/result.meta` fact. Web cards and any
 * replay consumer read this shape instead of re-decoding the call arguments.
 * @param payload - normalized panel payload.
 * @param answers - answers collected from choice items.
 * @returns a lossless JSON value for `tool/result.meta`.
 */
export function panelResultMeta(
  payload: PixiesPanelPayload,
  answers: readonly PixiesPanelAnswer[],
): ReturnType<typeof projectPanelMeta> {
  return projectPanelMeta(payload, answers)
}
