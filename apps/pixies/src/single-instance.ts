/** Electron single-instance ownership before any Pixies profile lifecycle begins. */

/** Minimal Electron application operations needed for instance ownership. */
export interface PixiesSingleInstanceApplication {
  requestSingleInstanceLock(): boolean
  quit(): void
  on(event: 'second-instance', listener: () => void): unknown
}

/**
 * Claim the process-lifetime Pixies lock and route later launches to the owner.
 * @param application - Electron application singleton.
 * @param focusOwner - show or recreate the floating window after a later launch.
 * @returns true only in the process that may own the Pixies chrome.
 */
export function claimPixiesSingleInstance(
  application: PixiesSingleInstanceApplication,
  focusOwner: () => void,
): boolean {
  if (!application.requestSingleInstanceLock()) {
    application.quit()
    return false
  }
  application.on('second-instance', focusOwner)
  return true
}
