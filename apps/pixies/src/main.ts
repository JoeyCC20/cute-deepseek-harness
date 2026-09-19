/** Pixies tray shell: menu-bar entry, global shortcut, and a frameless top-right window over the dsh backend. */

import { createRequire } from 'node:module'

// Pre-boot credential injection: Launch Services does not pass shell env to
// `open`ed apps, so provider routes relying on ambient discovery see no
// MINIMAX_CN_API_KEY even though the user's terminal does. The shim copies any
// unset variables from project/.env, ~/.config/dsh/env, and the user's shell
// rc files. Must run before any dsh import so providers are built with the
// credentials already in place.
const requireKeychain = createRequire(import.meta.url)
const { injectCredentials } = requireKeychain('./pixies-keychain.cjs') as {
  injectCredentials: () => { injected: number; sources: readonly string[] }
}
const injection = injectCredentials()
if (injection.injected > 0) {
  process.stderr.write(`[pixies] injected ${injection.injected} env var(s) from: ${injection.sources.join(', ')}\n`)
}

import { execFile } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  screen,
  Tray,
} from 'electron'
import { createPixiesChrome, type PixiesChromeDeps, type PixiesWindowLike } from './chrome.ts'
import { DesktopHostProcess } from './host-process.ts'
import { spiderDotIcon } from './icon.ts'
import { claimPixiesSingleInstance } from './single-instance.ts'
import { parseProbeOutput, PixiesSpeechController, type PixiesSpeechEvent } from './speech.ts'

const SCHEME = 'dsh-app'
const WINDOW_SIZE = { width: 420, height: 640 }
const MINI_SIZE = { width: 96, height: 96 }
const SCREEN_MARGIN = 12
const MINI_MARGIN = 0
const SHORTCUT = 'CommandOrControl+Shift+P'
const TOOLTIP = 'Pixies'
/** Phase 5 smoke: the transcript the synthetic speech event carries. */
const SMOKE_TRANSCRIPT = '哈喽'

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true,
    codeCache: true,
  },
}])

/**
 * Deploy the packaged project bundle into userData on first launch (or when
 * the app version changes) and return the deployed directory. The packaged
 * copy under Resources is read-only and shared; userData gets a private
 * mutable clone stamped with the deploying version.
 */
function packagedProject(): string {
  const stamp = `${app.getVersion()}\n`
  const target = join(app.getPath('userData'), 'project')
  const stampPath = join(target, '.pixies-release')
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp) return target
  rmSync(target, { recursive: true, force: true })
  cpSync(join(process.resourcesPath, 'project'), target, { recursive: true })
  writeFileSync(stampPath, stamp)
  return target
}

/** Resolve the active project: deployed bundle when packaged, dev project otherwise. */
function developmentProject(): string {
  if (app.isPackaged) return packagedProject()
  const configured = process.env.DSH_DESKTOP_DEV_PROJECT_DIR
  if (configured === undefined || configured === '') {
    throw new Error('pixies: DSH_DESKTOP_DEV_PROJECT_DIR must point at the prepared development project')
  }
  return resolve(configured)
}

function developmentHostInspectPort(): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  if (configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('pixies: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

/** Speech binary: override, else the packaged resource or the built sibling. */
function speechBinary(): string {
  if (process.env.DSH_PIXIES_SPEECH_BIN !== undefined && process.env.DSH_PIXIES_SPEECH_BIN !== '') {
    return process.env.DSH_PIXIES_SPEECH_BIN
  }
  return app.isPackaged
    ? join(process.resourcesPath, 'pixies-speech')
    : fileURLToPath(new URL('./pixies-speech', import.meta.url))
}

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms) })

/** Diagnostic trace of every speech event (partial/final/error) to userData. */
function traceSpeechEvent(event: PixiesSpeechEvent): void {
  try {
    appendFileSync(
      join(app.getPath('userData'), 'speech.log'),
      `${new Date().toISOString()} ${JSON.stringify(event)}\n`,
    )
  } catch {
    // Diagnostics must never take the app down.
  }
}

/**
 * Run the speech CLI's `probe` subcommand (read-only TCC status; prompts nothing).
 * @param binary - the pixies-speech binary path.
 * @returns the parsed probe, or an error marker when the binary is absent/unparsable.
 */
async function speechProbe(binary: string): Promise<unknown> {
  try {
    const { stdout } = await promisify(execFile)(binary, ['probe'], { timeout: 10_000 })
    return parseProbeOutput(stdout) ?? { error: 'unparsable probe output' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Automated shell smoke (test-validation phase2c/phase3/phase5/phase6): record the
 * injected index.html, the mini/expanded mode round-trip with bounds evidence,
 * the speech bridge surface, a synthetic final transcript through the real
 * renderer path (phase 5: the transcript must reach a session and the reply
 * must come back as a bubble), the real speech subprocess's own events
 * (phase 6: the failure reason must be observable and must reach the bubble),
 * a probe of the speech CLI, and window screenshots next to the evidence file.
 * @param host - the started host process backing the dsh-app protocol.
 * @param window - the pixies chrome window.
 * @param evidenceFile - destination JSON path; screenshots land beside it.
 * @param speech - the live speech controller (phase 6 drives the real child).
 * @param speechEvents - sink the controller records into while the smoke runs.
 */
async function runPixiesSmoke(
  host: DesktopHostProcess,
  window: Electron.BrowserWindow,
  evidenceFile: string,
  speech: PixiesSpeechController,
  speechEvents: PixiesSpeechEvent[],
): Promise<void> {
  const evidence: Record<string, unknown> = {}
  try {
    const index = await host.fetch(new Request('dsh-app://app/index.html'))
    const html = await index.text()
    evidence.indexHasShellFlag = html.includes('__DSH_PIXIES_SHELL__')
    evidence.indexHidesRoot = html.includes('body>*:not([data-pixies-shell]){display:none!important}')
  } catch (error) {
    evidence.indexError = error instanceof Error ? error.message : String(error)
  }
  // Poll until the client overlay mounts (or ~20 s).
  let page: Record<string, unknown> = {}
  for (let attempt = 0; attempt < 40; attempt += 1) {
    page = await window.webContents.executeJavaScript(`({
      shellFlag: window.__DSH_PIXIES_SHELL__ === true,
      overlay: document.querySelector('[data-pixies-shell]') !== null,
      character: document.querySelector('[data-testid="pixies-character"]') !== null,
      mini: document.querySelector('[data-testid="pixies-mini"]') !== null,
      bridge: typeof window.dshPixies === 'object' && window.dshPixies !== null
        && typeof window.dshPixies.expand === 'function'
        && typeof window.dshPixies.collapse === 'function'
        && typeof window.dshPixies.startSpeech === 'function'
        && typeof window.dshPixies.stopSpeech === 'function',
    })`).catch(() => ({}) as Record<string, unknown>)
    if (page.overlay === true) break
    await sleep(500)
  }
  evidence.page = page
  evidence.miniBounds = window.getContentBounds()
  // Expand through the real renderer bridge, then record the expanded UI.
  await window.webContents.executeJavaScript('window.dshPixies.expand()').catch(() => undefined)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bounds = window.getContentBounds()
    if (bounds.width === WINDOW_SIZE.width && bounds.height === WINDOW_SIZE.height) break
    await sleep(250)
  }
  evidence.expandedBounds = window.getContentBounds()
  ;(evidence.page as Record<string, unknown>).expanded = await window.webContents.executeJavaScript(`({
    character: document.querySelector('[data-testid="pixies-character"]') !== null,
    mic: document.querySelector('[data-testid="pixies-mic"]') !== null,
    collapse: document.querySelector('[data-testid="pixies-collapse"]') !== null,
    mini: document.querySelector('[data-testid="pixies-mini"]') !== null,
  })`).catch(() => ({}) as Record<string, unknown>)
  window.show()
  await sleep(1_000)
  const image = await window.webContents.capturePage()
  const screenshot = evidenceFile.replace(/\.json$/u, '.png')
  await writeFile(screenshot, image.toPNG())
  evidence.screenshot = screenshot
  // Phase 5: inject one final transcript through the renderer's own speech
  // channel (the real microphone is replaced, nothing else is) and wait for
  // the assistant's reply to reach the character bubble.
  const phase5: Record<string, unknown> = { transcript: SMOKE_TRANSCRIPT }
  window.webContents.send('pixies:speech', { type: 'final', text: SMOKE_TRANSCRIPT })
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const bubble = await window.webContents.executeJavaScript(
      'document.querySelector(\'[data-testid="pixies-bubble"]\')?.textContent ?? \'\'',
    ).catch(() => '')
    if (typeof bubble === 'string' && bubble !== '') {
      phase5.reply = bubble
      break
    }
    await sleep(1_000)
  }
  evidence.phase5 = phase5
  // Phase 6: drive the real speech subprocess (the same TCC attribution as the
  // mic button) and record what it reports. This is the only way to tell an
  // authorization/device failure from a delivery failure without a human at
  // the microphone; the bubble read afterwards proves the reason is visible.
  speechEvents.length = 0
  speech.start()
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (speechEvents.some(event => event.type === 'ready' || event.type === 'error')) break
    await sleep(1_000)
  }
  const phase6: Record<string, unknown> = { events: [...speechEvents] }
  phase6.bubble = await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-testid="pixies-bubble"]\')?.textContent ?? \'\'',
  ).catch(() => '')
  speech.stop()
  evidence.phase6 = phase6
  // Collapse back to the peeking mini avatar.
  await window.webContents.executeJavaScript('window.dshPixies.collapse()').catch(() => undefined)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bounds = window.getContentBounds()
    if (bounds.width === MINI_SIZE.width && bounds.height === MINI_SIZE.height) break
    await sleep(250)
  }
  evidence.collapsedBounds = window.getContentBounds()
  const miniImage = await window.webContents.capturePage()
  const miniScreenshot = evidenceFile.replace(/\.json$/u, '-mini.png')
  await writeFile(miniScreenshot, miniImage.toPNG())
  evidence.miniScreenshot = miniScreenshot
  // Read-only TCC probe of the speech CLI (no prompts).
  evidence.speechProbe = await speechProbe(speechBinary())
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`)
}

async function main(): Promise<void> {
  const projectDir = developmentProject()
  const inspectPort = developmentHostInspectPort()
  const node = app.isPackaged
    ? join(process.resourcesPath, 'runtime', 'node', 'node')
    : process.env.DSH_DESKTOP_NODE_BINARY ?? process.execPath
  // The pixies window shows only the character: tell the host to inject the
  // shell page markers (the env passes through to the host child).
  process.env.DSH_PIXIES_SHELL = '1'
  let host: DesktopHostProcess | undefined = new DesktopHostProcess(node, projectDir, inspectPort)
  await host.start()

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return Promise.resolve(new Response(null, { status: 404 }))
    const active = host
    if (active === undefined) return Promise.resolve(new Response('backend unavailable', { status: 503 }))
    return active.fetch(request)
  })

  let quitting = false
  let pixiesWindow: Electron.BrowserWindow | undefined
  const preload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const deps: PixiesChromeDeps = {
    createWindow: (): PixiesWindowLike => {
      const window = new BrowserWindow({
        width: WINDOW_SIZE.width,
        height: WINDOW_SIZE.height,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        webPreferences: {
          preload,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).protocol !== `${SCHEME}:`) event.preventDefault()
      })
      // Closing hides the tray window instead of destroying the app.
      window.on('close', (event) => {
        if (!quitting) {
          event.preventDefault()
          window.hide()
        }
      })
      pixiesWindow = window
      return window
    },
    createTray: () => {
      const tray = new Tray(nativeImage.createFromBuffer(Buffer.from(spiderDotIcon(18, 3))))
      const menu = Menu.buildFromTemplate([
        { label: 'Show Pixies', click: () => chrome.show() },
        { type: 'separator' },
        { label: 'Quit', click: () => { quitting = true; app.quit() } },
      ])
      tray.on('right-click', () => { menu.popup() })
      return tray
    },
    registerShortcut: (accelerator, callback) => globalShortcut.register(accelerator, callback),
    unregisterShortcut: (accelerator) => { globalShortcut.unregister(accelerator) },
    workArea: () => screen.getPrimaryDisplay().workAreaSize,
  }
  const chrome = createPixiesChrome(deps, {
    accelerator: SHORTCUT,
    windowSize: WINDOW_SIZE,
    screenMargin: SCREEN_MARGIN,
    tooltip: TOOLTIP,
    miniSize: MINI_SIZE,
    miniMargin: MINI_MARGIN,
    initialMode: 'mini',
  })
  // Renderer-driven window modes and the speech subprocess (phase 3).
  const notifyMode = (mode: string): void => { pixiesWindow?.webContents.send('pixies:mode', mode) }
  ipcMain.handle('pixies:window:expand', () => { chrome.setMode('expanded'); notifyMode('expanded') })
  ipcMain.handle('pixies:window:collapse', () => { chrome.setMode('mini'); notifyMode('mini') })
  const smokeFile = process.env.DSH_PIXIES_SMOKE_FILE
  // Phase 6 evidence sink: recorded only while the smoke runs, so a normal
  // session never accumulates speech events.
  const speechEvents: PixiesSpeechEvent[] = []
  const speech = new PixiesSpeechController({
    binary: speechBinary(),
    onEvent: (event) => {
      if (smokeFile !== undefined) speechEvents.push(event)
      traceSpeechEvent(event)
      pixiesWindow?.webContents.send('pixies:speech', event)
    },
  })
  ipcMain.handle('pixies:speech:start', () => { speech.start() })
  ipcMain.handle('pixies:speech:stop', () => { speech.stop() })
  await chrome.window.loadURL(`${SCHEME}://app/index.html`)
  if (smokeFile !== undefined && pixiesWindow !== undefined && host !== undefined) {
    await runPixiesSmoke(host, pixiesWindow, smokeFile, speech, speechEvents)
    quitting = true
    app.quit()
    return
  }
  const openDevTools = app.isPackaged
    ? process.env.DSH_PIXIES_OPEN_DEVTOOLS === '1'
    : process.env.DSH_PIXIES_OPEN_DEVTOOLS !== '0'
  if (openDevTools) {
    const webContents = chrome.window as unknown as { openDevTools?: (options: { mode: string }) => void }
    webContents.openDevTools?.({ mode: 'detach' })
  }

  app.on('second-instance', () => { chrome.show() })
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    chrome.dispose()
    speech.dispose()
    const active = host
    host = undefined
    void active?.stop().finally(() => { app.quit() })
  })
  // A tray app stays alive with every window hidden; only Quit exits.
  app.on('window-all-closed', () => {})
}

const ownsPixiesInstance = claimPixiesSingleInstance(app, () => {})

if (ownsPixiesInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.DSH_PIXIES_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
  }
  app.exit(1)
})
