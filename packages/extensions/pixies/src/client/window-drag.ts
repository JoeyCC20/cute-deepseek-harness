/**
 * Pointer-driven window-drag hook for the Pixies shell: tracks pointerdown
 * on the container, then forwards screen-space deltas as window-relative
 * moves via the shell bridge. The drag ends on pointerup/cancel/blur so a
 * captured pointer never escapes the window.
 * @module @deepseek-ai/dsh-pixies/client/window-drag
 */
import { useCallback, useEffect, useRef, type CSSProperties } from 'react'
import type { PixiesShellBridge } from './shell.tsx'

/** True when `target` has already captured `pointerId`. */
function isPointerCaptured(target: Element, pointerId: number): boolean {
  // `hasPointerCapture` is on Element & HTMLElement in modern Chromium; if
  // the renderer runs an older runtime that omits it we fall back to "not
  // captured" and let the upcoming `setPointerCapture` call handle it.
  const candidate = target as Element & { hasPointerCapture?: (id: number) => boolean }
  return candidate.hasPointerCapture?.(pointerId) ?? false
}

/** The pointer-event handlers to spread onto the draggable container. */
export interface PixiesDragHandlers {
  readonly onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
  readonly onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
  readonly onPointerUp: (event: React.PointerEvent<HTMLElement>) => void
  readonly onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void
}

/** Result of `usePixiesWindowDrag`: props to spread + a `move` cursor. */
export interface PixiesWindowDrag {
  readonly containerProps: PixiesDragHandlers & { readonly style: CSSProperties }
}

/**
 * Wire pointer events to the shell bridge: any movement while a pointer is
 * down is forwarded as a window-relative delta. The bridge is the no-op
 * surface outside the Electron shell, so plain web pages remain harmless.
 *
 * The hook coexists with clickable children (e.g. the expand button sitting
 * inside the same drag container in mini mode). `setPointerCapture` is
 * deferred until the first real movement: a quick tap with no move releases
 * cleanly and never captures, so the inner element's click handler still
 * fires. Once the pointer moves, capture is taken on the next move and the
 * gesture is committed to dragging.
 *
 * @param bridge - the optional Electron shell bridge.
 * @returns the props to spread onto the draggable container.
 */
export function usePixiesWindowDrag(bridge: PixiesShellBridge | undefined): PixiesWindowDrag {
  const activePointer = useRef<number | null>(null)
  const captureTarget = useRef<HTMLElement | null>(null)
  const lastX = useRef(0)
  const lastY = useRef(0)

  const releaseCapture = (): void => {
    const target = captureTarget.current
    if (target !== null) {
      try { target.releasePointerCapture(activePointer.current ?? -1) } catch { /* not captured */ }
    }
    activePointer.current = null
    captureTarget.current = null
  }

  const release = useCallback(() => { releaseCapture() }, [])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (bridge === undefined) return
    if (event.button !== 0) return
    // Defer pointer capture until we observe a real move. This way a quick
    // tap (no movement) lets inner clickable children — most importantly
    // the mini-mode expand button — receive their click without the outer
    // container swallowing the pointer.
    activePointer.current = event.pointerId
    lastX.current = event.clientX
    lastY.current = event.clientY
    captureTarget.current = event.currentTarget
  }, [bridge])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (bridge === undefined) return
    if (activePointer.current !== event.pointerId) return
    const dx = event.clientX - lastX.current
    const dy = event.clientY - lastY.current
    lastX.current = event.clientX
    lastY.current = event.clientY
    if (dx === 0 && dy === 0) return
    // First real movement commits the gesture to drag: take pointer capture
    // on the original pointerdown element so the gesture stays stable even
    // if the pointer leaves the container.
    if (captureTarget.current !== null && !isPointerCaptured(captureTarget.current, event.pointerId)) {
      try { captureTarget.current.setPointerCapture(event.pointerId) } catch { /* ignore */ }
    }
    bridge.dragBy(dx, dy)
  }, [bridge])

  const onPointerUp = useCallback(() => { release() }, [release])
  const onPointerCancel = useCallback(() => { release() }, [release])

  // Defensive: window-level fallbacks for pointer capture loss. With capture
  // these rarely fire, but if Electron drops capture during a focus change
  // the drag still ends cleanly instead of stranding the window mid-flight.
  useEffect(() => {
    const end = (): void => { activePointer.current = null }
    window.addEventListener('blur', end)
    window.addEventListener('pointerup', end)
    return () => {
      window.removeEventListener('blur', end)
      window.removeEventListener('pointerup', end)
    }
  }, [])

  return {
    containerProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      style: { cursor: 'move' },
    },
  }
}

// Re-export so callers can identify the hook by symbol if needed.
export const PIXIES_WINDOW_DRAG_RESERVED = Symbol('pixies-window-drag')
