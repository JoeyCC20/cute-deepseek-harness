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
  /** Bubble text when the mic button is clicked without a shell bridge. */
  readonly speechUnavailable?: string
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
  /** Status line while a reply is being spoken. */
  readonly statusSpeaking?: string
  /** Mini avatar label while a voice-command shortcut round is live. */
  readonly voiceCommandListening?: string
  /** Speaker toggle label while voice replies are on. */
  readonly voiceOn?: string
  /** Speaker toggle label while voice replies are muted. */
  readonly voiceOff?: string
  /** Headline for a failed speech-synthesis round. */
  readonly voiceFailed?: string
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
  /** History drawer headline and collapsed entry label. */
  readonly history?: string
  /** Accessible label of the button that opens the history drawer. */
  readonly historyOpen?: string
  /** Accessible label of the button that closes the history drawer. */
  readonly historyClose?: string
  /** Label of the button that starts a fresh session. */
  readonly newSession?: string
  /** Compact label for the always-visible header action. */
  readonly newSessionShort?: string
  /** Label while a fresh session is being created. */
  readonly newSessionPending?: string
  /** Prefix for a failed session creation. */
  readonly newSessionFailed?: string
  /** Per-row remove action label. */
  readonly deleteSession?: string
  /** Confirmation copy explaining what removal does. */
  readonly deleteSessionConfirm?: string
  /** Confirm action label. */
  readonly deleteSessionAccept?: string
  /** Cancel action label. */
  readonly deleteSessionCancel?: string
  /** Label while removal is in flight. */
  readonly deleteSessionPending?: string
  /** Prefix for a failed removal. */
  readonly deleteSessionFailed?: string
  /** Right-click action that returns the floating icon to the tray. */
  readonly hideIcon?: string
  /** Section headline for the session list. */
  readonly sessions?: string
  /** Section headline for the current conversation's context. */
  readonly context?: string
  /** Unit suffix for the context message count. */
  readonly contextCount?: string
  /** Placeholder when the host catalog lists no session. */
  readonly noSessions?: string
  /** Session group for today before noon. */
  readonly groupMorning?: string
  /** Session group for today after noon. */
  readonly groupAfternoon?: string
  /** Session group for every earlier day. */
  readonly groupEarlier?: string
  /** Badge for a session that is still running. */
  readonly sessionRunning?: string
  /** Context preview label for a user entry. */
  readonly roleUser?: string
  /** Context preview label for an assistant entry. */
  readonly roleAssistant?: string
  /** Context preview label for a system entry. */
  readonly roleSystem?: string
  /** Collapsible thinking block headline. */
  readonly thinkingProcess?: string
  /** Accessible label of the button that expands the thinking block. */
  readonly showThinking?: string
  /** Accessible label of the button that collapses the thinking block. */
  readonly hideThinking?: string
  /** Badge while reasoning deltas are still arriving. */
  readonly thinkingStreaming?: string
  /** Badge once the reasoning stream has settled. */
  readonly thinkingDone?: string
  /** Settings drawer headline and collapsed entry label. */
  readonly settings?: string
  /** Accessible label of the button that opens settings. */
  readonly settingsOpen?: string
  /** Accessible label of the button that closes settings. */
  readonly settingsClose?: string
  /** Section headline for model settings. */
  readonly modelSection?: string
  /** Label for the effective model selection. */
  readonly modelCurrent?: string
  /** Label of the dropdown option that switches to a typed model id. */
  readonly modelCustom?: string
  /** Label for the provider selector. */
  readonly modelProvider?: string
  /** Label for the exclusive model dropdown. */
  readonly modelSelect?: string
  /** Label for the model id input. */
  readonly modelId?: string
  /** Placeholder for the model id input. */
  readonly modelIdPlaceholder?: string
  /** Label of the button that applies a selection. */
  readonly modelApply?: string
  /** Status while the catalog loads. */
  readonly modelLoading?: string
  /** Status while a selection is being installed. */
  readonly modelApplying?: string
  /** Headline for providers whose catalog lookup failed. */
  readonly modelFailures?: string
  /** Explains that the built-in entry and the typed id are exclusive. */
  readonly modelHint?: string
  /** Section headline for the selected model's own API key. */
  readonly keySection?: string
  /** Label naming the model a key belongs to. */
  readonly keyModel?: string
  /** Status when no model is selected yet, so no key belongs to anything. */
  readonly keyModelMissing?: string
  /** Status line prefix for the selected model's key. */
  readonly keyRef?: string
  /** Accessible label for the API key input. */
  readonly keyInput?: string
  /** Placeholder for the API key input. */
  readonly keyPlaceholder?: string
  /** Button label while a key is being stored. */
  readonly keySaving?: string
  /** Status when the model already has a key. */
  readonly keyConfigured?: string
  /** Status when the model has no key of its own. */
  readonly keyMissing?: string
  /** Note for a key that fails the input-format check. */
  readonly keyInvalid?: string
  /** Explains where the key is stored and when it takes effect. */
  readonly keyHint?: string
  /** Suffix for an installed provider route that is not enabled yet. */
  readonly providerUnregistered?: string
  /** Headline when enabling a provider route fails. */
  readonly providerEnableFailed?: string
  /** Button label while a provider route is being enabled. */
  readonly providerEnabling?: string
  /** Subtitle of the standalone settings window. */
  readonly settingsHint?: string
  /** Explains that the provider dropdown contains every installed route. */
  readonly providerHint?: string
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
  speechUnavailable: '语音输入需要桌面窗口，当前页面不可用',
  promptFailed: '发送失败',
  thinking: '思考中…',
  title: 'Pixies · 蜘蛛侠',
  subtitle: '你的桌面 AI 伙伴',
  statusIdle: '随时待命',
  statusThinking: '正在思考',
  statusListening: '正在聆听',
  statusSpeaking: '正在播报',
  voiceCommandListening: '正在接受语音指令',
  voiceOn: '语音回复已开启',
  voiceOff: '语音回复已关闭',
  voiceFailed: '语音播报失败',
  welcome: '嘿，我是 Pixies！',
  empty: '在下面直接输入，或点麦克风说话。拖动顶部可以把我放到屏幕任何地方。',
  placeholder: '给 Pixies 发消息…',
  send: '发送',
  sendHint: 'Enter 发送 · Shift+Enter 换行 · Esc 收起 · ⌘⇧J 语音指令 · ⌘⇧K 展开/收起',
  inputLabel: '消息输入框',
  history: '历史会话',
  historyOpen: '展开历史会话',
  historyClose: '收起历史会话',
  newSession: '新建会话',
  newSessionShort: '新建',
  newSessionPending: '创建中…',
  newSessionFailed: '新建会话失败',
  deleteSession: '删除会话',
  deleteSessionConfirm: '确定从历史中移除该会话？会话记录会保留，可在设置中恢复。',
  deleteSessionAccept: '删除',
  deleteSessionCancel: '取消',
  deleteSessionPending: '删除中…',
  deleteSessionFailed: '删除会话失败',
  hideIcon: '隐藏到通知栏',
  sessions: '会话',
  context: '本轮上下文',
  contextCount: '条消息',
  noSessions: '暂无历史会话',
  groupMorning: '今天上午',
  groupAfternoon: '今天下午',
  groupEarlier: '更早',
  sessionRunning: '进行中',
  roleUser: '你',
  roleAssistant: 'Pixies',
  roleSystem: '系统',
  thinkingProcess: '思考过程',
  showThinking: '展开思考过程',
  hideThinking: '收起思考过程',
  thinkingStreaming: '生成中',
  thinkingDone: '已完成',
  settings: '设置',
  settingsOpen: '打开设置',
  settingsClose: '关闭设置',
  modelSection: '模型',
  modelCurrent: '当前模型',
  modelCustom: '自定义模型…',
  modelProvider: '提供商',
  modelSelect: '选择模型',
  modelId: '模型 ID',
  modelIdPlaceholder: '输入模型 ID',
  modelApply: '应用',
  modelLoading: '加载中',
  modelApplying: '应用中',
  modelFailures: '部分模型加载失败',
  modelHint: '从下拉里选一个内置模型，或选「自定义模型…」填写模型 ID；两者互斥，只应用当前选中的那一个',
  keySection: '所选模型的 API Key',
  keyModel: '这个模型',
  keyModelMissing: '请先选择或填写模型 ID',
  keyRef: '密钥状态',
  keyInput: 'API Key',
  keyPlaceholder: '粘贴这个模型的 API Key（留空则不改动）',
  keySaving: '保存中',
  keyConfigured: '已配置',
  keyMissing: '未配置',
  keyInvalid: 'Key 格式不正确：请勿粘贴 NAME=value 或带引号的整行',
  keyHint: '每个模型各自保存一把 API Key：切换模型会显示它自己已保存的密钥，点「应用」后模型与它的密钥一起生效；没有单独保存密钥的模型沿用当前生效的密钥',
  providerUnregistered: '（未启用）',
  providerEnableFailed: '启用提供商失败',
  providerEnabling: '启用中',
  settingsHint: '选择模型并填写它自己的 API Key，改动会作用于当前会话',
  providerHint: '下拉包含所有已安装的内置方案；标注「未启用」的方案会在应用时自动启用',
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
