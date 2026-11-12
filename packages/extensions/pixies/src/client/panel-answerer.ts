/**
 * Claim the forwarded `user-questions/request` waterfall on behalf of the
 * standalone result panel. A non-interactive panel is acknowledged at once
 * but stays rendered until the next result; a choice panel waits for the
 * human's selection. Only the panel window mounts this controller.
 * @module @deepseek-ai/dsh-pixies/client/panel-answerer
 */

import { decodePanelDetail, type PixiesPanelPayload } from '@deepseek-ai/dsh-pixies-panel/types'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types'

/** Minimal shape the panel needs from a forwarded question request. */
export interface PixiesPanelQuestionRequest {
  readonly questions: readonly AskUserQuestionItem[]
}

/** One panel currently rendered in the window. */
export interface PendingPanelQuestion {
  /** Normalized panel payload decoded from the question detail. */
  readonly payload: PixiesPanelPayload
  /** Original request, whose choice questions supply ids and option labels. */
  readonly request: PixiesPanelQuestionRequest
}

/** Immutable view the panel component subscribes to. */
export interface PixiesPanelSnapshot {
  readonly pending: PendingPanelQuestion | undefined
  /** True while a choice answer is still awaited. */
  readonly awaitingAnswer: boolean
}

/** Bridge between the remote waterfall and the in-window panel component. */
export interface PixiesPanelController {
  /** Current view for `useSyncExternalStore`-style subscriptions. */
  readonly getSnapshot: () => PixiesPanelSnapshot
  /** Subscribe to panel changes. */
  readonly subscribe: (listener: () => void) => () => void
  /** Claim a panel-owned request; `undefined` means delegate with `next()`. */
  readonly claim: (request: PixiesPanelQuestionRequest) => Promise<AskUserQuestionAnswer> | undefined
  /** Deliver a human answer to the pending choice panel. */
  readonly submit: (answer: AskUserQuestionAnswer) => void
  /** Drop every pending answer, e.g. on plugin teardown. */
  readonly dispose: () => void
}

/** One pending promise the controller owns while a choice is unanswered. */
interface PendingAnswer {
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (reason: Error) => void
}

/**
 * Create one controller for one panel window.
 * @param onShow - called once per claimed result so the Electron shell can
 * wake the window and start (or skip) its auto-hide timer.
 * @returns the controller.
 */
export function createPixiesPanelController(
  onShow: (payload: PixiesPanelPayload) => void,
): PixiesPanelController {
  let pending: PendingPanelQuestion | undefined
  let answer: PendingAnswer | undefined
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const failPending = (reason: Error): void => {
    const current = answer
    answer = undefined
    current?.reject(reason)
  }

  return {
    getSnapshot: () => ({ pending, awaitingAnswer: answer !== undefined }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    claim: (request) => {
      const payload = decodePanelDetail(request)
      if (payload === undefined) return undefined
      failPending(new Error('superseded by a newer result panel'))
      pending = { payload, request }
      notify()
      onShow(payload)
      if (!payload.interactive) return Promise.resolve({ answers: [] })
      return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
        answer = { resolve, reject }
        notify()
      })
    },
    submit: (value) => {
      const current = answer
      answer = undefined
      notify()
      current?.resolve(value)
    },
    dispose: () => {
      failPending(new Error('pixies result panel disposed'))
      pending = undefined
      notify()
      listeners.clear()
    },
  }
}
