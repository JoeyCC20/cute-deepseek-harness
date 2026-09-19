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
// Type-only: pulls the ctx.remote event surface for the forwarded waterfalls.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ctx.sessions face for the session follow.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { createPixiesStore } from './store.ts'
import {
  defaultPixiesMessages,
  followPixiesSession,
  mountPixiesShell,
  promptPixiesSession,
  resolvePixiesShellBridge,
} from './shell.tsx'

export { createPixiesStore } from './store.ts'
export type { PixiesClientState, PixiesListener, PixiesStore } from './store.ts'
export { feedSessionEvent } from './feed.ts'
export type { AssistantMessageEventData, SessionEventLike } from './feed.ts'
export {
  PixiesBubble,
  PixiesCharacter,
  PixiesCollapseButton,
  PixiesMicButton,
  PixiesPanel,
} from './character.tsx'
export type { PixiesPanelMessages } from './character.tsx'
export {
  defaultPixiesMessages,
  followPixiesSession,
  mountPixiesShell,
  pickPixiesSessionId,
  promptPixiesSession,
  resolvePixiesShellBridge,
} from './shell.tsx'
export type {
  PixiesSessionFollow,
  PixiesShellBridge,
  PixiesShellMode,
  PixiesShellSpeechEvent,
} from './shell.tsx'
export type { PixiesInteraction, PixiesMood, PixiesPresentation } from '../types.ts'

/** The page marker the pixies host half injects for its own shell window. */
const PIXIES_SHELL_FLAG = '__DSH_PIXIES_SHELL__'

/** Function-plugin identity for the client composition row. */
export const name = 'pixies-client'

/** Required services: Remote Events for the forwarded waterfalls, Sessions for the follow. */
export const inject = ['remote', 'sessions']

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
  ctx.effect(() => () => pixiesStore.clear(), 'pixies-client: store teardown')
  ctx.remote.$on('approval/request', function (request, next) {
    pixiesStore.setInteraction({ kind: 'approval', sessionId: '', summary: request.toolName })
    return next()
  })
  ctx.remote.$on('user-questions/request', function (request, next) {
    pixiesStore.setInteraction({ kind: 'question', sessionId: '', summary: request.questions[0]?.question ?? '' })
    return next()
  })
  const follow = followPixiesSession(ctx.sessions, pixiesStore)
  ctx.effect(() => () => { follow.dispose() }, 'pixies-client: session follow teardown')
  if ((globalThis as Record<string, unknown>)[PIXIES_SHELL_FLAG] === true) {
    shellOverlay ??= globalThis.document.createElement('div')
    // The injected shell style hides every direct body child without this
    // marker, so the overlay container itself must carry it.
    shellOverlay.dataset.pixiesShell = ''
    globalThis.document.body.append(shellOverlay)
    const unmount = mountPixiesShell(
      shellOverlay,
      pixiesStore,
      defaultPixiesMessages,
      resolvePixiesShellBridge(),
      (text) => { promptPixiesSession(ctx.sessions, text) },
    )
    ctx.effect(() => () => {
      unmount()
      shellOverlay?.remove()
      shellOverlay = undefined
    }, 'pixies-client: shell overlay teardown')
  }
}
