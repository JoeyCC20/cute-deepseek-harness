/**
 * Model settings for the Pixies settings window. The Host's generated
 * `session.modelCatalog` is the read model and `session.selectModel` is the
 * write; a selection also becomes the deployment default on the Host. Each
 * (provider, model) pair owns its own credential reference, so switching the
 * model brings its own API key with it instead of sharing one global key.
 * A custom model id is simply a selection the advisory catalog does not
 * advertise — `llm.resolveCallConfig` decides whether the route serves it.
 * @module @deepseek-ai/dsh-pixies/client
 */

import type {
  CredentialInfo, LlmConfigurableProvider, LlmProviderInfo, ModelCatalog, ModelSelection, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** One provider and the models the Host advertises for it. */
export interface PixiesModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** One provider whose catalog lookup failed, kept visible instead of hidden. */
export interface PixiesModelFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/** One selectable provider route, configured or merely available in the installed catalog. */
export interface PixiesProviderOption {
  readonly id: string
  readonly name: string
  /** Whether an adapter currently serves this route. */
  readonly registered: boolean
}

/** State of the credential reference the selected provider resolves per request. */
export interface PixiesCredentialState {
  /** Reference name; values themselves never leave the Host. */
  readonly ref: string
  readonly configured: boolean
  readonly writable: boolean
  readonly saving: boolean
  readonly error: string | null
}

/** Render-ready model settings; the UI never sees Remote or catalog internals. */
export interface PixiesModelState {
  /** Deployment default, which the Host updates after every selection. */
  readonly current: ModelSelection | null
  readonly groups: readonly PixiesModelGroup[]
  readonly failures: readonly PixiesModelFailure[]
  readonly status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  readonly error: string | null
  readonly credential: PixiesCredentialState
  readonly providers: readonly PixiesProviderOption[]
  /** Route currently being enabled, or null. */
  readonly enabling: string | null
}

/** The Host operations the model settings need, injected by the plugin. */
export interface PixiesModelGateway {
  /** Read the Host-generation catalog. */
  readonly catalog: () => Promise<RemoteResult<ModelCatalog>>
  /** Install one session-local selection. */
  readonly select: (request: {
    readonly sessionId: SessionId
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }) => Promise<RemoteResult<unknown>>
  /** Resolve the followed session, creating one when the profile has none. */
  readonly resolveSessionId: () => Promise<SessionId>
  /** Make a typed model id serviceable on its provider; error text means failure. */
  readonly declareModel: (provider: string, model: string) => Promise<string | null>
  /** Read one credential's configured/writable state; no value crosses the wire. */
  readonly describeCredential: (ref: string) => Promise<RemoteResult<CredentialInfo | undefined>>
  /** Store one model's key and point its provider at that key; error text means failure. */
  readonly saveModelKey: (provider: string, model: string, value: string) => Promise<string | null>
  /** Point a provider at a model's stored key; a model without one leaves the provider alone. */
  readonly activateModelKey: (provider: string, model: string) => Promise<string | null>
  /** List every configurable provider, including dormant catalog routes. */
  readonly configurableProviders: () => Promise<RemoteResult<LlmConfigurableProvider[]>>
  /** List the provider routes that currently have an adapter. */
  readonly registeredProviders: () => Promise<RemoteResult<LlmProviderInfo[]>>
  /** Activate one dormant route and wait for its adapter; an error text means failure. */
  readonly enableProvider: (route: string) => Promise<string | null>
}

/** Observable model settings surface consumed by the settings window. */
export interface PixiesModelSettings {
  readonly getSnapshot: () => PixiesModelState
  readonly subscribe: (listener: () => void) => () => void
  /** Refresh the catalog, the deployment default and the current model's key. */
  readonly load: () => Promise<void>
  /** Install a selection, activate its key and report failures in state. */
  readonly select: (selection: ModelSelection) => Promise<void>
  /** Enable one dormant provider route and refresh the catalog; an error text means failure. */
  readonly enableProvider: (route: string) => Promise<string | null>
  /** Store a typed key for one model; resolves to whether the write succeeded. */
  readonly saveCredential: (provider: string, model: string, value: string) => Promise<boolean>
  /** Show the key of one model in the form, without changing the selection. */
  readonly inspectCredential: (provider: string, model: string) => void
  /** Re-read the displayed credential after another surface changed it. */
  readonly refreshCredential: () => void
  /** Stop publishing; late responses must not change the snapshot. */
  readonly dispose: () => void
}

const EMPTY_CREDENTIAL: PixiesCredentialState = {
  ref: '', configured: false, writable: true, saving: false, error: null,
}

const EMPTY_STATE: PixiesModelState = {
  current: null,
  groups: [],
  failures: [],
  status: 'idle',
  error: null,
  credential: EMPTY_CREDENTIAL,
  providers: [],
  enabling: null,
}

/** Render a Remote failure as one actionable line. */
function failureText(error: { readonly code: string; readonly message: string }): string {
  return `${error.code}: ${error.message}`
}

/** Render a thrown value as one actionable line. */
function thrownText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Narrow a redacted settings value to its object face. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Conventional reference for a provider route when no profile names one.
 * Mirrors the full models page's derivation so a key typed here lands where
 * that page would look for it.
 * @param provider - provider route id.
 * @returns an environment-variable style reference name.
 */
export function deriveCredentialRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Credential reference owned by exactly one model. The provider is part of the
 * name so two routes advertising the same model id never share a key.
 * @param provider - provider route id.
 * @param model - built-in or user-typed model id.
 * @returns the reference name holding this model's key.
 */
export function modelCredentialRef(provider: string, model: string): string {
  const pair = `${provider}/${model}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return `PIXIES_${pair}_API_KEY`
}

/**
 * Find the credential reference a provider resolves at request time. The
 * DeepSeek adapter owns a whole namespace; pi-ai keeps one profile per route
 * under `providers`. Both are read from the redacted settings view, which
 * carries `apiKeyEnv` but never a secret value.
 * @param provider - provider route id from the model catalog.
 * @param namespaces - redacted namespace views from `settings.describe()`.
 * @returns the configured reference, or undefined when none names one.
 */
export function credentialRefFromSettings(
  provider: string,
  namespaces: readonly SettingsNamespaceView[],
): string | undefined {
  for (const namespace of namespaces) {
    const value = asRecord(namespace.value)
    if (value === undefined) continue
    if (namespace.ns === 'llm-deepseek' && provider === 'deepseek-official' && typeof value.apiKeyEnv === 'string' && value.apiKeyEnv !== '') {
      return value.apiKeyEnv
    }
    const profile = asRecord(asRecord(value.providers)?.[provider])
    if (typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== '') return profile.apiKeyEnv
  }
  return undefined
}

/**
 * Judge a typed key before it crosses the wire. Mirrors the models page's
 * check: printable ASCII without spaces, and no pasted `NAME=value` line or
 * quoted whole line.
 * @param draft - the untrimmed input value.
 * @returns whether the trimmed value is a storable key.
 */
export function isPixiesApiKeyValid(draft: string): boolean {
  const value = draft.trim()
  if (value === '' || /^[A-Z][A-Z0-9_]*=[^=]/.test(value)) return false
  const first = value[0]
  if ((first === '"' || first === '\'' || first === '`') && value.length > 1 && value.endsWith(first)) return false
  return /^[\x21-\x7E]+$/.test(value)
}

/**
 * Create the in-window model settings store.
 * @param gateway - Host operations and the followed-session resolver.
 * @returns an observable settings face; the caller owns its disposer.
 */
export function createPixiesModelSettings(gateway: PixiesModelGateway): PixiesModelSettings {
  let state: PixiesModelState = EMPTY_STATE
  const listeners = new Set<() => void>()
  let disposed = false
  const publish = (next: PixiesModelState): void => {
    if (disposed) return
    state = next
    for (const listener of [...listeners]) listener()
  }
  const withStatus = (status: PixiesModelState['status'], error: string | null = null): PixiesModelState =>
    ({ ...state, status, error })
  const withCredential = (credential: PixiesCredentialState): PixiesModelState =>
    ({ ...state, credential })

  // Switching the model rapidly must not let an older describe overwrite the
  // key state of the model the form currently shows.
  let credentialRequest = 0
  /** Re-read one reference; a failed describe keeps the ref visible with its error. */
  const loadCredential = async (ref: string): Promise<void> => {
    const request = ++credentialRequest
    try {
      const response = await gateway.describeCredential(ref)
      if (disposed || request !== credentialRequest) return
      if (!response.ok) {
        publish(withCredential({ ...state.credential, ref, saving: false, error: failureText(response.error) }))
        return
      }
      publish(withCredential({
        ref,
        configured: response.value?.configured ?? false,
        writable: response.value?.writable ?? true,
        saving: false,
        error: null,
      }))
    } catch (error: unknown) {
      if (!disposed && request === credentialRequest) {
        publish(withCredential({ ...state.credential, error: thrownText(error) }))
      }
    }
  }

  /** Re-read the key owned by exactly one model. */
  const loadModelCredential = (provider: string, model: string): Promise<void> =>
    loadCredential(modelCredentialRef(provider, model))

  /** Refresh the catalog, the provider directory and the followed credential. */
  const loadState = async (): Promise<void> => {
    publish(withStatus(state.status === 'ready' ? 'ready' : 'loading'))
    try {
      const [catalogResponse, providersResponse, registeredResponse] = await Promise.all([
        gateway.catalog(), gateway.configurableProviders(), gateway.registeredProviders(),
      ])
      if (disposed) return
      if (!catalogResponse.ok) {
        publish(withStatus('error', failureText(catalogResponse.error)))
        return
      }
      const catalog = catalogResponse.value
      // modelCatalog() captures its provider list before querying each adapter,
      // so a route enabled moments ago can still be missing from that snapshot.
      const routable = registeredResponse.ok
        ? new Set(registeredResponse.value.map(entry => entry.id))
        : new Set(catalog.routableProviders)
      const providers: readonly PixiesProviderOption[] = providersResponse.ok
        ? providersResponse.value.map(entry => ({
          id: entry.provider,
          name: entry.displayName,
          registered: routable.has(entry.provider),
        }))
        : catalog.groups.map(group => ({ id: group.id, name: group.name, registered: true }))
      publish({
        current: catalog.default,
        groups: catalog.groups.map(group => ({
          id: group.id,
          name: group.name,
          models: group.models.map(model => ({ id: model.id, name: model.name })),
        })),
        failures: catalog.failures.map(failure => ({
          id: failure.id,
          name: failure.name,
          message: failure.message,
        })),
        providers,
        status: 'ready',
        error: null,
        credential: state.credential,
        enabling: state.enabling,
      })
    } catch (error: unknown) {
      if (!disposed) publish(withStatus('error', thrownText(error)))
      return
    }
    const current = state.current
    if (current !== null) await loadModelCredential(current.provider, current.model)
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load: loadState,
    select: async (selection) => {
      publish(withStatus('selecting'))
      try {
        const declared = await gateway.declareModel(selection.provider, selection.model)
        if (declared !== null) {
          publish(withStatus('error', declared))
          return
        }
        const sessionId = await gateway.resolveSessionId()
        const response = await gateway.select({ sessionId, ...selection })
        if (disposed) return
        if (!response.ok) {
          publish(withStatus('error', failureText(response.error)))
          return
        }
        publish({ ...state, current: selection, status: 'ready', error: null })
        const failure = await gateway.activateModelKey(selection.provider, selection.model)
        if (failure !== null) {
          publish(withCredential({ ...state.credential, error: failure }))
          return
        }
        await loadModelCredential(selection.provider, selection.model)
      } catch (error: unknown) {
        if (!disposed) publish(withStatus('error', thrownText(error)))
      }
    },
    enableProvider: async (route) => {
      publish({ ...state, enabling: route, status: 'selecting' })
      try {
        const failure = await gateway.enableProvider(route)
        if (disposed) return failure
        publish({ ...state, enabling: null, status: 'ready' })
        if (failure === null) await loadState()
        return failure
      } catch (error: unknown) {
        const message = thrownText(error)
        if (!disposed) publish({ ...state, enabling: null, status: 'ready' })
        return message
      }
    },
    saveCredential: async (provider, model, value) => {
      publish(withCredential({ ...state.credential, saving: true, error: null }))
      try {
        const failure = await gateway.saveModelKey(provider, model, value.trim())
        if (disposed) return false
        if (failure !== null) {
          publish(withCredential({ ...state.credential, saving: false, error: failure }))
          return false
        }
        publish(withCredential({ ...state.credential, saving: false, configured: true, error: null }))
        await loadModelCredential(provider, model)
        return true
      } catch (error: unknown) {
        if (!disposed) publish(withCredential({ ...state.credential, saving: false, error: thrownText(error) }))
        return false
      }
    },
    inspectCredential: (provider, model) => { void loadModelCredential(provider, model) },
    refreshCredential: () => {
      const ref = state.credential.ref
      if (ref !== '') void loadCredential(ref)
    },
    dispose: () => {
      disposed = true
      listeners.clear()
    },
  }
}
