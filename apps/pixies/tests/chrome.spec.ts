/**
 * Facade tests for the tray chrome (test-validation method 3): window
 * geometry, tray toggle, shortcut registration, and disposal — all against
 * injected fakes, no Electron display required.
 */
import { describe, expect, it, vi } from 'vitest'
import { clampPositionToWorkArea, createPixiesChrome, topRightPosition } from '../src/chrome.ts'
import type { PixiesChromeDeps, PixiesTrayLike, PixiesWindowLike } from '../src/chrome.ts'

interface WindowState {
  visible: boolean
  destroyed: boolean
  x: number
  y: number
  width: number
  height: number
}

function fakeWindow(): { window: PixiesWindowLike; state: WindowState } {
  const state: WindowState = { visible: false, destroyed: false, x: 0, y: 0, width: 0, height: 0 }
  const window: PixiesWindowLike = {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    show: () => { state.visible = true },
    hide: () => { state.visible = false },
    focus: vi.fn(),
    setPosition: (x, y) => { state.x = x; state.y = y },
    setSize: (width, height) => { state.width = width; state.height = height },
    getBounds: () => ({ x: state.x, y: state.y, width: state.width, height: state.height }),
    loadURL: vi.fn(async () => {}),
    once: vi.fn(),
  }
  return { window, state }
}

interface TrayState {
  tooltip: string
  click: () => void
  destroyed: boolean
}

function fakeTray(): { tray: PixiesTrayLike; state: TrayState } {
  const state: TrayState = { tooltip: '', click: () => {}, destroyed: false }
  const tray: PixiesTrayLike = {
    setToolTip: (tooltip) => { state.tooltip = tooltip },
    on: (event, listener) => { if (event === 'click') state.click = listener },
    destroy: () => { state.destroyed = true },
  }
  return { tray, state }
}

interface ShortcutState {
  registered: boolean
  accelerator: string
  callback: () => void
}

function bench(): {
  deps: PixiesChromeDeps
  windowState: WindowState
  trayState: TrayState
  shortcutState: ShortcutState
} {
  const { window, state: windowState } = fakeWindow()
  const { tray, state: trayState } = fakeTray()
  const shortcutState: ShortcutState = { registered: false, accelerator: '', callback: () => {} }
  const deps: PixiesChromeDeps = {
    createWindow: vi.fn(() => window),
    createTray: vi.fn(() => tray),
    registerShortcut: vi.fn((accelerator, callback) => {
      shortcutState.registered = true
      shortcutState.accelerator = accelerator
      shortcutState.callback = callback
      return true
    }),
    unregisterShortcut: vi.fn(() => { shortcutState.registered = false }),
    workArea: () => ({ width: 1440, height: 900 }),
  }
  return { deps, windowState, trayState, shortcutState }
}

describe('topRightPosition', () => {
  it('places the window at the work-area top-right with the given margin', () => {
    expect(topRightPosition({ width: 420, height: 640 }, { width: 1440, height: 900 }, 12))
      .toEqual({ x: 1008, y: 12 })
  })

  it('clamps negative coordinates to zero for oversized windows', () => {
    expect(topRightPosition({ width: 2000, height: 300 }, { width: 1440, height: 900 }, 12))
      .toEqual({ x: 0, y: 12 })
    expect(topRightPosition({ width: 420, height: 2000 }, { width: 1440, height: 900 }, 12))
      .toEqual({ x: 1008, y: 12 })
  })
})

describe('createPixiesChrome', () => {
  it('sizes the window to the top-right position and sets the tray tooltip', () => {
    const { deps, windowState, trayState } = bench()
    const chrome = createPixiesChrome(deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
    })

    expect(windowState.width).toBe(420)
    expect(windowState.height).toBe(640)
    expect(windowState.x).toBe(1008)
    expect(windowState.y).toBe(12)
    expect(trayState.tooltip).toBe('Pixies')
    expect(chrome.shortcutRegistered).toBe(true)
  })

  it('registers the shortcut and wires the tray click to toggle visibility', () => {
    const { deps, windowState, shortcutState, trayState } = bench()
    const chrome = createPixiesChrome(deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
    })

    expect(shortcutState.accelerator).toBe('CommandOrControl+Shift+P')
    expect(windowState.visible).toBe(false)

    trayState.click() // tray click: hidden → shown
    expect(windowState.visible).toBe(true)
    trayState.click() // tray click: shown → hidden
    expect(windowState.visible).toBe(false)

    shortcutState.callback() // shortcut always shows
    expect(windowState.visible).toBe(true)

    chrome.hide()
    expect(windowState.visible).toBe(false)
    chrome.show()
    expect(windowState.visible).toBe(true)
  })

  it('dispose unregisters the shortcut and destroys the tray', () => {
    const { deps, shortcutState, trayState } = bench()
    const chrome = createPixiesChrome(deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
    })

    chrome.dispose()

    expect(shortcutState.registered).toBe(false)
    expect(trayState.destroyed).toBe(true)
  })
})

describe('mini/expanded modes (phase 3)', () => {
  it('computes the mini corner geometry with zero margin', () => {
    expect(topRightPosition({ width: 96, height: 96 }, { width: 1440, height: 900 }, 0))
      .toEqual({ x: 1344, y: 0 })
  })

  it('starts mini and swaps geometry through setMode', () => {
    const { deps, windowState } = bench()
    const chrome = createPixiesChrome(deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
      miniSize: { width: 96, height: 96 },
      miniMargin: 0,
      initialMode: 'mini',
    })

    expect(chrome.mode).toBe('mini')
    expect(windowState.width).toBe(96)
    expect(windowState.height).toBe(96)
    expect(windowState.x).toBe(1344)
    expect(windowState.y).toBe(0)

    chrome.setMode('expanded')
    expect(chrome.mode).toBe('expanded')
    expect(windowState.width).toBe(420)
    expect(windowState.height).toBe(640)
    expect(windowState.x).toBe(1008)
    expect(windowState.y).toBe(12)

    chrome.setMode('expanded') // same mode: geometry untouched
    expect(windowState.x).toBe(1008)

    chrome.setMode('mini')
    expect(chrome.mode).toBe('mini')
    expect(windowState.width).toBe(96)
    expect(windowState.height).toBe(96)
    expect(windowState.x).toBe(1344)
    expect(windowState.y).toBe(0)
  })

  it('defaults to expanded and falls back to the full size for mini without options', () => {
    const { deps, windowState } = bench()
    const chrome = createPixiesChrome(deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
    })

    expect(chrome.mode).toBe('expanded')
    expect(windowState.width).toBe(420)

    chrome.setMode('mini')
    expect(chrome.mode).toBe('mini')
    expect(windowState.width).toBe(420)
    expect(windowState.height).toBe(640)
    expect(windowState.x).toBe(1008)
    expect(windowState.y).toBe(12)
  })
})

describe('clampPositionToWorkArea', () => {
  it('keeps positions inside the work area untouched', () => {
    expect(clampPositionToWorkArea({ x: 100, y: 100 }, { width: 420, height: 640 }, { width: 1440, height: 900 }))
      .toEqual({ x: 100, y: 100 })
  })

  it('clamps negative positions to zero', () => {
    expect(clampPositionToWorkArea({ x: -50, y: -10 }, { width: 420, height: 640 }, { width: 1440, height: 900 }))
      .toEqual({ x: 0, y: 0 })
  })

  it('pins the window edge when dragged past the screen edge', () => {
    expect(clampPositionToWorkArea({ x: 1500, y: 800 }, { width: 420, height: 640 }, { width: 1440, height: 900 }))
      .toEqual({ x: 1020, y: 260 })
  })
})

describe('dragBy (phase 7)', () => {
  it('moves the window by the delta and clamps to the work area', () => {
    const { deps, windowState } = bench()
    const chrome = createPixiesChrome(deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
      miniSize: { width: 96, height: 96 },
      miniMargin: 0,
      initialMode: 'mini',
    })
    // initial mini top-right: x=1344, y=0
    chrome.dragBy(-100, 50)
    expect(windowState.x).toBe(1244)
    expect(windowState.y).toBe(50)
    chrome.dragBy(10_000, 10_000) // far past the edge: clamped
    expect(windowState.x).toBe(1344)
    expect(windowState.y).toBe(804)
  })

  it('emits onDragged with the new position', () => {
    const { deps, windowState } = bench()
    const seen: Array<{ mode: string; x: number; y: number }> = []
    const chrome = createPixiesChrome(deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
      miniSize: { width: 96, height: 96 },
      miniMargin: 0,
      initialMode: 'mini',
      onDragged: (position) => { seen.push({ mode: position.mode, x: position.x, y: position.y }) },
    })
    chrome.dragBy(-20, 10)
    expect(seen.at(-1)).toEqual({ mode: 'mini', x: windowState.x, y: windowState.y })
  })

  it('restores a saved position on creation and keeps it per mode', () => {
    const { deps, windowState } = bench()
    const chrome = createPixiesChrome(deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
      miniSize: { width: 96, height: 96 },
      miniMargin: 0,
      initialMode: 'mini',
      initialPosition: {
        mini: { x: 200, y: 200 },
        expanded: { x: 80, y: 80 },
      },
    })
    expect(chrome.mode).toBe('mini')
    expect(windowState.x).toBe(200)
    expect(windowState.y).toBe(200)

    chrome.setMode('expanded')
    expect(windowState.x).toBe(80)
    expect(windowState.y).toBe(80)

    chrome.setMode('mini')
    expect(windowState.x).toBe(200)
    expect(windowState.y).toBe(200)
  })
})
