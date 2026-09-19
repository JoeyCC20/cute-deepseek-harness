/** Minimal marker plus the Pixies renderer bridge (window/mode + speech). */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', { protocolVersion: 1 })

/** Renderer-facing Pixies bridge; channels mirror the main-process handlers. */
contextBridge.exposeInMainWorld('dshPixies', {
  expand: (): void => { void ipcRenderer.invoke('pixies:window:expand') },
  collapse: (): void => { void ipcRenderer.invoke('pixies:window:collapse') },
  startSpeech: (): void => { void ipcRenderer.invoke('pixies:speech:start') },
  stopSpeech: (): void => { void ipcRenderer.invoke('pixies:speech:stop') },
  /**
   * Send one pointermove delta while the user drags the floating window.
   * The delta is window-relative: positive X moves the window right, positive
   * Y moves it down. The main process clamps the resulting position to the
   * display work area.
   */
  dragBy: (deltaX: number, deltaY: number): void => {
    ipcRenderer.send('pixies:drag:move', deltaX, deltaY)
  },
  onSpeech: (listener: (event: unknown) => void): (() => void) => {
    const channel = (_event: Electron.IpcRendererEvent, payload: unknown): void => { listener(payload) }
    ipcRenderer.on('pixies:speech', channel)
    return () => { ipcRenderer.removeListener('pixies:speech', channel) }
  },
  onMode: (listener: (mode: unknown) => void): (() => void) => {
    const channel = (_event: Electron.IpcRendererEvent, mode: unknown): void => { listener(mode) }
    ipcRenderer.on('pixies:mode', channel)
    return () => { ipcRenderer.removeListener('pixies:mode', channel) }
  },
})
