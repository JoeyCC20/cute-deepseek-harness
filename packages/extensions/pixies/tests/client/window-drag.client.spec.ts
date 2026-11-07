/**
 * Window-drag hook tests (test-validation phase7 method 1, phase10 revision):
 * pointer events translate into SCREEN-SPACE deltas forwarded through the
 * shell bridge. Screen coordinates are invariant to window movement — the
 * host moves the window under a stationary cursor while dragging, so
 * client-space deltas cancel themselves out and freeze the drag (the phase10
 * field bug).
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PIXIES_DRAG_THRESHOLD, usePixiesWindowDrag } from '../../src/client/window-drag.ts'
import type { PixiesShellBridge } from '../../src/client/shell.tsx'

afterEach(() => {
  vi.restoreAllMocks()
})

function fakeBridge(): { bridge: PixiesShellBridge; dragBy: ReturnType<typeof vi.fn> } {
  const dragBy = vi.fn()
  const bridge: PixiesShellBridge = {
    expand: vi.fn(),
    collapse: vi.fn(),
    startSpeech: vi.fn(),
    stopSpeech: vi.fn(),
    dragBy: dragBy,
    onSpeech: vi.fn(),
    onMode: vi.fn(),
  }
  return { bridge, dragBy }
}

function fakePointerEvent(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  screen: { x: number; y: number },
  client?: { x: number; y: number },
  button = 0,
): React.PointerEvent<HTMLElement> {
  const target = {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  } as unknown as HTMLElement
  return {
    type,
    pointerId: 1,
    screenX: screen.x,
    screenY: screen.y,
    clientX: client?.x ?? screen.x,
    clientY: client?.y ?? screen.y,
    button,
    currentTarget: target,
    target,
  } as unknown as React.PointerEvent<HTMLElement>
}

describe('usePixiesWindowDrag', () => {
  it('forwards screen-space pointer deltas through the bridge', () => {
    const { bridge, dragBy } = fakeBridge()
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', { x: 1400, y: 100 }))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', { x: 1408, y: 105 }))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', { x: 1400, y: 95 }))
    })
    expect(dragBy).toHaveBeenNthCalledWith(1, 8, 5)
    expect(dragBy).toHaveBeenNthCalledWith(2, -8, -10)
  })

  it('keeps dragging while the window moves under the cursor (phase10 regression)', () => {
    // The host applies each dragBy immediately, so the next OS pointermove
    // reports the SAME clientX (the window shifted under the pointer) while
    // screenX keeps growing with the physical mouse. Client-space deltas
    // cancel to zero here — screen-space deltas must not.
    const { bridge, dragBy } = fakeBridge()
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(
        fakePointerEvent('pointerdown', { x: 1400, y: 100 }, { x: 48, y: 48 }),
      )
    })
    act(() => {
      result.current.containerProps.onPointerMove(
        fakePointerEvent('pointermove', { x: 1408, y: 100 }, { x: 48, y: 48 }),
      )
    })
    act(() => {
      result.current.containerProps.onPointerMove(
        fakePointerEvent('pointermove', { x: 1416, y: 100 }, { x: 48, y: 48 }),
      )
    })
    expect(dragBy).toHaveBeenNthCalledWith(1, 8, 0)
    expect(dragBy).toHaveBeenNthCalledWith(2, 8, 0)
  })

  it('ignores moves whose screen deltas are not finite', () => {
    const { bridge, dragBy } = fakeBridge()
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', { x: 1400, y: 100 }))
    })
    const broken = { type: 'pointermove', pointerId: 1, screenX: undefined, screenY: undefined, button: 0 } as unknown as React.PointerEvent<HTMLElement>
    const target = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() } as unknown as HTMLElement
    ;(broken as { currentTarget: Element }).currentTarget = target
    act(() => {
      result.current.containerProps.onPointerMove(broken)
    })
    expect(dragBy).not.toHaveBeenCalled()
  })

  it('skips zero-delta moves', () => {
    const { bridge, dragBy } = fakeBridge()
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', { x: 1400, y: 100 }))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', { x: 1400, y: 100 }))
    })
    expect(dragBy).not.toHaveBeenCalled()
  })

  it('ends the drag on pointerup and ignores later moves', () => {
    const { bridge, dragBy } = fakeBridge()
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', { x: 1400, y: 100 }))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', { x: 1410, y: 100 }))
    })
    act(() => {
      result.current.containerProps.onPointerUp(fakePointerEvent('pointerup', { x: 1410, y: 100 }))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', { x: 1500, y: 200 }))
    })
    expect(dragBy).toHaveBeenCalledTimes(1)
  })

  it('ignores non-primary buttons on pointerdown', () => {
    const { bridge, dragBy } = fakeBridge()
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', { x: 1400, y: 100 }, undefined, 1))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', { x: 1410, y: 100 }))
    })
    expect(dragBy).not.toHaveBeenCalled()
  })

  it('does nothing when the bridge is absent', () => {
    const { result } = renderHook(() => usePixiesWindowDrag(undefined))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', { x: 1400, y: 100 }))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', { x: 1500, y: 200 }))
    })
    // No assertion on bridge calls — the absence of one is the contract.
    expect(result.current.containerProps.style.cursor).toBe('move')
  })

  it('waits for the tap threshold, then delivers the whole pre-threshold movement', () => {
    const { bridge, dragBy } = fakeBridge()
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', { x: 100, y: 100 }))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', { x: 102, y: 100 }))
    })
    expect(dragBy).not.toHaveBeenCalled()
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', { x: 106, y: 103 }))
    })
    expect(PIXIES_DRAG_THRESHOLD).toBeGreaterThan(2)
    expect(dragBy).toHaveBeenCalledTimes(1)
    expect(dragBy).toHaveBeenCalledWith(6, 3)
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', { x: 111, y: 103 }))
    })
    expect(dragBy).toHaveBeenNthCalledWith(2, 5, 0)
  })

  it('reports one drag end and swallows the click that follows a real drag', () => {
    const base = fakeBridge()
    const endDrag = vi.fn()
    const bridge: PixiesShellBridge = { ...base.bridge, endDrag }
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', { x: 100, y: 100 }))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', { x: 120, y: 100 }))
    })
    act(() => {
      result.current.containerProps.onPointerUp(fakePointerEvent('pointerup', { x: 120, y: 100 }))
    })
    expect(endDrag).toHaveBeenCalledTimes(1)
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    act(() => {
      result.current.containerProps.onClickCapture({ preventDefault, stopPropagation } as unknown as React.MouseEvent<HTMLElement>)
    })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    // The next ordinary tap is not swallowed.
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', { x: 100, y: 100 }))
      result.current.containerProps.onPointerUp(fakePointerEvent('pointerup', { x: 100, y: 100 }))
      result.current.containerProps.onClickCapture({ preventDefault, stopPropagation } as unknown as React.MouseEvent<HTMLElement>)
    })
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('never starts a drag for a pure tap, leaving buttons clickable', () => {
    const base = fakeBridge()
    const endDrag = vi.fn()
    const bridge: PixiesShellBridge = { ...base.bridge, endDrag }
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', { x: 100, y: 100 }))
      result.current.containerProps.onPointerUp(fakePointerEvent('pointerup', { x: 100, y: 100 }))
    })
    expect(base.dragBy).not.toHaveBeenCalled()
    expect(endDrag).not.toHaveBeenCalled()
  })
})
