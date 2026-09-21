/**
 * Facade-owned tray chrome for the Pixies shell: the frameless always-on-top
 * floating window, the menu-bar tray, and the global shortcut. Electron is
 * injected as narrow interfaces so the lifecycle is unit-testable without a
 * real display (the same facade pattern as `single-instance.ts`).
 * @module @deepseek-ai/dsh-pixies-app/chrome
 */

/** Window surface the chrome controller owns. */
export interface PixiesWindowLike {
  isDestroyed(): boolean
  isVisible(): boolean
  show(): void
  hide(): void
  focus(): void
  setPosition(x: number, y: number): void
  setSize(width: number, height: number): void
  /** Current window bounds in display coordinates; used to seed drag offsets. */
  getBounds(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  loadURL(url: string): Promise<void>
  once(event: 'closed', listener: () => void): void
}

/** Menu-bar tray surface the chrome controller owns. */
export interface PixiesTrayLike {
  setToolTip(tooltip: string): void
  on(event: 'click', listener: () => void): void
  destroy(): void
}

/** Injected Electron capabilities. */
export interface PixiesChromeDeps {
  readonly createWindow: () => PixiesWindowLike
  readonly createTray: () => PixiesTrayLike
  readonly registerShortcut: (accelerator: string, callback: () => void) => boolean
  readonly unregisterShortcut: (accelerator: string) => void
  readonly workArea: () => { readonly width: number; readonly height: number }
}

/** Chrome geometry and identity. */
export interface PixiesChromeOptions {
  /** Global shortcut that shows the floating window. */
  readonly accelerator: string
  /** Floating window size in CSS pixels. */
  readonly windowSize: { readonly width: number; readonly height: number }
  /** Distance from the screen work-area edges. */
  readonly screenMargin: number
  /** Tray tooltip text. */
  readonly tooltip: string
  /** The peeking mini-avatar size; defaults to `windowSize` (no mini mode). */
  readonly miniSize?: { readonly width: number; readonly height: number }
  /** Distance from the screen work-area edges in mini mode; defaults to `screenMargin`. */
  readonly miniMargin?: number
  /** The mode the chrome starts in; defaults to `expanded`. */
  readonly initialMode?: PixiesWindowMode
  /**
   * Last position the user dragged the window to (per mode). When supplied,
   * `createPixiesChrome` restores that position instead of recomputing it
   * from the screen margin — the user has chosen where Pixies should sit.
   */
  readonly initialPosition?: {
    readonly mini?: { readonly x: number; readonly y: number }
    readonly expanded?: { readonly x: number; readonly y: number }
  }
  /**
   * Called whenever the user drags the window to a new position; the chrome
   * does not know how to persist. Receives the mode that was active while
   * dragging and the new top-left in display coordinates.
   */
  readonly onDragged?: (position: { readonly mode: PixiesWindowMode; readonly x: number; readonly y: number }) => void
}

/** The two window modes: a corner mini avatar and the full panel. */
export type PixiesWindowMode = 'mini' | 'expanded'

/**
 * Compute the top-right placement of the floating window inside the screen
 * work area, clamped to non-negative coordinates.
 * @param windowSize - floating window dimensions.
 * @param workArea - the display's usable area.
 * @param margin - screen-edge margin.
 * @returns the window origin.
 */
export function topRightPosition(
  windowSize: { readonly width: number; readonly height: number },
  workArea: { readonly width: number; readonly height: number },
  margin: number,
): { readonly x: number; readonly y: number } {
  return {
    x: Math.max(0, workArea.width - windowSize.width - margin),
    y: Math.max(0, margin),
  }
}

/**
 * Clamp a desired position so the whole window stays inside the display
 * work area. Off-screen coordinates are pinned to the closest edge so a
 * dragged window can never be lost (a user with a 4K display who moves it
 * to a 1080p laptop screen would otherwise see the window vanish).
 * @param position - desired top-left.
 * @param size - the window dimensions.
 * @param workArea - the display's usable area.
 * @returns the clamped top-left.
 */
export function clampPositionToWorkArea(
  position: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  workArea: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  const maxX = Math.max(0, workArea.width - size.width)
  const maxY = Math.max(0, workArea.height - size.height)
  return {
    x: Math.min(Math.max(0, position.x), maxX),
    y: Math.min(Math.max(0, position.y), maxY),
  }
}

/** The owned chrome controller. */
export interface PixiesChromeController {
  readonly window: PixiesWindowLike
  readonly tray: PixiesTrayLike
  /** Whether the global shortcut registered successfully. */
  readonly shortcutRegistered: boolean
  /** The current window mode. */
  readonly mode: PixiesWindowMode
  /** Switch between the mini peek avatar and the expanded panel. */
  readonly setMode: (mode: PixiesWindowMode) => void
  readonly show: () => void
  readonly hide: () => void
  readonly toggle: () => void
  /**
   * Move the window by a pointer delta (CSS pixels relative to the window).
   * Renderer reports screen-space movement; the controller translates it
   * into a window-space delta and clamps the result to the display work
   * area. The current mode is the one the drag started in (a drag is
   * mode-stable: the user grabs, moves, releases).
   */
  readonly dragBy: (deltaX: number, deltaY: number) => void
  readonly dispose: () => void
}

/**
 * Create the tray chrome: position the floating window at the top-right,
 * wire the tray click to toggle visibility, and register the global shortcut
 * to show the window. With `miniSize`, the window starts in (or defaults to
 * the given) mode and `setMode` swaps between the mini peek geometry and the
 * expanded panel geometry.
 * @param deps - injected Electron capabilities.
 * @param options - geometry and identity.
 * @returns the controller over window, tray, and shortcut.
 */
export function createPixiesChrome(deps: PixiesChromeDeps, options: PixiesChromeOptions): PixiesChromeController {
  const window = deps.createWindow()
  const tray = deps.createTray()
  tray.setToolTip(options.tooltip)
  const miniSize = options.miniSize ?? options.windowSize
  const miniMargin = options.miniMargin ?? options.screenMargin
  let mode: PixiesWindowMode = options.initialMode ?? 'expanded'
  const placeWindow = (
    size: { readonly width: number; readonly height: number },
    margin: number,
    workArea: { readonly width: number; readonly height: number },
  ): { readonly x: number; readonly y: number } => {
    const stored = options.initialPosition?.[mode]
    if (stored !== undefined) {
      // Restore last position, but clamp against the current display — the
      // user's saved coords may exceed the new monitor's work area.
      return clampPositionToWorkArea(stored, size, workArea)
    }
    return topRightPosition(size, workArea, margin)
  }
  const applyMode = (next: PixiesWindowMode): void => {
    mode = next
    const size = next === 'mini' ? miniSize : options.windowSize
    const margin = next === 'mini' ? miniMargin : options.screenMargin
    const position = placeWindow(size, margin, deps.workArea())
    window.setSize(size.width, size.height)
    window.setPosition(position.x, position.y)
  }
  applyMode(mode)
  const setMode = (next: PixiesWindowMode): void => {
    if (next === mode) return
    applyMode(next)
  }
  const show = (): void => {
    window.show()
    window.focus()
  }
  const hide = (): void => { window.hide() }
  const toggle = (): void => { if (window.isVisible()) hide(); else show() }
  tray.on('click', toggle)
  const shortcutRegistered = deps.registerShortcut(options.accelerator, show)
  // Apply the drag delta on top of the current window bounds; clamp the new
  // origin so a fast drag past the screen edge still leaves the window
  // fully on-screen. The renderer is the source of the delta (it sees the
  // pointer, we do not), so a tiny stale-bounds race is harmless: the clamp
  // pulls the window back inside the work area on the next tick.
  const dragBy = (deltaX: number, deltaY: number): void => {
    const bounds = window.getBounds()
    const workArea = deps.workArea()
    // Guard against non-finite coordinates slipping past the renderer: if the
    // window has not yet received its first on-screen bounds (e.g. immediately
    // after `show` on macOS) `getBounds` can return undefined fields, or the
    // display service may report NaN sizes while it warms up. Both paths
    // produce NaN positions that BrowserWindow.setPosition rejects at the
    // C++ binding with `conversion failure from <undefined|NaN>`.
    if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return
    if (!Number.isFinite(workArea.width) || !Number.isFinite(workArea.height)) return
    const size = { width: bounds.width, height: bounds.height }
    const next = clampPositionToWorkArea(
      { x: bounds.x + deltaX, y: bounds.y + deltaY },
      size,
      workArea,
    )
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return
    window.setPosition(next.x, next.y)
    options.onDragged?.({ mode, x: next.x, y: next.y })
  }
  const dispose = (): void => {
    deps.unregisterShortcut(options.accelerator)
    tray.destroy()
  }
  const controller: PixiesChromeController = {
    window,
    tray,
    shortcutRegistered,
    get mode() { return mode },
    setMode,
    show,
    hide,
    toggle,
    dragBy,
    dispose,
  }
  return controller
}
