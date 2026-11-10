/** Minimal marker plus the Pixies renderer bridge (window/mode + speech in/out + shortcuts + drag). */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', { protocolVersion: 1 })

/**
 * The Desktop boot contract consumed by `apps/web/src/main.ts`: it installs
 * `__DSH_TRANSPORT__` with the Host's loopback origin so the API gateway's
 * Remote Event WebSocket reaches the real Host instead of `ws://app/...`.
 */
contextBridge.exposeInMainWorld('dshDesktopBoot', {
  ready: (): Promise<unknown> => ipcRenderer.invoke('pixies:boot'),
  failed: (message: string): Promise<unknown> => ipcRenderer.invoke('pixies:boot:failed', message),
})

/** Renderer-facing Pixies bridge; channels mirror the main-process handlers. */
contextBridge.exposeInMainWorld('dshPixies', {
  expand: (): void => { void ipcRenderer.invoke('pixies:window:expand') },
  collapse: (): void => { void ipcRenderer.invoke('pixies:window:collapse') },
  /** Open the standalone settings window. */
  openSettings: (): void => { void ipcRenderer.invoke('pixies:settings:open') },
  /** The mode the main process actually owns; the renderer reconciles on mount. */
  getMode: (): Promise<unknown> => ipcRenderer.invoke('pixies:window:mode'),
  startSpeech: (): void => { void ipcRenderer.invoke('pixies:speech:start') },
  stopSpeech: (): void => { void ipcRenderer.invoke('pixies:speech:stop') },
  /** Speak the newest assistant reply through the macOS speech helper. */
  speakReply: (text: string): void => { void ipcRenderer.invoke('pixies:voice:speak', text) },
  /** Stop any reply currently being spoken (mute or a new voice command). */
  cancelReply: (): void => { void ipcRenderer.invoke('pixies:voice:cancel') },
  /**
   * Send one pointermove delta while the user drags the floating window.
   * The delta is screen-space: positive X moves the window right, positive
   * Y moves it down. The main process clamps the result to the displays'
   * combined work area before applying.
   */
  dragBy: (deltaX: number, deltaY: number): void => {
    ipcRenderer.send('pixies:drag:move', deltaX, deltaY)
  },
  /** Finish a drag gesture so the main process persists the final position once. */
  endDrag: (): void => { ipcRenderer.send('pixies:drag:end') },
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
  onVoiceReply: (listener: (event: unknown) => void): (() => void) => {
    const channel = (_event: Electron.IpcRendererEvent, payload: unknown): void => { listener(payload) }
    ipcRenderer.on('pixies:voice', channel)
    return () => { ipcRenderer.removeListener('pixies:voice', channel) }
  },
  /** The global voice-command shortcut's start/stop signal. */
  onVoiceCommand: (listener: (event: unknown) => void): (() => void) => {
    const channel = (_event: Electron.IpcRendererEvent, payload: unknown): void => { listener(payload) }
    ipcRenderer.on('pixies:voice-command', channel)
    return () => { ipcRenderer.removeListener('pixies:voice-command', channel) }
  },
})
