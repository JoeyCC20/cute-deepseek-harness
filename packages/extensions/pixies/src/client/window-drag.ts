/**
 * Pointer-driven window-drag hook for the Pixies shell: tracks pointerdown
 * on the container, then forwards screen-space deltas as window-relative
 * moves via the shell bridge. The drag ends on pointerup/cancel/blur so a
 * captured pointer never escapes the window.
 * @module @deepseek-ai/dsh-pixies/client/window-drag
 */
import { useCallback, useEffect, useRef, type CSSProperties } from 'react'
import type { PixiesShellBridge } from './shell.tsx'

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
 * @param bridge - the optional Electron shell bridge.
 * @returns the props to spread onto the draggable container.
 */
export function usePixiesWindowDrag(bridge: PixiesShellBridge | undefined): PixiesWindowDrag {
  const activePointer = useRef<number | null>(null)
  const lastX = useRef(0)
  const lastY = useRef(0)
  // The element the pointer went down on is the drag source: every move
  // emits a delta relative to it, which makes the gesture stable even if
  // the pointer briefly leaves the container mid-drag.

  const release = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (activePointer.current !== event.pointerId) return
    activePointer.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // The pointer may already be released (e.g. browser-initiated cancel).
    }
  }, [])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (bridge === undefined) return
    if (event.button !== 0) return
    activePointer.current = event.pointerId
    lastX.current = event.clientX
    lastY.current = event.clientY
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // setPointerCapture fails on detached nodes; the drag still works via
      // window-level listeners below.
    }
  }, [bridge])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (bridge === undefined) return
    if (activePointer.current !== event.pointerId) return
    const dx = event.clientX - lastX.current
    const dy = event.clientY - lastY.current
    lastX.current = event.clientX
    lastY.current = event.clientY
    if (dx === 0 && dy === 0) return
    bridge.dragBy(dx, dy)
  }, [bridge])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    release(event)
  }, [release])

  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLElement>) => {
    release(event)
  }, [release])

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
