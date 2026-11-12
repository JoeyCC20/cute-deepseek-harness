/**
 * Standalone Pixies settings window. Exactly one model is chosen — either a
 * built-in dropdown entry or a typed id after picking the custom option — and
 * owns its own API key: switching the selection shows that model's key, and
 * Apply commits the model and its key together.
 * @module @deepseek-ai/dsh-pixies/client/settings
 */

import {
  createElement, useEffect, useState,
  type ChangeEvent, type CSSProperties, type ReactElement,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  resolvePixiesMessages, type PixiesPanelMessages, type PixiesResolvedMessages,
} from './locale.ts'
import {
  isPixiesApiKeyValid, modelCredentialRef,
  type PixiesModelSettings, type PixiesModelState,
} from './models.ts'
import {
  readPanelSettings, resolvePixiesPanelBridge, type PixiesPanelSettingsView,
} from './panel-bridge.ts'

/** The shell style makes the document transparent; the settings window paints its own surface. */
const PAGE_STYLE = 'position:fixed;inset:0;width:100vw;height:100vh;overflow:auto;background:#f7f8fa;color:#1f2329;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;font-size:14px;line-height:1.5'

const PAGE: CSSProperties = { boxSizing: 'border-box', minHeight: '100%', padding: '28px 20px 40px' }
const CARD: CSSProperties = {
  maxWidth: 720, margin: '0 auto', padding: 24, background: '#fff',
  borderRadius: 12, boxShadow: '0 1px 3px rgba(16,24,40,.08)', boxSizing: 'border-box',
}
const TITLE: CSSProperties = { fontSize: 20, fontWeight: 600, marginBottom: 4 }
const SUBTITLE: CSSProperties = { fontSize: 12, color: '#667085', marginBottom: 24 }
const SECTION: CSSProperties = { fontSize: 13, fontWeight: 600, margin: '20px 0 8px' }
const CURRENT: CSSProperties = {
  padding: '10px 12px', background: '#f2f4f7', borderRadius: 8, marginBottom: 12,
}
const ROW: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }
const LABEL: CSSProperties = { width: 92, flexShrink: 0, fontSize: 13, color: '#475467' }
const INPUT: CSSProperties = {
  flex: 1, minWidth: 0, padding: '8px 10px', border: '1px solid #d0d5dd', borderRadius: 8,
  background: '#fff', color: '#1f2329', fontSize: 14, fontFamily: 'inherit',
}
const BUTTON: CSSProperties = {
  padding: '8px 16px', border: 'none', borderRadius: 8, background: '#2563eb',
  color: '#fff', fontSize: 14, cursor: 'pointer', flexShrink: 0,
}
const NOTE: CSSProperties = { fontSize: 12, color: '#667085', margin: '4px 0 0 100px' }
const ERROR: CSSProperties = { fontSize: 12, color: '#d92d20', margin: '4px 0 0 100px' }
const ACTIONS: CSSProperties = { ...ROW, margin: '20px 0 0 100px' }

/** Sentinel option that replaces the built-in list with a typed model id. */
const CUSTOM_MODEL_CHOICE = '__pixies_custom_model__'

interface SettingsPageProps {
  readonly copy: PixiesResolvedMessages
  readonly settings: PixiesModelSettings
}

/** Auto-hide presets, in milliseconds. */
const PANEL_HIDE_PRESETS: readonly number[] = [5000, 10_000, 30_000]

/** Preferences for the standalone result panel, owned by the Electron shell. */
function PixiesPanelSettingsSection(props: { readonly copy: PixiesResolvedMessages }): ReactElement {
  const [view, setView] = useState<PixiesPanelSettingsView>({ enabled: true, autoHideMs: 10_000 })
  useEffect(() => {
    const bridge = resolvePixiesPanelBridge()
    if (bridge === undefined) return undefined
    let active = true
    void bridge.getPanelSettings().then((value) => {
      const next = readPanelSettings(value)
      if (active && next !== undefined) setView(next)
    }).catch((_settingsUnavailable: unknown) => {
      // The main process owns defaults; an unavailable IPC leaves them in place.
    })
    const off = bridge.onPanelSettings((value) => {
      const next = readPanelSettings(value)
      if (next !== undefined) setView(next)
    })
    return () => { active = false; off() }
  }, [])

  const update = (next: PixiesPanelSettingsView): void => {
    setView(next)
    const bridge = resolvePixiesPanelBridge()
    if (bridge === undefined) return
    void bridge.setPanelSettings(next).catch((_settingsRejected: unknown) => {
      // A read-only settings file leaves the last validated snapshot in effect.
    })
  }
  const hideValue = view.autoHideMs === null ? 'never' : String(view.autoHideMs)
  const custom = view.autoHideMs !== null && !PANEL_HIDE_PRESETS.includes(view.autoHideMs)

  return createElement('div', null,
    createElement('div', { style: SECTION }, props.copy.panelSection),
    createElement('div', { style: ROW },
      createElement('label', {
        style: LABEL, htmlFor: 'pixies-panel-enabled',
      }, props.copy.panelEnable),
      createElement('input', {
        id: 'pixies-panel-enabled', type: 'checkbox',
        'data-testid': 'pixies-panel-enabled', checked: view.enabled,
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          update({ ...view, enabled: event.currentTarget.checked })
        },
      })),
    createElement('div', { style: ROW },
      createElement('label', {
        style: LABEL, htmlFor: 'pixies-panel-auto-hide',
      }, props.copy.panelAutoHide),
      createElement('select', {
        id: 'pixies-panel-auto-hide', style: INPUT,
        'data-testid': 'pixies-panel-auto-hide', value: hideValue,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          const value = event.currentTarget.value
          update({ ...view, autoHideMs: value === 'never' ? null : Number(value) })
        },
      },
      ...PANEL_HIDE_PRESETS.map(ms => createElement('option', {
        key: ms, value: String(ms),
      }, `${String(ms / 1000)}${props.copy.panelSeconds}`)),
      ...custom
        ? [createElement('option', { key: 'custom', value: hideValue },
          `${String(Number(hideValue) / 1000)}${props.copy.panelSeconds}`)]
        : [],
      createElement('option', { key: 'never', value: 'never' }, props.copy.panelHideNever))),
    createElement('div', { style: NOTE }, props.copy.panelHint),
  )
}

/** One exclusive model choice together with the API key owned by that model. */
export function PixiesSettingsPage(props: SettingsPageProps): ReactElement {
  const [state, setState] = useState<PixiesModelState>(props.settings.getSnapshot())
  const [providerDraft, setProviderDraft] = useState('')
  const [modelDraft, setModelDraft] = useState('')
  // Null means untouched: the field then shows a current model that is not in
  // the built-in catalog, so opening settings never silently changes it.
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyInvalid, setKeyInvalid] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)

  useEffect(() => {
    void props.settings.load()
    return props.settings.subscribe(() => { setState(props.settings.getSnapshot()) })
  }, [props.settings])

  const providers = state.providers.length > 0
    ? state.providers
    : state.groups.map(group => ({ id: group.id, name: group.name, registered: true }))
  const provider = providers.some(option => option.id === providerDraft)
    ? providerDraft
    : (state.current?.provider ?? providers[0]?.id ?? '')
  const selectedProvider = providers.find(option => option.id === provider)
  const models = state.groups.find(group => group.id === provider)?.models ?? []
  const current = state.current
  const currentForProvider = current !== null && current.provider === provider ? current : null
  const currentModel = currentForProvider?.model ?? ''
  const currentIsBuiltIn = currentForProvider !== null && models.some(model => model.id === currentModel)
  const modelChoice = modelDraft !== ''
    && (modelDraft === CUSTOM_MODEL_CHOICE || models.some(model => model.id === modelDraft))
    ? modelDraft
    : (currentForProvider !== null && !currentIsBuiltIn
      ? CUSTOM_MODEL_CHOICE
      : (currentIsBuiltIn ? currentModel : (models[0]?.id ?? CUSTOM_MODEL_CHOICE)))
  const customValue = customDraft ?? (currentForProvider !== null && !currentIsBuiltIn ? currentModel : '')
  const model = modelChoice === CUSTOM_MODEL_CHOICE ? customValue.trim() : modelChoice
  const busy = state.enabling !== null || state.status === 'selecting' || state.credential.saving
  const inspected = state.credential.ref === modelCredentialRef(provider, model)
  const keyStatus = !inspected
    ? props.copy.modelLoading
    : state.credential.configured ? props.copy.keyConfigured : props.copy.keyMissing
  const keyStateText = model === ''
    ? `${props.copy.keyModel}: ${provider} · ${props.copy.keyModelMissing}`
    : `${props.copy.keyModel}: ${provider} / ${model} · ${props.copy.keyRef}: ${keyStatus}`

  useEffect(() => {
    if (provider !== '' && model !== '') props.settings.inspectCredential(provider, model)
  }, [provider, model, props.settings])

  const applyModel = async (): Promise<void> => {
    if (provider === '' || model === '') return
    setProviderError(null)
    // Enabling writes the route's profile, so it must precede the key write
    // that adds the model's reference to that same profile.
    if (selectedProvider !== undefined && !selectedProvider.registered) {
      const failure = await props.settings.enableProvider(provider)
      if (failure !== null) { setProviderError(failure); return }
    }
    if (keyDraft.trim() !== '') {
      if (!isPixiesApiKeyValid(keyDraft)) { setKeyInvalid(true); return }
      setKeyInvalid(false)
      const saved = await props.settings.saveCredential(provider, model, keyDraft)
      if (!saved) return
      setKeyDraft('')
    } else {
      setKeyInvalid(false)
    }
    await props.settings.select({ provider, model })
  }

  return createElement('div', { style: PAGE },
    createElement('div', { 'data-testid': 'pixies-settings-page', style: CARD },
      createElement('div', { style: TITLE }, props.copy.settings),
      createElement('div', { style: SUBTITLE }, props.copy.settingsHint),
      createElement('div', { 'data-testid': 'pixies-model-current', style: CURRENT },
        `${props.copy.modelCurrent}: ${state.current === null
          ? props.copy.modelLoading
          : `${state.current.provider} / ${state.current.model}`}`),
      state.error !== null
        ? createElement('div', { 'data-testid': 'pixies-model-error', style: ERROR }, state.error)
        : null,

      createElement('div', { style: SECTION }, props.copy.modelProvider),
      createElement('div', { style: ROW },
        createElement('label', { style: LABEL, htmlFor: 'pixies-provider-select' }, props.copy.modelProvider),
        createElement('select', {
          id: 'pixies-provider-select',
          'data-testid': 'pixies-provider-select',
          value: provider,
          disabled: busy,
          style: INPUT,
          onChange: (event: ChangeEvent<HTMLSelectElement>) => {
            setProviderDraft(event.target.value)
            setModelDraft('')
            setCustomDraft(null)
            setKeyDraft('')
            setKeyInvalid(false)
          },
        }, ...providers.map(option => createElement('option', {
          key: option.id,
          value: option.id,
        }, option.registered ? option.name : `${option.name}${props.copy.providerUnregistered}`))),
      ),
      createElement('div', { style: NOTE }, props.copy.providerHint),

      createElement('div', { style: SECTION }, props.copy.modelSection),
      createElement('div', { style: ROW },
        createElement('label', { style: LABEL, htmlFor: 'pixies-model-select' }, props.copy.modelSelect),
        createElement('select', {
          id: 'pixies-model-select',
          'data-testid': 'pixies-model-select',
          value: modelChoice,
          disabled: busy,
          style: INPUT,
          onChange: (event: ChangeEvent<HTMLSelectElement>) => {
            setModelDraft(event.target.value)
            setKeyDraft('')
            setKeyInvalid(false)
          },
        },
        ...models.map(model => createElement('option', { key: model.id, value: model.id },
          `${model.name} · ${model.id}`)),
        createElement('option', {
          key: CUSTOM_MODEL_CHOICE,
          value: CUSTOM_MODEL_CHOICE,
        }, props.copy.modelCustom),
        ),
      ),
      modelChoice === CUSTOM_MODEL_CHOICE
        ? createElement('div', { style: ROW },
          createElement('label', { style: LABEL, htmlFor: 'pixies-custom-model' }, props.copy.modelId),
          createElement('input', {
            id: 'pixies-custom-model',
            'data-testid': 'pixies-custom-model',
            'aria-label': props.copy.modelId,
            placeholder: props.copy.modelIdPlaceholder,
            value: customValue,
            disabled: busy,
            style: INPUT,
            onChange: (event: ChangeEvent<HTMLInputElement>) => { setCustomDraft(event.target.value) },
          }),
        )
        : null,
      createElement('div', { style: NOTE }, props.copy.modelHint),
      providerError !== null
        ? createElement('div', { 'data-testid': 'pixies-provider-error', style: ERROR },
          `${props.copy.providerEnableFailed}: ${providerError}`)
        : null,

      createElement('div', { style: SECTION }, props.copy.keySection),
      createElement('div', { 'data-testid': 'pixies-key-state', style: CURRENT }, keyStateText),
      createElement('div', { style: ROW },
        createElement('label', { style: LABEL, htmlFor: 'pixies-key-input' }, props.copy.keyInput),
        createElement('input', {
          id: 'pixies-key-input',
          type: 'password',
          'data-testid': 'pixies-key-input',
          autoComplete: 'off',
          placeholder: props.copy.keyPlaceholder,
          value: keyDraft,
          disabled: busy || model === '',
          style: INPUT,
          onChange: (event: ChangeEvent<HTMLInputElement>) => {
            setKeyDraft(event.target.value)
            setKeyInvalid(false)
          },
        }),
      ),
      keyInvalid
        ? createElement('div', { 'data-testid': 'pixies-key-invalid', style: ERROR }, props.copy.keyInvalid)
        : null,
      state.credential.error !== null
        ? createElement('div', { 'data-testid': 'pixies-key-error', style: ERROR }, state.credential.error)
        : null,
      createElement('div', { style: NOTE }, props.copy.keyHint),

      createElement('div', { style: ACTIONS },
        createElement('button', {
          type: 'button',
          'data-testid': 'pixies-apply',
          disabled: busy || provider === '' || model === '',
          style: BUTTON,
          onClick: () => { void applyModel() },
        }, state.credential.saving
          ? props.copy.keySaving
          : state.enabling !== null ? props.copy.providerEnabling : props.copy.modelApply),
      ),
    ),
    createElement(PixiesPanelSettingsSection, { key: 'panel-settings', copy: props.copy }),
  )
}

/**
 * Mount the settings-only face into the overlay of the standalone window.
 * @param container - the `[data-pixies-shell]` overlay of this window.
 * @param modelSettings - the Host-backed model and credential store.
 * @param messages - optional locale overrides.
 * @returns a disposer that unmounts the React root.
 */
export function mountPixiesSettings(
  container: HTMLElement,
  modelSettings: PixiesModelSettings,
  messages: PixiesPanelMessages = {},
): () => void {
  container.style.cssText = PAGE_STYLE
  const root: Root = createRoot(container)
  root.render(createElement(PixiesSettingsPage, {
    copy: resolvePixiesMessages(messages),
    settings: modelSettings,
  }))
  return () => { root.unmount() }
}
