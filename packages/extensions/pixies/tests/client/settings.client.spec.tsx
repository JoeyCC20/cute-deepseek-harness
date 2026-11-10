/**
 * @vitest-environment jsdom
 *
 * Settings window tests: the API key belongs to the selected model rather than
 * being one global field, and Apply commits the model and its key together.
 */
import { act, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { defaultPixiesMessages } from '../../src/client/locale.ts'
import { modelCredentialRef, type PixiesModelSettings, type PixiesModelState } from '../../src/client/models.ts'
import { mountPixiesSettings } from '../../src/client/settings.tsx'

const state: PixiesModelState = {
  current: { provider: 'deepseek-official', model: 'deepseek-flash' },
  groups: [
    {
      id: 'deepseek-official', name: 'DeepSeek',
      models: [{ id: 'deepseek-flash', name: 'Flash' }, { id: 'deepseek-chat', name: 'Chat' }],
    },
    { id: 'minimax', name: 'MiniMax', models: [{ id: 'MiniMax-M2.7', name: 'M2.7' }] },
  ],
  failures: [],
  status: 'ready',
  error: null,
  credential: {
    ref: modelCredentialRef('deepseek-official', 'deepseek-flash'),
    configured: true, writable: true, saving: false, error: null,
  },
  providers: [
    { id: 'deepseek-official', name: 'DeepSeek', registered: true },
    { id: 'minimax', name: 'MiniMax', registered: false },
  ],
  enabling: null,
}

function harness(overrides: Partial<PixiesModelSettings> = {}) {
  const calls: string[] = []
  const settings: PixiesModelSettings = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    load: async () => { calls.push('load') },
    select: async (selection) => { calls.push(`select:${selection.provider}/${selection.model}`) },
    enableProvider: async (route) => { calls.push(`enable:${route}`); return null },
    saveCredential: async (provider, model, value) => {
      calls.push(`save:${provider}/${model}/${value}`)
      return true
    },
    inspectCredential: (provider, model) => { calls.push(`inspect:${provider}/${model}`) },
    refreshCredential: () => {},
    dispose: () => {},
    ...overrides,
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  let disposer: (() => void) | undefined
  act(() => { disposer = mountPixiesSettings(container, settings, defaultPixiesMessages) })
  const query = (testid: string): HTMLElement =>
    container.querySelector(`[data-testid="${testid}"]`) as HTMLElement
  return {
    calls,
    container,
    query,
    dispose: () => { act(() => { disposer?.() }); container.remove() },
  }
}

/** Value of the dropdown option that switches to a typed model id. */
function customChoice(h: ReturnType<typeof harness>): string {
  const select = h.query('pixies-model-select') as HTMLSelectElement
  const option = [...select.options].find(entry => entry.textContent === defaultPixiesMessages.modelCustom)
  if (option === undefined) throw new Error('custom model option is missing')
  return option.value
}

describe('PixiesSettingsPage', () => {
  it('shows the current model and inspects that model own key', () => {
    const h = harness()
    expect(h.query('pixies-settings-page')).not.toBeNull()
    expect(h.query('pixies-model-current').textContent).toContain('deepseek-official / deepseek-flash')
    expect(h.calls).toContain('load')
    expect(h.calls).toContain('inspect:deepseek-official/deepseek-flash')
    expect(h.query('pixies-key-state').textContent).toContain('deepseek-flash')
    expect(h.query('pixies-key-state').textContent).toContain(defaultPixiesMessages.keyConfigured)
    h.dispose()
  })

  it('inspects another model key when the provider dropdown changes', () => {
    const h = harness()
    fireEvent.change(h.query('pixies-provider-select'), { target: { value: 'minimax' } })
    expect(h.calls).toContain('inspect:minimax/MiniMax-M2.7')
    expect((h.query('pixies-key-input') as HTMLInputElement).value).toBe('')
    h.dispose()
  })

  it('asks for a model id before offering a key for a route with no built-in models', () => {
    const h = harness({
      getSnapshot: () => ({ ...state, groups: state.groups.filter(group => group.id === 'deepseek-official') }),
    })
    fireEvent.change(h.query('pixies-provider-select'), { target: { value: 'minimax' } })
    expect((h.query('pixies-model-select') as HTMLSelectElement).value).toBe(customChoice(h))
    expect(h.query('pixies-custom-model')).not.toBeNull()
    expect(h.query('pixies-key-state').textContent).toContain(defaultPixiesMessages.keyModelMissing)
    expect((h.query('pixies-key-input') as HTMLInputElement).disabled).toBe(true)
    expect((h.query('pixies-apply') as HTMLButtonElement).disabled).toBe(true)
    h.dispose()
  })

  it('applies a model and its key in one submission', async () => {
    const h = harness()
    fireEvent.change(h.query('pixies-key-input'), { target: { value: 'sk-live-key' } })
    await act(async () => { fireEvent.click(h.query('pixies-apply')) })
    expect(h.calls.filter(call => call.startsWith('save:') || call.startsWith('select:'))).toEqual([
      'save:deepseek-official/deepseek-flash/sk-live-key',
      'select:deepseek-official/deepseek-flash',
    ])
    expect((h.query('pixies-key-input') as HTMLInputElement).value).toBe('')
    h.dispose()
  })

  it('rejects a pasted environment line without selecting anything', async () => {
    const h = harness()
    fireEvent.change(h.query('pixies-key-input'), { target: { value: 'DEEPSEEK_API_KEY=sk-live' } })
    await act(async () => { fireEvent.click(h.query('pixies-apply')) })
    const invalid = h.query('pixies-key-invalid')
    expect(invalid).not.toBeNull()
    expect(invalid.textContent).toBe(defaultPixiesMessages.keyInvalid)
    expect(h.calls.some(call => call.startsWith('select:'))).toBe(false)
    h.dispose()
  })

  it('enables a dormant route before writing that model key', async () => {
    const h = harness()
    fireEvent.change(h.query('pixies-provider-select'), { target: { value: 'minimax' } })
    fireEvent.change(h.query('pixies-key-input'), { target: { value: 'sk-mini' } })
    await act(async () => { fireEvent.click(h.query('pixies-apply')) })
    expect(h.calls.filter(call => call.startsWith('enable:') || call.startsWith('save:') || call.startsWith('select:')))
      .toEqual([
        'enable:minimax',
        'save:minimax/MiniMax-M2.7/sk-mini',
        'select:minimax/MiniMax-M2.7',
      ])
    h.dispose()
  })

  it('uses a typed custom model id for both the key and the selection', async () => {
    const h = harness()
    fireEvent.change(h.query('pixies-model-select'), { target: { value: customChoice(h) } })
    fireEvent.change(h.query('pixies-custom-model'), { target: { value: 'my-model' } })
    expect(h.query('pixies-key-state').textContent).toContain('deepseek-official / my-model')
    fireEvent.change(h.query('pixies-key-input'), { target: { value: 'sk-custom' } })
    await act(async () => { fireEvent.click(h.query('pixies-apply')) })
    expect(h.calls).toContain('save:deepseek-official/my-model/sk-custom')
    expect(h.calls).toContain('select:deepseek-official/my-model')
    h.dispose()
  })

  it('treats a built-in model and a typed id as exclusive choices', async () => {
    const h = harness()
    expect(h.query('pixies-custom-model')).toBeNull()
    expect((h.query('pixies-model-select') as HTMLSelectElement).value).toBe('deepseek-flash')
    fireEvent.change(h.query('pixies-model-select'), { target: { value: customChoice(h) } })
    fireEvent.change(h.query('pixies-custom-model'), { target: { value: 'typed-model' } })
    expect(h.query('pixies-key-state').textContent).toContain('typed-model')
    fireEvent.change(h.query('pixies-model-select'), { target: { value: 'deepseek-chat' } })
    expect(h.query('pixies-custom-model')).toBeNull()
    expect(h.query('pixies-key-state').textContent).toContain('deepseek-chat')
    await act(async () => { fireEvent.click(h.query('pixies-apply')) })
    expect(h.calls.filter(call => call.startsWith('select:') || call.startsWith('save:')))
      .toEqual(['select:deepseek-official/deepseek-chat'])
    h.dispose()
  })

  it('keeps a current custom model visible instead of switching to a built-in', () => {
    const h = harness({
      getSnapshot: () => ({ ...state, current: { provider: 'deepseek-official', model: 'my-live-model' } }),
    })
    expect((h.query('pixies-model-select') as HTMLSelectElement).value).toBe(customChoice(h))
    expect((h.query('pixies-custom-model') as HTMLInputElement).value).toBe('my-live-model')
    expect(h.calls).toContain('inspect:deepseek-official/my-live-model')
    h.dispose()
  })

  it('unmounts the settings face on dispose', () => {
    const h = harness()
    expect(h.query('pixies-settings-page')).not.toBeNull()
    h.dispose()
    expect(h.container.firstChild).toBeNull()
  })
})
