/**
 * Pixies menu-bar character client, host half: observes the
 * `approval/request` and `user-questions/request` answerer waterfalls as a
 * delegating listener, and derives speech-bubble presentations from
 * `assistant/message` session events. Purely additive: it never claims a
 * waterfall (a missing `next()` would short-circuit the chain) and never
 * touches existing composition code.
 * @module @deepseek-ai/dsh-pixies
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the dsh-session Context/Events surface (session/event).
import type {} from '@deepseek-ai/dsh-session'
// Type-only: pulls the approval/request waterfall Events declaration.
import type {} from '@deepseek-ai/dsh-user-approval/types'
// Type-only: pulls the user-questions/request waterfall Events declaration.
import type {} from '@deepseek-ai/dsh-user-questions/types'
// Type-only: pulls the webserver/index-inject Events declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { presentationFromAssistantMessage } from './presentation.ts'
import { PIXIES_SHELL_ENV, pixiesIndexInjections } from './shell-inject.ts'
import type { PixiesInteraction, PixiesPresentation } from './types.ts'

/** Function-plugin identity, registered as a composition row (`- id: pixies`). */
export const name = 'pixies'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Pixies presentation service: latest speech per session plus event publication. */
    pixies: PixiesService
  }
  interface Events {
    /**
     * A presentation is ready for the character's speech bubble.
     * @param presentation - the derived presentation.
     * @mode emit
     */
    'pixies/presentation'(presentation: PixiesPresentation): void
    /**
     * A host-side approval or question entered the answerer waterfall. The
     * observer always delegates; this event only informs the character.
     * @param interaction - the observed interaction.
     * @mode emit
     */
    'pixies/interaction'(interaction: PixiesInteraction): void
  }
}

/** Plugin config. All fields optional — the schema supplies the defaults. */
export interface Config {
  /** The character that speaks the presentations; an open set of ids. */
  readonly character?: string
  /** Master switch; when false the plugin only registers the service. */
  readonly enabled?: boolean
  /** Observe (and delegate) the approval/request waterfall. */
  readonly observeApproval?: boolean
  /** Observe (and delegate) the user-questions/request waterfall. */
  readonly observeQuestions?: boolean
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  character: z.string().default('spider-man'),
  enabled: z.boolean().default(true),
  observeApproval: z.boolean().default(true),
  observeQuestions: z.boolean().default(true),
})

/**
 * Pixies presentation service: keeps the latest presentation per session and
 * publishes every presentation to `pixies/presentation`.
 */
export class PixiesService extends Service {
  static Config: typeof Config = Config

  private readonly latestBySession = new Map<string, PixiesPresentation>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'pixies')
  }

  /**
   * Read the latest presentation derived for one session.
   * @param sessionId - the session whose latest presentation to read.
   * @returns the latest presentation, or `undefined` when none was derived.
   */
  latest(sessionId: string): PixiesPresentation | undefined {
    return this.latestBySession.get(sessionId)
  }

  /**
   * Publish one presentation: fold it into the per-session projection and
   * emit `pixies/presentation`.
   * @param presentation - the presentation to publish.
   */
  present(presentation: PixiesPresentation): void {
    this.latestBySession.set(presentation.sessionId, presentation)
    this.ctx.emit('pixies/presentation', presentation)
  }
}

/**
 * Plugin body: register the service, the delegating waterfall observers, and
 * the session/event fold. Every listener delegates (`next()`), so the
 * existing answerer chain and fail-closed semantics are preserved.
 * @param ctx - host root context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const service = new PixiesService(ctx, config)
  if (config.enabled === false) return
  if (config.observeApproval) {
    ctx.on('approval/request', (request, next) => {
      ctx.emit('pixies/interaction', {
        kind: 'approval',
        sessionId: request.agent.id,
        summary: request.toolName,
      })
      return next()
    })
  }
  if (config.observeQuestions) {
    ctx.on('user-questions/request', (request, next) => {
      ctx.emit('pixies/interaction', {
        kind: 'question',
        sessionId: request.agent?.id ?? '',
        summary: request.questions[0]?.question ?? '',
      })
      return next()
    })
  }
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    const presentation = presentationFromAssistantMessage(session.id, event.seq, event.data)
    if (presentation === null) return
    service.present(presentation)
  })
  // Shell-only page injection: turn the standard web client page into the
  // character surface when this host belongs to the pixies Electron shell.
  if (process.env[PIXIES_SHELL_ENV] === '1') {
    ctx.on('webserver/index-inject', (table) => {
      table.push(...pixiesIndexInjections(true))
    })
  }
}
