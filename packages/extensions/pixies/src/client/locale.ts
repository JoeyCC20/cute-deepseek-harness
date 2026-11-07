/**
 * Locale-owned interaction copy for the Pixies client. Presentation code never
 * owns product text: every label, placeholder, and status line arrives through
 * {@link PixiesPanelMessages} and is merged with this dictionary.
 * @module @deepseek-ai/dsh-pixies/client/locale
 */

import type { PixiesMood } from '../types.ts'

/** Localized interaction labels; the caller owns every string. */
export interface PixiesPanelMessages {
  /** Headline for a pending approval request. */
  readonly approval?: string
  /** Headline for a pending question request. */
  readonly question?: string
  /** Mini→expand click label (shell bridge present only). */
  readonly expand?: string
  /** Mic click label (shell bridge present only). */
  readonly mic?: string
  /** Mic active-state label. */
  readonly micActive?: string
  /** Collapse-to-mini click label. */
  readonly collapse?: string
  /** Bubble placeholder while listening with no partial text yet. */
  readonly listening?: string
  /** Bubble headline for a failed speech round (the reason is appended by the caller). */
  readonly speechFailed?: string
  /** Bubble headline for a failed send round (the reason is appended by the caller). */
  readonly promptFailed?: string
  /** Bubble text shown between a user prompt and the first assistant reply. */
  readonly thinking?: string
  /** Expanded panel title. */
  readonly title?: string
  /** Expanded panel subtitle. */
  readonly subtitle?: string
  /** Status line while idle. */
  readonly statusIdle?: string
  /** Status line while the agent is mid-turn. */
  readonly statusThinking?: string
  /** Status line while the microphone is live. */
  readonly statusListening?: string
  /** Welcome headline shown for an empty conversation. */
  readonly welcome?: string
  /** Welcome hint shown for an empty conversation. */
  readonly empty?: string
  /** Textarea placeholder. */
  readonly placeholder?: string
  /** Send button label. */
  readonly send?: string
  /** Keyboard hint under the composer. */
  readonly sendHint?: string
  /** Textarea accessible label. */
  readonly inputLabel?: string
}

/** Every field resolved to a concrete string. */
export type PixiesResolvedMessages = Required<PixiesPanelMessages>

/** The plugin's default (Simplified Chinese) interaction copy. */
export const defaultPixiesMessages: PixiesResolvedMessages = {
  approval: '需要你的确认',
  question: '有个问题想问你',
  expand: '展开对话',
  mic: '语音输入',
  micActive: '正在聆听',
  collapse: '收起',
  listening: '正在聆听…',
  speechFailed: '语音输入失败',
  promptFailed: '发送失败',
  thinking: '思考中…',
  title: 'Pixies · 蜘蛛侠',
  subtitle: '你的桌面 AI 伙伴',
  statusIdle: '随时待命',
  statusThinking: '正在思考',
  statusListening: '正在聆听',
  welcome: '嘿，我是 Pixies！',
  empty: '在下面直接输入，或点麦克风说话。拖动顶部可以把我放到屏幕任何地方。',
  placeholder: '给 Pixies 发消息…',
  send: '发送',
  sendHint: 'Enter 发送 · Shift+Enter 换行 · Esc 收起',
  inputLabel: '消息输入框',
}

/**
 * Merge a partial caller dictionary over the defaults. Undefined fields do not
 * erase a default, so callers can override one label at a time.
 * @param messages - caller-provided copy, possibly partial.
 * @returns a dictionary with every field defined.
 */
export function resolvePixiesMessages(messages: PixiesPanelMessages = {}): PixiesResolvedMessages {
  const resolved: Record<string, string> = { ...defaultPixiesMessages }
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'string') resolved[key] = value
  }
  return resolved as unknown as PixiesResolvedMessages
}

/** Mood keys the conversation view uses for its status chip and bubble. */
export type PixiesLiveMood = PixiesMood | 'error'
