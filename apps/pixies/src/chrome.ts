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
  const applyMode = (next: PixiesWindowMode): void => {
    mode = next
    const size = next === 'mini' ? miniSize : options.windowSize
    const margin = next === 'mini' ? miniMargin : options.screenMargin
    const position = topRightPosition(size, deps.workArea(), margin)
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
    dispose,
  }
  return controller
}
