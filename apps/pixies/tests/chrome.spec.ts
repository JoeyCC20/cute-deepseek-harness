/**
 * Facade tests for the tray chrome (test-validation method 3): window
 * geometry, tray toggle, shortcut registration, and disposal — all against
 * injected fakes, no Electron display required.
 */
import { describe, expect, it, vi } from 'vitest'
import { clampPositionToWorkArea, createPixiesChrome, nextConversationMode, topRightPosition, unionWorkArea } from '../src/chrome.ts'
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
  registrations: Array<{ accelerator: string; callback: () => void }>
  unregistered: string[]
}

function bench(): {
  deps: PixiesChromeDeps
  windowState: WindowState
  trayState: TrayState
  shortcutState: ShortcutState
} {
  const { window, state: windowState } = fakeWindow()
  const { tray, state: trayState } = fakeTray()
  const shortcutState: ShortcutState = {
    registered: false,
    accelerator: '',
    callback: () => {},
    registrations: [],
    unregistered: [],
  }
  const deps: PixiesChromeDeps = {
    createWindow: vi.fn(() => window),
    createTray: vi.fn(() => tray),
    registerShortcut: vi.fn((accelerator: string, callback: () => void) => {
      shortcutState.registered = true
      shortcutState.accelerator = accelerator
      shortcutState.callback = callback
      shortcutState.registrations.push({ accelerator, callback })
      return true
    }),
    unregisterShortcut: vi.fn((accelerator: string) => {
      shortcutState.registered = false
      shortcutState.unregistered.push(accelerator)
    }),
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

    // A mode change grows/shrinks around the avatar the user placed, instead
    // of teleporting back to the default corner.
    chrome.setMode('expanded')
    expect(chrome.mode).toBe('expanded')
    expect(windowState.width).toBe(420)
    expect(windowState.height).toBe(640)
    expect(windowState.x).toBe(1020)
    expect(windowState.y).toBe(0)

    chrome.setMode('expanded') // same mode: geometry untouched
    expect(windowState.x).toBe(1020)

    chrome.setMode('mini')
    expect(chrome.mode).toBe('mini')
    expect(windowState.width).toBe(96)
    expect(windowState.height).toBe(96)
    expect(windowState.x).toBe(1182)
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

  it('rounds fractional drag deltas to integers before setPosition (phase10 regression)', () => {
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
    // Retina pointer deltas arrive fractional (e.g. -0.109375); Electron's
    // setPosition accepts only integers and throws "conversion failure" on
    // the fractional position, freezing the drag. dragBy must round.
    chrome.dragBy(-0.109375, 0.44140625)
    expect(Number.isInteger(windowState.x)).toBe(true)
    expect(Number.isInteger(windowState.y)).toBe(true)
    expect(windowState.x).toBe(1344) // Math.round(1344 - 0.109375)
    expect(windowState.y).toBe(0) // Math.round(0 + 0.44140625)
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

describe('multi-display geometry', () => {
  it('honors the work-area origin when placing the window', () => {
    expect(topRightPosition({ width: 96, height: 96 }, { x: -1440, y: 25, width: 1440, height: 875 }, 8))
      .toEqual({ x: -104, y: 33 })
  })

  it('keeps negative coordinates on a display left of the primary', () => {
    expect(clampPositionToWorkArea(
      { x: -900, y: 120 }, { width: 96, height: 96 }, { x: -1440, y: 0, width: 2880, height: 900 },
    )).toEqual({ x: -900, y: 120 })
  })

  it('unions every display into one draggable bounding box', () => {
    expect(unionWorkArea([
      { x: 0, y: 25, width: 1440, height: 875 },
      { x: -1200, y: 0, width: 1200, height: 800 },
    ])).toEqual({ x: -1200, y: 0, width: 2640, height: 900 })
    expect(unionWorkArea([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('clamps drags against the combined displays, not just the primary', () => {
    const base = bench()
    const deps: PixiesChromeDeps = {
      ...base.deps,
      dragWorkArea: () => ({ x: -1440, y: 0, width: 2880, height: 900 }),
    }
    const chrome = createPixiesChrome(deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
      miniSize: { width: 96, height: 96 },
      miniMargin: 0,
      initialMode: 'mini',
    })
    chrome.dragBy(-5000, 100)
    expect(base.windowState.x).toBe(-1440)
    expect(base.windowState.y).toBe(100)
  })

  it('reports the final position once at the end of a drag', () => {
    const base = bench()
    const dragged: number[] = []
    const ended: Array<{ mode: string; x: number; y: number }> = []
    const chrome = createPixiesChrome(base.deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
      miniSize: { width: 96, height: 96 },
      miniMargin: 0,
      initialMode: 'mini',
      onDragged: () => { dragged.push(1) },
      onDragEnd: (position) => { ended.push({ mode: position.mode, x: position.x, y: position.y }) },
    })
    chrome.dragBy(-20, 10)
    chrome.dragBy(-20, 10)
    expect(dragged).toHaveLength(2)
    expect(ended).toEqual([])
    chrome.endDrag()
    expect(ended).toEqual([{ mode: 'mini', x: base.windowState.x, y: base.windowState.y }])
  })

  it('resetPosition forgets saved placement and returns to the default corner', () => {
    const base = bench()
    const placement: { mini?: { x: number; y: number }; expanded?: { x: number; y: number } } = {
      mini: { x: 200, y: 200 },
      expanded: { x: 80, y: 80 },
    }
    const chrome = createPixiesChrome(base.deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
      miniSize: { width: 96, height: 96 },
      miniMargin: 0,
      initialMode: 'mini',
      initialPosition: placement,
    })
    expect(base.windowState.x).toBe(200)
    chrome.resetPosition()
    expect(placement).toEqual({})
    expect(base.windowState.x).toBe(1344)
    expect(base.windowState.y).toBe(0)
  })
})

describe('extra global shortcuts (voice command / expand)', () => {
  const options = {
    accelerator: 'CommandOrControl+Shift+P',
    windowSize: { width: 420, height: 640 },
    screenMargin: 12,
    tooltip: 'Pixies',
  }

  it('registers, triggers, and disposes every owned shortcut', () => {
    const { deps, shortcutState, windowState, trayState } = bench()
    const chrome = createPixiesChrome(deps, options)
    const voiceCommand = vi.fn()
    const expand = vi.fn()
    expect(chrome.registerShortcut('CommandOrControl+Shift+J', voiceCommand)).toBe(true)
    expect(chrome.registerShortcut('CommandOrControl+Shift+K', expand)).toBe(true)

    expect(shortcutState.registrations.map(entry => entry.accelerator)).toEqual([
      'CommandOrControl+Shift+P', 'CommandOrControl+Shift+J', 'CommandOrControl+Shift+K',
    ])
    shortcutState.registrations[1]?.callback()
    shortcutState.registrations[2]?.callback()
    expect(voiceCommand).toHaveBeenCalledTimes(1)
    expect(expand).toHaveBeenCalledTimes(1)

    chrome.dispose()
    expect(shortcutState.unregistered).toEqual([
      'CommandOrControl+Shift+P', 'CommandOrControl+Shift+J', 'CommandOrControl+Shift+K',
    ])
    expect(trayState.destroyed).toBe(true)
    expect(windowState.visible).toBe(false)
  })

  it('reports a failed extra registration through shortcutRegistered', () => {
    const base = bench()
    const deps: PixiesChromeDeps = {
      ...base.deps,
      registerShortcut: vi.fn((accelerator: string) => accelerator !== 'CommandOrControl+Shift+K'),
    }
    const chrome = createPixiesChrome(deps, options)
    expect(chrome.shortcutRegistered).toBe(true)
    expect(chrome.registerShortcut('CommandOrControl+Shift+K', () => {})).toBe(false)
    expect(chrome.shortcutRegistered).toBe(false)
  })
})

describe('conversation shortcut toggle', () => {
  it('collapses only a visible expanded panel', () => {
    expect(nextConversationMode('expanded', true)).toBe('mini')
    expect(nextConversationMode('expanded', false)).toBe('expanded')
    expect(nextConversationMode('mini', true)).toBe('expanded')
    expect(nextConversationMode('mini', false)).toBe('expanded')
  })

  it('applies each returned mode to the window geometry', () => {
    const { deps, windowState } = bench()
    const chrome = createPixiesChrome(deps, {
      accelerator: 'CommandOrControl+Shift+P',
      windowSize: { width: 420, height: 640 },
      screenMargin: 12,
      tooltip: 'Pixies',
      miniSize: { width: 112, height: 112 },
      initialMode: 'mini',
    })
    expect(chrome.mode).toBe('mini')
    expect(windowState.width).toBe(112)

    chrome.setMode(nextConversationMode(chrome.mode, true))
    expect(chrome.mode).toBe('expanded')
    expect(windowState.width).toBe(420)

    chrome.setMode(nextConversationMode(chrome.mode, true))
    expect(chrome.mode).toBe('mini')
    expect(windowState.width).toBe(112)
  })
})
