/**
 * Pointer-driven window-drag hook for the Pixies shell: tracks pointerdown on
 * a container, then forwards screen-space deltas as window-relative moves via
 * the shell bridge. Deltas are measured in `screenX/screenY` — the host moves
 * the window under a stationary cursor while dragging, so window-relative
 * `clientX/clientY` deltas cancel themselves out and freeze the drag after the
 * first hop. A small threshold keeps taps (expand, collapse, send) distinct
 * from drags, and the click right after a real drag is swallowed.
 * @module @deepseek-ai/dsh-pixies/client/window-drag
 */
import { useCallback, useEffect, useRef, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import type { PixiesShellBridge } from './shell.tsx'

/** Movement in screen pixels before a press becomes a drag. */
export const PIXIES_DRAG_THRESHOLD = 4

/** True when `target` has already captured `pointerId`. */
function isPointerCaptured(target: Element, pointerId: number): boolean {
  // Test fakes (and older Chromium builds) may lack the capture query; treat
  // that as "not captured" so setPointerCapture is still attempted.
  const method: unknown = Reflect.get(target, 'hasPointerCapture')
  if (typeof method !== 'function') return false
  return (method as (id: number) => boolean).call(target, pointerId)
}

/** The pointer-event handlers to spread onto the draggable container. */
export interface PixiesDragHandlers {
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerCancel: (event: PointerEvent<HTMLElement>) => void
  /** Swallow the click that follows a drag so it cannot trigger a button. */
  readonly onClickCapture: (event: MouseEvent<HTMLElement>) => void
}

/** Result of `usePixiesWindowDrag`: props to spread + a `move` cursor. */
export interface PixiesWindowDrag {
  readonly containerProps: PixiesDragHandlers & { readonly style: CSSProperties }
}

/**
 * Wire pointer events to the shell bridge. Any movement beyond the threshold
 * while a pointer is down is forwarded as a window-relative delta; the full
 * pre-threshold movement is delivered in the first event so the window never
 * lags behind the cursor. Pointer capture is taken only once a drag commits,
 * which lets clickable children inside the container receive ordinary taps.
 *
 * @param bridge - the optional Electron shell bridge.
 * @returns the props to spread onto the draggable container.
 */
export function usePixiesWindowDrag(bridge: PixiesShellBridge | undefined): PixiesWindowDrag {
  const activePointer = useRef<number | null>(null)
  const captureTarget = useRef<HTMLElement | null>(null)
  const lastX = useRef(0)
  const lastY = useRef(0)
  const pending = useRef({ dx: 0, dy: 0 })
  const dragged = useRef(false)
  const suppressClick = useRef(false)

  const finish = useCallback((): void => {
    if (dragged.current) {
      suppressClick.current = true
      bridge?.endDrag?.()
    }
    const target = captureTarget.current
    const pointer = activePointer.current
    if (target !== null && pointer !== null) {
      try { target.releasePointerCapture(pointer) } catch { /* not captured */ }
    }
    activePointer.current = null
    captureTarget.current = null
    dragged.current = false
    pending.current = { dx: 0, dy: 0 }
  }, [bridge])

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>): void => {
    if (bridge === undefined || event.button !== 0) return
    // A new press clears a stale suppression from a drag whose click never
    // arrived (the pointer was released outside the window).
    suppressClick.current = false
    dragged.current = false
    pending.current = { dx: 0, dy: 0 }
    activePointer.current = event.pointerId
    lastX.current = event.screenX
    lastY.current = event.screenY
    captureTarget.current = event.currentTarget
  }, [bridge])

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>): void => {
    if (bridge === undefined || activePointer.current !== event.pointerId) return
    const dx = event.screenX - lastX.current
    const dy = event.screenY - lastY.current
    lastX.current = event.screenX
    lastY.current = event.screenY
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return

    let stepX = dx
    let stepY = dy
    if (!dragged.current) {
      pending.current.dx += dx
      pending.current.dy += dy
      if (Math.hypot(pending.current.dx, pending.current.dy) < PIXIES_DRAG_THRESHOLD) return
      stepX = pending.current.dx
      stepY = pending.current.dy
      pending.current = { dx: 0, dy: 0 }
      dragged.current = true
    } else if (stepX === 0 && stepY === 0) {
      return
    }
    const target = captureTarget.current
    if (target !== null && !isPointerCaptured(target, event.pointerId)) {
      try { target.setPointerCapture(event.pointerId) } catch { /* ignore */ }
    }
    bridge.dragBy(stepX, stepY)
  }, [bridge])

  const onPointerUp = useCallback((): void => { finish() }, [finish])
  const onPointerCancel = useCallback((): void => { finish() }, [finish])
  const onClickCapture = useCallback((event: MouseEvent<HTMLElement>): void => {
    if (!suppressClick.current) return
    suppressClick.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  // Defensive: window-level fallbacks for pointer capture loss. With capture
  // these rarely fire, but if Electron drops capture during a focus change
  // the drag still ends cleanly instead of stranding the window mid-flight.
  useEffect(() => {
    const end = (): void => { finish() }
    window.addEventListener('blur', end)
    window.addEventListener('pointerup', end)
    return () => {
      window.removeEventListener('blur', end)
      window.removeEventListener('pointerup', end)
    }
  }, [finish])

  return {
    containerProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClickCapture,
      style: { cursor: 'move', touchAction: 'none' },
    },
  }
}
