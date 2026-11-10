/** Model settings store and per-model credential-reference helpers. */
import { describe, expect, it, vi } from 'vitest'
import type {
  CredentialInfo, LlmConfigurableProvider, LlmProviderInfo, ModelCatalog, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  credentialRefFromSettings,
  createPixiesModelSettings,
  deriveCredentialRef,
  isPixiesApiKeyValid,
  modelCredentialRef,
  type PixiesModelGateway,
} from '../../src/client/models.ts'

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function fail(message: string): RemoteResult<never> {
  return { ok: false, error: { code: 'credential/rejected', message } } as unknown as RemoteResult<never>
}

const catalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash' },
  routableProviders: ['deepseek-official'],
  groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] }],
  failures: [],
} as unknown as ModelCatalog

const credential: CredentialInfo = { configured: true, writable: true }

const configurableProviders: LlmConfigurableProvider[] = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
  { provider: 'minimax', displayName: 'minimax', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'minimax'] },
]

function namespace(ns: string, value: unknown): SettingsNamespaceView {
  return { ns, value } as unknown as SettingsNamespaceView
}

function gateway(overrides: Partial<PixiesModelGateway> = {}): PixiesModelGateway {
  return {
    catalog: async () => ok(catalog),
    select: async () => ok({ selected: catalog.default }),
    resolveSessionId: async () => 'session-1' as unknown as SessionId,
    describeCredential: async () => ok<CredentialInfo | undefined>(credential),
    saveModelKey: async () => null,
    activateModelKey: async () => null,
    declareModel: async () => null,
    configurableProviders: async () => ok(configurableProviders),
    registeredProviders: async () => ok<LlmProviderInfo[]>([{ id: 'deepseek-official', name: 'DeepSeek' }]),
    enableProvider: async () => null,
    ...overrides,
  }
}

describe('credential reference helpers', () => {
  it('derives the conventional name for a route', () => {
    expect(deriveCredentialRef('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
  })

  it('gives every model its own reference, including the provider in it', () => {
    expect(modelCredentialRef('deepseek-official', 'deepseek-flash'))
      .toBe('PIXIES_DEEPSEEK_OFFICIAL_DEEPSEEK_FLASH_API_KEY')
    expect(modelCredentialRef('minimax-cn', 'MiniMax-M2.7'))
      .toBe('PIXIES_MINIMAX_CN_MINIMAX_M2_7_API_KEY')
    expect(modelCredentialRef('deepseek-official', 'deepseek-chat'))
      .not.toBe(modelCredentialRef('deepseek-official', 'deepseek-flash'))
  })

  it('accepts printable ASCII keys and rejects pasted environment lines', () => {
    expect(isPixiesApiKeyValid('  sk-live-key  ')).toBe(true)
    expect(isPixiesApiKeyValid('')).toBe(false)
    expect(isPixiesApiKeyValid('   ')).toBe(false)
    expect(isPixiesApiKeyValid('DEEPSEEK_API_KEY=sk-live')).toBe(false)
    expect(isPixiesApiKeyValid('"sk-live"')).toBe(false)
    expect(isPixiesApiKeyValid('sk-中文')).toBe(false)
  })

  it('reads the DeepSeek namespace and pi-ai provider profiles', () => {
    expect(credentialRefFromSettings('deepseek-official', [
      namespace('llm-deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY' }),
    ])).toBe('DEEPSEEK_API_KEY')
    expect(credentialRefFromSettings('acme-gateway', [
      namespace('llm-pi-ai', { providers: { 'acme-gateway': { apiKeyEnv: 'ACME_GATEWAY_API_KEY' } } }),
    ])).toBe('ACME_GATEWAY_API_KEY')
    expect(credentialRefFromSettings('unknown', [namespace('llm-deepseek', null)])).toBeUndefined()
  })
})

describe('createPixiesModelSettings', () => {
  it('loads the catalog and the current model key', async () => {
    const settings = createPixiesModelSettings(gateway())
    await settings.load()
    const state = settings.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.current).toEqual(catalog.default)
    expect(state.groups[0]?.models[0]?.id).toBe('deepseek-flash')
    expect(state.credential).toEqual({
      ref: modelCredentialRef('deepseek-official', 'deepseek-flash'),
      configured: true, writable: true, saving: false, error: null,
    })
  })

  it('inspects one model key without changing the selection', async () => {
    const describeCredential = vi.fn(async () => ok<CredentialInfo | undefined>(credential))
    const settings = createPixiesModelSettings(gateway({ describeCredential }))
    await settings.load()
    settings.inspectCredential('minimax', 'MiniMax-M2.7')
    await vi.waitFor(() => {
      expect(settings.getSnapshot().credential.ref).toBe(modelCredentialRef('minimax', 'MiniMax-M2.7'))
    })
    expect(settings.getSnapshot().current).toEqual(catalog.default)
    expect(describeCredential).toHaveBeenLastCalledWith(modelCredentialRef('minimax', 'MiniMax-M2.7'))
  })

  it('stores a typed key for one model', async () => {
    const saveModelKey = vi.fn(async () => null)
    const settings = createPixiesModelSettings(gateway({ saveModelKey }))
    await settings.load()
    const saved = await settings.saveCredential('deepseek-official', 'deepseek-flash', '  sk-live-key  ')
    expect(saved).toBe(true)
    expect(saveModelKey).toHaveBeenCalledWith('deepseek-official', 'deepseek-flash', 'sk-live-key')
    expect(settings.getSnapshot().credential.ref).toBe(modelCredentialRef('deepseek-official', 'deepseek-flash'))
    expect(settings.getSnapshot().credential.configured).toBe(true)
    expect(settings.getSnapshot().credential.saving).toBe(false)
  })

  it('keeps a rejected key write visible', async () => {
    const settings = createPixiesModelSettings(gateway({
      saveModelKey: async () => 'credential/rejected: read-only',
    }))
    const saved = await settings.saveCredential('deepseek-official', 'deepseek-flash', 'sk-live-key')
    expect(saved).toBe(false)
    expect(settings.getSnapshot().credential.error).toContain('read-only')
    expect(settings.getSnapshot().credential.saving).toBe(false)
  })

  it('keeps a credential describe failure on the credential surface', async () => {
    const settings = createPixiesModelSettings(gateway({ describeCredential: async () => fail('no provider') }))
    await settings.load()
    expect(settings.getSnapshot().status).toBe('ready')
    expect(settings.getSnapshot().credential.error).toContain('no provider')
  })

  it('reports a catalog failure instead of reading credentials', async () => {
    const settings = createPixiesModelSettings(gateway({ catalog: async () => fail('offline') }))
    await settings.load()
    expect(settings.getSnapshot().status).toBe('error')
    expect(settings.getSnapshot().error).toContain('offline')
  })

  it('declares a typed model before selecting it', async () => {
    const declareModel = vi.fn(async () => null)
    const select = vi.fn(async () => ok({ selected: catalog.default }))
    const settings = createPixiesModelSettings(gateway({ declareModel, select }))
    await settings.load()
    await settings.select({ provider: 'acme-gateway', model: 'acme-large' })
    expect(declareModel).toHaveBeenCalledWith('acme-gateway', 'acme-large')
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('keeps a declaration failure visible without selecting anything', async () => {
    const select = vi.fn(async () => ok({ selected: catalog.default }))
    const settings = createPixiesModelSettings(gateway({
      declareModel: async () => 'settings/conflict: stale',
      select,
    }))
    await settings.load()
    await settings.select({ provider: 'acme-gateway', model: 'acme-large' })
    expect(settings.getSnapshot().error).toContain('stale')
    expect(settings.getSnapshot().status).toBe('error')
    expect(select).not.toHaveBeenCalled()
    expect(settings.getSnapshot().current).toEqual(catalog.default)
  })

  it('activates the selected model key after a selection', async () => {
    const activateModelKey = vi.fn(async () => null)
    const settings = createPixiesModelSettings(gateway({ activateModelKey }))
    await settings.load()
    await settings.select({ provider: 'acme-gateway', model: 'acme-large' })
    expect(settings.getSnapshot().current).toEqual({ provider: 'acme-gateway', model: 'acme-large' })
    expect(activateModelKey).toHaveBeenCalledWith('acme-gateway', 'acme-large')
    expect(settings.getSnapshot().credential.ref).toBe(modelCredentialRef('acme-gateway', 'acme-large'))
  })

  it('keeps a failed key activation visible', async () => {
    const settings = createPixiesModelSettings(gateway({
      activateModelKey: async () => 'settings/conflict: stale',
    }))
    await settings.load()
    await settings.select({ provider: 'acme-gateway', model: 'acme-large' })
    expect(settings.getSnapshot().credential.error).toContain('stale')
    expect(settings.getSnapshot().status).toBe('ready')
  })

  it('does not let a stale describe overwrite the newer model key', async () => {
    const pending: ((result: RemoteResult<CredentialInfo | undefined>) => void)[] = []
    const describeCredential = vi.fn(() => new Promise<RemoteResult<CredentialInfo | undefined>>((resolve) => {
      pending.push(resolve)
    }))
    const settings = createPixiesModelSettings(gateway({ describeCredential }))
    settings.inspectCredential('minimax', 'MiniMax-M2.7')
    settings.inspectCredential('minimax', 'MiniMax-M2.5')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(pending).toHaveLength(2)
    pending[1]?.(ok<CredentialInfo | undefined>({ configured: false, writable: true }))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    pending[0]?.(ok<CredentialInfo | undefined>(credential))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(settings.getSnapshot().credential.ref).toBe(modelCredentialRef('minimax', 'MiniMax-M2.5'))
    expect(settings.getSnapshot().credential.configured).toBe(false)
  })

  it('lists installed provider routes with their registration state', async () => {
    const settings = createPixiesModelSettings(gateway())
    await settings.load()
    expect(settings.getSnapshot().providers).toEqual([
      { id: 'deepseek-official', name: 'DeepSeek', registered: true },
      { id: 'minimax', name: 'minimax', registered: false },
    ])
  })

  it('marks a route registered from the live provider list', async () => {
    const settings = createPixiesModelSettings(gateway({
      registeredProviders: async () => ok<LlmProviderInfo[]>([
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'minimax', name: 'minimax' },
      ]),
    }))
    await settings.load()
    expect(settings.getSnapshot().providers[1]).toEqual({ id: 'minimax', name: 'minimax', registered: true })
  })

  it('enables a dormant route and refreshes the catalog', async () => {
    const enableProvider = vi.fn(async () => null)
    const settings = createPixiesModelSettings(gateway({ enableProvider }))
    await settings.load()
    const failure = await settings.enableProvider('minimax')
    expect(failure).toBeNull()
    expect(enableProvider).toHaveBeenCalledWith('minimax')
    expect(settings.getSnapshot().enabling).toBeNull()
    expect(settings.getSnapshot().status).toBe('ready')
  })

  it('reports a failed route enablement without leaving the enabling state', async () => {
    const settings = createPixiesModelSettings(gateway({ enableProvider: async () => 'settings/conflict: stale' }))
    const failure = await settings.enableProvider('minimax')
    expect(failure).toContain('stale')
    expect(settings.getSnapshot().enabling).toBeNull()
  })

  it('refreshes the displayed credential and stops publishing after dispose', async () => {
    const describeCredential = vi.fn(async () => ok<CredentialInfo | undefined>(credential))
    const settings = createPixiesModelSettings(gateway({ describeCredential }))
    await settings.load()
    settings.refreshCredential()
    await Promise.resolve()
    expect(describeCredential).toHaveBeenCalledTimes(2)
    const before = settings.getSnapshot()
    settings.dispose()
    settings.refreshCredential()
    expect(settings.getSnapshot()).toBe(before)
  })
})
