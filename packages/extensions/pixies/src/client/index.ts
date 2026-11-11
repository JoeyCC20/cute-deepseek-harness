/**
 * Pixies client half: observes the forwarded approval/question waterfalls and
 * publishes them plus session-derived speech into a shared in-window store
 * the character panel renders from. Delegates every waterfall via `next()`,
 * so the existing answerer chain is untouched. When the page carries the
 * pixies shell marker, it also follows the sessions domain and mounts the
 * full-window character overlay.
 * @module @deepseek-ai/dsh-pixies/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ctx.remote event surface and the credential/settings views.
import type { CredentialInfo, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ctx.sessions face for the session follow.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { createPixiesStore } from './store.ts'
import {
  credentialRefFromSettings, createPixiesModelSettings, deriveCredentialRef, modelCredentialRef,
} from './models.ts'
import { mountPixiesSettings } from './settings.tsx'
import {
  createPixiesSessionSelection,
  defaultPixiesMessages,
  followPixiesSession,
  mountPixiesShell,
  pickPixiesSessionId,
  promptPixiesSession,
  resolvePixiesShellBridge,
  type PixiesSessionPanel,
} from './shell.tsx'

export { createPixiesStore } from './store.ts'
export type { PixiesClientState, PixiesListener, PixiesStore } from './store.ts'
export { feedSessionEvent } from './feed.ts'
export type { AssistantMessageEventData, SessionEventLike } from './feed.ts'
export {
  PixiesBubble,
  PixiesCharacter,
  PixiesCollapseButton,
  PixiesListeningRing,
  PixiesMicButton,
  PixiesPanel,
  PixiesThinkingRing,
  PixiesVoiceButton,
} from './character.tsx'
export type { PixiesPanelMessages } from './character.tsx'
export {
  createPixiesSessionSelection,
  defaultPixiesMessages,
  followPixiesSession,
  isPixiesVoiceCommandEvent,
  isPixiesVoiceReplyEvent,
  mountPixiesShell,
  pickPixiesSessionId,
  promptPixiesSession,
  resolvePixiesShellBridge,
} from './shell.tsx'
export type {
  PixiesSessionFollow,
  PixiesSessionPanel,
  PixiesSessionSelection,
  PixiesShellBridge,
  PixiesShellMode,
  PixiesShellSpeechEvent,
  PixiesShellVoiceCommandEvent,
  PixiesShellVoiceEvent,
} from './shell.tsx'
export type { PixiesInteraction, PixiesMood, PixiesPresentation } from '../types.ts'

/** The page marker the pixies host half injects for its own shell window. */
const PIXIES_SHELL_FLAG = '__DSH_PIXIES_SHELL__'

/** Function-plugin identity for the client composition row. */
export const name = 'pixies-client'

/** The Workspace Controller projection that owns the archived-session set. */
interface PixiesWorkspaceArchive {
  readonly list: {
    readonly getSnapshot: () => { readonly archivedSessionIds: readonly SessionId[] }
    readonly subscribe: (listener: () => void) => () => void
  }
  readonly archiveSession: (id: SessionId) => Promise<void>
}

/** The reference source this plugin holds while the character follows a session. */
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** The pixies character's followed session (event follow + voice prompt). */
    pixiesShell: unknown
  }
}

/** Required services: Remote Events plus the session/credentials/settings namespaces for the settings drawer, Sessions for the follow. */
export const inject = ['remote', 'sessions', 'workspaces', 'remote.session', 'remote.credentials', 'remote.settings', 'remote.llm']

/** The single in-window store shared by the observers and the shell panel. */
export const pixiesStore = createPixiesStore()

/** The overlay mount point created once per window when the shell marker is present. */
let shellOverlay: HTMLDivElement | undefined

/**
 * Client plugin body: observe the forwarded approval and question waterfalls
 * into the shared store, always delegating; follow the live session feed; and
 * mount the character overlay when this window is the pixies shell.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const selection = createPixiesSessionSelection()
  // The Host list is the whole catalog, including cold sessions from other
  // workspaces. An extra refresh makes sure that baseline has arrived before
  // the user first opens the history drawer.
  void ctx.sessions.refresh().catch(() => {
    // A failed refresh leaves the subscribed baseline intact; history still
    // renders whatever the Host has already projected.
  })
  // ui-workspace shares this service; resolving it on demand keeps the shell
  // mountable when the Workspace Controller has not been installed.
  const archive = (): PixiesWorkspaceArchive | undefined =>
    ctx.get('workspaces') as PixiesWorkspaceArchive | undefined
  const sessionPanel: PixiesSessionPanel = {
    getSnapshot: () => ctx.sessions.list.getSnapshot(),
    hiddenIds: () => archive()?.list.getSnapshot().archivedSessionIds ?? [],
    subscribe: (listener) => {
      const offList = ctx.sessions.list.subscribe(listener)
      const offSelection = selection.subscribe(listener)
      const offArchive = archive()?.list.subscribe(listener)
      return () => { offList(); offSelection(); offArchive?.() }
    },
    selectedId: () => pickPixiesSessionId(ctx.sessions.list.getSnapshot(), selection.get()),
    select: (id) => { selection.set(id) },
    // create() publishes the catalog row before resolving, so the selection
    // switch rebinds the follow onto an id the list can already address.
    create: async () => {
      const id = await ctx.sessions.create()
      selection.set(id)
      return id
    },
    remove: async (id) => {
      const workspaces = archive()
      if (workspaces === undefined) throw new Error('workspace controller is unavailable')
      await workspaces.archiveSession(id)
      // The Host session list still carries an archived id, so the follow must
      // leave it explicitly instead of waiting for a catalog removal.
      const hidden = new Set<string>(workspaces.list.getSnapshot().archivedSessionIds)
      const state = ctx.sessions.list.getSnapshot()
      if (pickPixiesSessionId(state, selection.get()) !== id) return
      const next = state.ids.find(candidate => candidate !== id && !hidden.has(candidate))
      if (next !== undefined) { selection.set(next); return }
      const created = await ctx.sessions.create()
      selection.set(created)
    },
  }
  ctx.effect(() => () => { pixiesStore.clear() }, 'pixies-client: store teardown')
  ctx.remote.$on('approval/request', function (request, next) {
    pixiesStore.setInteraction({ kind: 'approval', sessionId: '', summary: request.toolName })
    return next()
  })
  ctx.remote.$on('user-questions/request', function (request, next) {
    pixiesStore.setInteraction({ kind: 'question', sessionId: '', summary: request.questions[0]?.question ?? '' })
    return next()
  })
  const follow = followPixiesSession(ctx.sessions, pixiesStore, selection)
  ctx.effect(() => () => { follow.dispose() }, 'pixies-client: session follow teardown')
  if ((globalThis as Record<string, unknown>)[PIXIES_SHELL_FLAG] === true) {
    // The Host resolves exactly one credential reference per provider, so a
    // model's key becomes effective by pointing its provider at that model's
    // reference. Pixies injects .env values into process.env (a read-only
    // launch layer), which is why every model gets its own writable reference
    // instead of trying to overwrite DEEPSEEK_API_KEY.
    const setApiKeyEnv = async (provider: string, ref: string): Promise<string | null> => {
      const ns = provider === 'deepseek-official' ? 'llm-deepseek' : 'llm-pi-ai'
      const described = await ctx.remote.settings.describe()
      if (!described.ok) return `${described.error.code}: ${described.error.message}`
      if (credentialRefFromSettings(provider, described.value.namespaces) === ref) return null
      const namespace = described.value.namespaces.find(entry => entry.ns === ns)
      if (namespace === undefined) return `settings namespace "${ns}" is not registered`
      const written = provider === 'deepseek-official'
        ? await ctx.remote.settings.mutate(ns, [
          { op: 'set', path: ['apiKeyEnv'], value: ref },
        ], namespace.revision)
        : await ctx.remote.settings.mutate(ns, [
          { op: 'set', path: ['providers', provider, 'apiKeyEnv'], value: ref },
        ], namespace.revision)
      return written.ok ? null : `${written.error.code}: ${written.error.message}`
    }
    const modelSettings = createPixiesModelSettings({
      catalog: () => ctx.remote.session.modelCatalog(),
      select: request => ctx.remote.session.selectModel(request),
      resolveSessionId: async () => {
        const followed = pickPixiesSessionId(ctx.sessions.list.getSnapshot(), selection.get())
        if (followed !== undefined) return followed
        return ctx.sessions.create()
      },
      describeCredential: async (ref): Promise<RemoteResult<CredentialInfo | undefined>> => {
        const response = await ctx.remote.credentials.describe([ref])
        if (!response.ok) return response
        return { ok: true, value: response.value[ref] }
      },
      saveModelKey: async (provider, model, value) => {
        const ref = modelCredentialRef(provider, model)
        const stored = await ctx.remote.credentials.set(ref, value)
        if (!stored.ok) return `${stored.error.code}: ${stored.error.message}`
        return setApiKeyEnv(provider, ref)
      },
      activateModelKey: async (provider, model) => {
        const ref = modelCredentialRef(provider, model)
        const info = await ctx.remote.credentials.describe([ref])
        if (!info.ok) return `${info.error.code}: ${info.error.message}`
        if (info.value[ref]?.configured !== true) return null
        return setApiKeyEnv(provider, ref)
      },
      // pi-ai serves only models its route declares. A typed id is added to
      // that route's models list before selection: skipping the lookup alone
      // would still leave stream() without a wire descriptor to dispatch on.
      declareModel: async (provider, model) => {
        const catalog = await ctx.remote.session.modelCatalog()
        if (!catalog.ok) return `${catalog.error.code}: ${catalog.error.message}`
        const group = catalog.value.groups.find(entry => entry.id === provider)
        if (group?.models.some(entry => entry.id === model) === true) return null
        const directory = await ctx.remote.llm.listConfigurableProviders()
        if (!directory.ok) return `${directory.error.code}: ${directory.error.message}`
        if (directory.value.find(entry => entry.provider === provider)?.settingsNs !== 'llm-pi-ai') return null
        const described = await ctx.remote.settings.describe()
        if (!described.ok) return `${described.error.code}: ${described.error.message}`
        const namespace = described.value.namespaces.find(entry => entry.ns === 'llm-pi-ai')
        if (namespace === undefined) return 'settings namespace "llm-pi-ai" is not registered'
        const entries = [
          ...(group?.models.map(entry => ({ id: entry.id, name: entry.name })) ?? []),
          { id: model, name: model },
        ]
        const written = await ctx.remote.settings.mutate('llm-pi-ai', [
          { op: 'set', path: ['providers', provider, 'models'], value: entries },
        ], namespace.revision)
        if (!written.ok) return `${written.error.code}: ${written.error.message}`
        // Adapter registration follows the settings commit through a watcher.
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const refreshed = await ctx.remote.session.modelCatalog()
          if (refreshed.ok && refreshed.value.groups.some(entry => entry.id === provider
            && entry.models.some(candidate => candidate.id === model))) return null
          await new Promise((resolve) => { setTimeout(resolve, 250) })
        }
        return `model "${model}" did not become available after declaring it`
      },
      configurableProviders: () => ctx.remote.llm.listConfigurableProviders(),
      registeredProviders: () => ctx.remote.llm.listProviders(),
      // An installed catalog route needs only a profile entry to register live:
      // pi-ai inherits its endpoint, protocol and models. The profile names the
      // credential reference so a key typed here reaches the same route.
      enableProvider: async (route) => {
        const described = await ctx.remote.settings.describe()
        if (!described.ok) return `${described.error.code}: ${described.error.message}`
        const namespace = described.value.namespaces.find(entry => entry.ns === 'llm-pi-ai')
        if (namespace === undefined) return 'settings namespace "llm-pi-ai" is not registered'
        const written = await ctx.remote.settings.mutate('llm-pi-ai', [
          { op: 'set', path: ['providers', route], value: { apiKeyEnv: deriveCredentialRef(route) } },
        ], namespace.revision)
        if (!written.ok) return `${written.error.code}: ${written.error.message}`
        // Adapter registration follows the settings commit through a watcher,
        // so the write can succeed before the route can serve a selection.
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const providers = await ctx.remote.llm.listProviders()
          if (providers.ok && providers.value.some(entry => entry.id === route)) return null
          await new Promise((resolve) => { setTimeout(resolve, 250) })
        }
        return `provider "${route}" did not register after enabling it`
      },
    })
    ctx.effect(
      () => ctx.remote.$on('credentials/reference-updated', () => { modelSettings.refreshCredential() }),
      'pixies-client: credential invalidations',
    )
    ctx.effect(
      () => ctx.remote.$on('llm/adapters-updated', () => { void modelSettings.load() }),
      'pixies-client: adapter invalidations',
    )
    // The settings window loads the same index with `?pixiesSettings=1`; the
    // Host's shell injections are process-wide, so the face is chosen in the
    // renderer rather than by serving different HTML.
    const settingsFace = new URLSearchParams(globalThis.location.search).has('pixiesSettings')
    shellOverlay ??= globalThis.document.createElement('div')
    // The injected shell style hides every direct body child without this
    // marker, so the overlay container itself must carry it.
    shellOverlay.dataset.pixiesShell = ''
    globalThis.document.body.append(shellOverlay)
    const unmount = settingsFace
      ? mountPixiesSettings(shellOverlay, modelSettings, defaultPixiesMessages)
      : mountPixiesShell(
        shellOverlay,
        pixiesStore,
        defaultPixiesMessages,
        resolvePixiesShellBridge(),
        text => promptPixiesSession(ctx.sessions, text, selection),
        sessionPanel,
      )
    ctx.effect(() => () => {
      unmount()
      modelSettings.dispose()
      shellOverlay?.remove()
      shellOverlay = undefined
    }, 'pixies-client: shell overlay teardown')
  }
}
