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

/**
 * A display work area in display coordinates. `x`/`y` default to zero so a
 * single primary display (or a test fake) can pass just the size, but a
 * secondary display to the left/above the primary has negative origins and
 * must keep them: clamping to zero is what made the avatar impossible to drag
 * onto another monitor.
 */
export interface PixiesWorkArea {
  readonly x?: number
  readonly y?: number
  readonly width: number
  readonly height: number
}

/** Injected Electron capabilities. */
export interface PixiesChromeDeps {
  readonly createWindow: () => PixiesWindowLike
  readonly createTray: () => PixiesTrayLike
  readonly registerShortcut: (accelerator: string, callback: () => void) => boolean
  readonly unregisterShortcut: (accelerator: string) => void
  /** Primary display work area, used for the initial top-right placement. */
  readonly workArea: () => PixiesWorkArea
  /** Drag boundary; defaults to `workArea`. The app supplies the union of all displays. */
  readonly dragWorkArea?: () => PixiesWorkArea
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
   * Last position the user dragged the window to (per mode). The chrome reads
   * and mutates this object in place, so `resetPosition` can drop both modes.
   */
  readonly initialPosition?: {
    mini?: { readonly x: number; readonly y: number }
    expanded?: { readonly x: number; readonly y: number }
  }
  /**
   * Called on every applied drag move. The app keeps its in-memory placement
   * current here; persistence belongs to `onDragEnd`.
   */
  readonly onDragged?: (position: { readonly mode: PixiesWindowMode; readonly x: number; readonly y: number }) => void
  /** Called once when a drag gesture ends; the app persists the placement here. */
  readonly onDragEnd?: (position: { readonly mode: PixiesWindowMode; readonly x: number; readonly y: number }) => void
}

/** The two window modes: a corner mini avatar and the full panel. */
export type PixiesWindowMode = 'mini' | 'expanded'

/**
 * Decide what the conversation shortcut should do: a visible expanded panel
 * collapses to the avatar, while a hidden window always opens the panel rather
 * than collapsing something the user cannot see.
 * @param current - the mode the chrome currently owns.
 * @param visible - whether the floating window is on screen.
 * @returns the mode to apply.
 */
export function nextConversationMode(
  current: PixiesWindowMode,
  visible: boolean,
): PixiesWindowMode {
  return current === 'expanded' && visible ? 'mini' : 'expanded'
}

/**
 * Compute the top-right placement of the floating window inside the screen
 * work area, clamped to the work-area origin.
 * @param windowSize - floating window dimensions.
 * @param workArea - the display's usable area.
 * @param margin - screen-edge margin.
 * @returns the window origin.
 */
export function topRightPosition(
  windowSize: { readonly width: number; readonly height: number },
  workArea: PixiesWorkArea,
  margin: number,
): { readonly x: number; readonly y: number } {
  const originX = workArea.x ?? 0
  const originY = workArea.y ?? 0
  return {
    x: Math.max(originX, originX + workArea.width - windowSize.width - margin),
    y: originY + margin,
  }
}

/**
 * Clamp a desired position so the whole window stays inside the display work
 * area. The origin is honored, so a window dragged onto a display left of the
 * primary keeps its negative coordinates instead of snapping back.
 * @param position - desired top-left.
 * @param size - the window dimensions.
 * @param workArea - the usable area (possibly the union of all displays).
 * @returns the clamped top-left.
 */
export function clampPositionToWorkArea(
  position: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  workArea: PixiesWorkArea,
): { readonly x: number; readonly y: number } {
  const minX = workArea.x ?? 0
  const minY = workArea.y ?? 0
  const maxX = Math.max(minX, minX + workArea.width - size.width)
  const maxY = Math.max(minY, minY + workArea.height - size.height)
  return {
    x: Math.min(Math.max(minX, position.x), maxX),
    y: Math.min(Math.max(minY, position.y), maxY),
  }
}

/**
 * Bounding box covering every display work area. Dragging is clamped to this
 * box, so the avatar can move between monitors while still never disappearing
 * into the void outside the desktop.
 * @param areas - work areas of all attached displays.
 * @returns their union, or a zero-sized area at the origin when none exist.
 */
export function unionWorkArea(areas: readonly PixiesWorkArea[]): PixiesWorkArea {
  if (areas.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const area of areas) {
    const x = area.x ?? 0
    const y = area.y ?? 0
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x + area.width)
    bottom = Math.max(bottom, y + area.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The owned chrome controller. */
export interface PixiesChromeController {
  readonly window: PixiesWindowLike
  readonly tray: PixiesTrayLike
  /** Whether every global shortcut owned by this chrome registered successfully. */
  readonly shortcutRegistered: boolean
  /** Register one extra global shortcut; disposal unregisters it with the others. */
  readonly registerShortcut: (accelerator: string, callback: () => void) => boolean
  /** The current window mode. */
  readonly mode: PixiesWindowMode
  /** Switch between the mini peek avatar and the expanded panel. */
  readonly setMode: (mode: PixiesWindowMode) => void
  readonly show: () => void
  readonly hide: () => void
  readonly toggle: () => void
  /**
   * Move the window by a pointer delta (screen pixels). The renderer measures
   * screen-space movement; the controller translates it into a window-space
   * delta and clamps the result to the drag boundary.
   */
  readonly dragBy: (deltaX: number, deltaY: number) => void
  /** Finish a drag gesture and report the final position once. */
  readonly endDrag: () => void
  /** Forget saved positions and return the window to its default corner. */
  readonly resetPosition: () => void
  readonly dispose: () => void
}

/**
 * Create the tray chrome: position the floating window at the top-right,
 * wire the tray click to toggle visibility, and register the show shortcut.
 * Extra shortcuts added through `registerShortcut` share its disposal.
 * With `miniSize`, `setMode` swaps between the mini peek
 * geometry and the expanded panel geometry; a mode change without a saved
 * position for the target mode grows/shrinks around the current window so the
 * avatar never jumps back to a corner the user dragged it away from.
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
  const dragArea = (): PixiesWorkArea => (deps.dragWorkArea ?? deps.workArea)()

  const applyMode = (next: PixiesWindowMode, initial = false): void => {
    const previous = window.getBounds()
    mode = next
    const size = next === 'mini' ? miniSize : options.windowSize
    const margin = next === 'mini' ? miniMargin : options.screenMargin
    const stored = options.initialPosition?.[next]
    let position: { readonly x: number; readonly y: number }
    if (initial || stored !== undefined) {
      position = stored === undefined
        ? topRightPosition(size, deps.workArea(), margin)
        : clampPositionToWorkArea(stored, size, dragArea())
    } else {
      // Center the new size on the old one horizontally and keep the top edge:
      // expanding a dragged avatar opens the panel where the user put it.
      position = clampPositionToWorkArea({
        x: previous.x - (size.width - previous.width) / 2,
        y: previous.y,
      }, size, dragArea())
    }
    window.setSize(size.width, size.height)
    window.setPosition(Math.round(position.x), Math.round(position.y))
  }
  applyMode(mode, true)
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
  const accelerators = new Set<string>([options.accelerator])
  let allShortcutsRegistered = deps.registerShortcut(options.accelerator, show)
  const registerShortcut = (accelerator: string, callback: () => void): boolean => {
    const registered = deps.registerShortcut(accelerator, callback)
    accelerators.add(accelerator)
    if (!registered) allShortcutsRegistered = false
    return registered
  }
  const dragBy = (deltaX: number, deltaY: number): void => {
    const bounds = window.getBounds()
    const area = dragArea()
    // Guard against non-finite coordinates slipping past the renderer: if the
    // window has not yet received its first on-screen bounds (e.g. immediately
    // after `show` on macOS) `getBounds` can return undefined fields.
    if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return
    if (!Number.isFinite(area.width) || !Number.isFinite(area.height)) return
    const next = clampPositionToWorkArea(
      { x: bounds.x + deltaX, y: bounds.y + deltaY },
      { width: bounds.width, height: bounds.height },
      area,
    )
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return
    // Electron's setPosition accepts integers only: Retina pointer deltas
    // arrive fractional and a fractional origin throws "conversion failure".
    const x = Math.round(next.x)
    const y = Math.round(next.y)
    window.setPosition(x, y)
    options.onDragged?.({ mode, x, y })
  }
  const snapshot = (): { readonly mode: PixiesWindowMode; readonly x: number; readonly y: number } => {
    const bounds = window.getBounds()
    return { mode, x: Math.round(bounds.x), y: Math.round(bounds.y) }
  }
  const endDrag = (): void => { options.onDragEnd?.(snapshot()) }
  const resetPosition = (): void => {
    const stored = options.initialPosition
    if (stored !== undefined) {
      delete stored.mini
      delete stored.expanded
    }
    applyMode(mode, true)
  }
  const dispose = (): void => {
    for (const accelerator of accelerators) deps.unregisterShortcut(accelerator)
    tray.destroy()
  }
  return {
    window,
    tray,
    get shortcutRegistered() { return allShortcutsRegistered },
    registerShortcut,
    get mode() { return mode },
    setMode,
    show,
    hide,
    toggle,
    dragBy,
    endDrag,
    resetPosition,
    dispose,
  }
}
