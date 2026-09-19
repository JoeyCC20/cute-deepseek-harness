/**
 * Window-drag hook tests (test-validation phase7 method 1): pointer events
 * translate into window-relative deltas forwarded through the shell bridge.
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PixiesShellBridge } from '../../src/client/shell.tsx'
import { usePixiesWindowDrag } from '../../src/client/window-drag.ts'

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
    dragBy: dragBy as unknown as (deltaX: number, deltaY: number) => void,
    onSpeech: vi.fn() as unknown as PixiesShellBridge['onSpeech'],
    onMode: vi.fn() as unknown as PixiesShellBridge['onMode'],
  }
  return { bridge, dragBy }
}

function fakePointerEvent(type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', clientX: number, clientY: number, button = 0): React.PointerEvent<HTMLElement> {
  const target = {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  } as unknown as HTMLElement
  return {
    type,
    pointerId: 1,
    clientX,
    clientY,
    button,
    currentTarget: target,
    target,
  } as unknown as React.PointerEvent<HTMLElement>
}

describe('usePixiesWindowDrag', () => {
  it('forwards pointermove deltas as window-relative moves', () => {
    const { bridge, dragBy } = fakeBridge()
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', 100, 100))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', 108, 105))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', 100, 95))
    })
    expect(dragBy).toHaveBeenNthCalledWith(1, 8, 5)
    expect(dragBy).toHaveBeenNthCalledWith(2, -8, -10)
  })

  it('skips zero-delta moves', () => {
    const { bridge, dragBy } = fakeBridge()
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', 100, 100))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', 100, 100))
    })
    expect(dragBy).not.toHaveBeenCalled()
  })

  it('ends the drag on pointerup and ignores later moves', () => {
    const { bridge, dragBy } = fakeBridge()
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', 100, 100))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', 110, 100))
    })
    act(() => {
      result.current.containerProps.onPointerUp(fakePointerEvent('pointerup', 110, 100))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', 200, 200))
    })
    expect(dragBy).toHaveBeenCalledTimes(1)
  })

  it('ignores non-primary buttons on pointerdown', () => {
    const { bridge, dragBy } = fakeBridge()
    const { result } = renderHook(() => usePixiesWindowDrag(bridge))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', 100, 100, 1))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', 110, 100))
    })
    expect(dragBy).not.toHaveBeenCalled()
  })

  it('does nothing when the bridge is absent', () => {
    const { result } = renderHook(() => usePixiesWindowDrag(undefined))
    act(() => {
      result.current.containerProps.onPointerDown(fakePointerEvent('pointerdown', 100, 100))
    })
    act(() => {
      result.current.containerProps.onPointerMove(fakePointerEvent('pointermove', 200, 200))
    })
    // No assertion on bridge calls — the absence of one is the contract.
    expect(result.current.containerProps.style.cursor).toBe('move')
  })
})
