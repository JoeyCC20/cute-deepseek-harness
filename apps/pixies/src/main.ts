/** Pixies tray shell: menu-bar entry, global shortcuts, and a frameless top-right window over the dsh backend. */

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
import { dirname, join, resolve } from 'node:path'
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
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron'
import { createPixiesChrome, nextConversationMode, topRightPosition, unionWorkArea, type PixiesChromeDeps, type PixiesWindowLike } from './chrome.ts'
import { DesktopHostProcess } from './host-process.ts'
import { forwardToPixiesHost, pixiesBootPayload, pixiesWebSocketHeaders } from './host-proxy.ts'
import { spiderMaskIcon } from './icon.ts'
import {
  DEFAULT_PANEL_SETTINGS,
  PANEL_SETTINGS_FILE,
  panelHideDelay,
  parsePanelSettings,
  type PixiesPanelSettings,
} from './panel-settings.ts'
import { composePixiesDeployStamp, readPixiesBuildStamp } from './project-stamp.ts'
import { claimPixiesSingleInstance } from './single-instance.ts'
import { parseProbeOutput, PixiesSpeechController, type PixiesSpeechEvent } from './speech.ts'
import { PixiesVoiceController, type PixiesVoiceEvent } from './voice.ts'

const SCHEME = 'dsh-app'
const WINDOW_SIZE = { width: 420, height: 640 }
/** The standalone settings window is a normal document window, not a floating overlay. */
const SETTINGS_SIZE = { width: 900, height: 680 }
const MINI_SIZE = { width: 112, height: 112 }
const SCREEN_MARGIN = 12
const MINI_MARGIN = 8
/** The standalone result panel sits below the mini avatar, still top-right. */
const PANEL_WIDTH = 380
const PANEL_MIN_HEIGHT = 88
/** Mirrors the renderer's scroll ceiling in `dsh-pixies/client/panel`. */
const PANEL_MAX_HEIGHT = 420
const PANEL_MARGIN = 12
const PANEL_TOP_OFFSET = MINI_SIZE.height + MINI_MARGIN + 4
const SHORTCUT = 'CommandOrControl+Shift+P'
/** Start/stop a voice-command round that replaces the running turn. */
const VOICE_COMMAND_SHORTCUT = 'CommandOrControl+Shift+J'
/** Start/stop a voice-command round that waits behind the running turn. */
const QUEUE_VOICE_COMMAND_SHORTCUT = 'CommandOrControl+Shift+Q'
/** Stop the running turn without starting a voice round. */
const STOP_TASK_SHORTCUT = 'CommandOrControl+Shift+S'
/** Toggle the conversation panel from anywhere. */
const CONVERSATION_SHORTCUT = 'CommandOrControl+Shift+K'
/** How a shortcut-started voice round treats a turn already running. */
type VoiceCommandMode = 'replace' | 'queue'
const TOOLTIP = 'Pixies · 蜘蛛侠'
const PLACEMENT_FILE = 'pixies-window.json'

/** Persisted window placement for each mode; lives in userData. */
interface PixiesWindowPlacement {
  mini?: { x: number; y: number }
  expanded?: { x: number; y: number }
}

function loadPixiesWindowPlacement(): PixiesWindowPlacement | undefined {
  try {
    const raw = readFileSync(join(app.getPath('userData'), PLACEMENT_FILE), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const pick = (value: unknown): { x: number; y: number } | undefined => {
      if (typeof value !== 'object' || value === null) return undefined
      const coords = value as Record<string, unknown>
      if (typeof coords.x !== 'number' || typeof coords.y !== 'number') return undefined
      if (!Number.isFinite(coords.x) || !Number.isFinite(coords.y)) return undefined
      return { x: coords.x, y: coords.y }
    }
    const out: PixiesWindowPlacement = {}
    const mini = pick((parsed as Record<string, unknown>).mini)
    if (mini !== undefined) out.mini = mini
    const expanded = pick((parsed as Record<string, unknown>).expanded)
    if (expanded !== undefined) out.expanded = expanded
    return out
  } catch {
    return undefined
  }
}

function savePixiesWindowPlacement(placement: PixiesWindowPlacement): void {
  try {
    writeFileSync(join(app.getPath('userData'), PLACEMENT_FILE), `${JSON.stringify(placement, undefined, 2)}\n`)
  } catch {
    // Persisting position is best-effort: a full disk or a sandboxed userData
    // must not take the app down.
  }
}

/** Forget a placement the user explicitly reset from the tray menu. */
function clearPixiesWindowPlacement(): void {
  try {
    rmSync(join(app.getPath('userData'), PLACEMENT_FILE), { force: true })
  } catch {
    // A read-only userData directory must not take the app down.
  }
}

/** Load the result-panel preferences; a missing or corrupt file uses defaults. */
function loadPanelSettings(): PixiesPanelSettings {
  try {
    const raw = readFileSync(join(app.getPath('userData'), PANEL_SETTINGS_FILE), 'utf8')
    return parsePanelSettings(JSON.parse(raw) as unknown)
  } catch {
    return DEFAULT_PANEL_SETTINGS
  }
}

/** Persist one validated settings snapshot. */
function savePanelSettings(settings: PixiesPanelSettings): void {
  try {
    writeFileSync(join(app.getPath('userData'), PANEL_SETTINGS_FILE), `${JSON.stringify(settings, undefined, 2)}\n`)
  } catch {
    // A read-only userData directory must not take the app down.
  }
}

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
 * Exchange the Host's launch URL for an authority-bound cookie so the
 * forwarded renderer requests carry the same session as the Host's own
 * authenticated UI. Mirrors `apps/desktop/src/web-document.ts`
 * `authenticateWebHost` (PIXIES does not import desktop code).
 * @param url - authenticated URL reported by the owned Host process.
 * @returns Cookie header value (`name=value`) for that Host, ready to set.
 */
async function authenticatePixiesHost(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) {
    throw new Error(`pixies: host authentication failed (status ${String(response.status)})`)
  }
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/**
 * Deploy the packaged project bundle into userData on first launch (or when
 * the app version or the packaged project's build fingerprint changes) and
 * return the deployed directory. The packaged copy under Resources is
 * read-only and shared; userData gets a private mutable clone stamped with
 * the deploying identity. The fingerprint matters because dev builds iterate
 * without version bumps: a version-only stamp silently kept stale client code
 * running after the packaged fix already shipped.
 */
function packagedProject(): string {
  const stamp = composePixiesDeployStamp(
    app.getVersion(),
    readPixiesBuildStamp(join(process.resourcesPath, 'project')),
  )
  const target = join(app.getPath('userData'), 'project')
  const stampPath = join(target, '.pixies-release')
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp) {
    deployPixiesOfficeSkills(target)
    return target
  }
  rmSync(target, { recursive: true, force: true })
  cpSync(join(process.resourcesPath, 'project'), target, { recursive: true })
  writeFileSync(stampPath, stamp)
  deployPixiesOfficeSkills(target)
  return target
}

/**
 * Copy the Office skill assets beside the deployed project directory. The
 * desktop profile resolves them at `<dirname(config.source)>/office-skills`
 * where `config.source` is the project directory; mirroring that layout in
 * userData keeps the packaged build identical to what `prepare-dsh.ts`
 * prepares for desktop.
 */
function deployPixiesOfficeSkills(projectDir: string): void {
  const source = join(process.resourcesPath, 'office-skills')
  if (!existsSync(source)) return
  const target = join(dirname(projectDir), 'office-skills')
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true, dereference: true })
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
 * JS executed in the page: dispatch a real pointer drag sequence (down → five
 * moves → up) on `selector`. This exercises the renderer's actual pointer
 * handlers — the phase 9 smoke only drove `dshPixies.dragBy()` directly and
 * therefore never saw the clientX/clientY freeze. Movement is delivered as
 * screen-space coordinates; the client coordinates deliberately keep tracking
 * the window (`x - window.screenX`) like a real cursor would.
 */
function pointerDragScript(selector: string): string {
  return `(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    if (target === null) return { dispatched: false, reason: 'drag surface missing' }
    const fire = (type, x, y) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 7, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      screenX: x, screenY: y,
      clientX: x - window.screenX, clientY: y - window.screenY,
    }))
    const x0 = window.screenX + 40
    const y0 = window.screenY + 40
    fire('pointerdown', x0, y0)
    for (let step = 1; step <= 5; step += 1) fire('pointermove', x0 + step * 8, y0 + step * 2)
    fire('pointerup', x0 + 40, y0 + 10)
    return { dispatched: true }
  })()`
}

/**
 * Drive a real pointer drag through the page and measure whether the window
 * actually moved. Synthetic events do not synthesize `click`, so the mini
 * avatar's tap-to-expand stays out of the way.
 */
/**
 * Electron types `executeJavaScript` as `Promise<any>`; narrow every page
 * result at this one boundary so the smoke stages stay typed and lint-clean.
 * @param webContents - the pixies window's page.
 * @param script - JavaScript evaluated in the renderer.
 * @returns the page result, narrowed by the caller.
 */
async function evaluateInPage<T>(webContents: Electron.WebContents, script: string): Promise<T> {
  const value: unknown = await webContents.executeJavaScript(script)
  return value as T
}

async function measurePointerDrag(
  window: Electron.BrowserWindow,
  selector: string,
): Promise<Record<string, unknown>> {
  const before = window.getContentBounds()
  const dispatch: Record<string, unknown> = await evaluateInPage<Record<string, unknown>>(
    window.webContents, pointerDragScript(selector),
  ).catch(() => ({}))
  await sleep(600)
  const after = window.getContentBounds()
  const dx = after.x - before.x
  const dy = after.y - before.y
  return {
    surface: selector,
    dispatched: dispatch.dispatched === true,
    before: { x: before.x, y: before.y },
    after: { x: after.x, y: after.y },
    dx,
    dy,
    moved: dx !== 0 || dy !== 0,
  }
}

/**
 * Automated shell smoke (test-validation phase2c/phase3/phase5/phase6/phase10): record the
 * injected index.html, the mini/expanded mode round-trip with bounds evidence,
 * REAL pointer-event drags on both drag surfaces (mini avatar and expanded
 * drag bar), the speech bridge surface, a synthetic final transcript through
 * the real renderer path (phase 5: the transcript must reach a session and
 * the reply must come back as a bubble — a delivery failure must surface as
 * an errorBubble, not silence), the real speech subprocess's own events
 * (phase 6), a probe of the speech CLI, and window screenshots next to the
 * evidence file. Every stage is flushed to disk as it completes (with stage
 * timings), so a hang leaves everything recorded up to the stuck point.
 * @param window - the pixies chrome window.
 * @param evidenceFile - destination JSON path; screenshots land beside it.
 * @param speech - the live speech controller (phase 6 drives the real child).
 * @param speechEvents - sink the controller records into while the smoke runs.
 */
async function runPixiesSmoke(
  window: Electron.BrowserWindow,
  evidenceFile: string,
  speech: PixiesSpeechController,
  speechEvents: PixiesSpeechEvent[],
): Promise<void> {
  const evidence: Record<string, unknown> = { startedAt: new Date().toISOString() }
  const stages: Array<{ stage: string; at: string; ms: number }> = []
  const smokeStartedAt = Date.now()
  let stageStartedAt = smokeStartedAt
  const flush = async (stage: string): Promise<void> => {
    const now = Date.now()
    stages.push({ stage, at: new Date(now).toISOString(), ms: now - stageStartedAt })
    stageStartedAt = now
    evidence.elapsedMs = now - smokeStartedAt
    evidence.stages = [...stages]
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`).catch(() => undefined)
  }
  try {
    await runPixiesStages(window, evidenceFile, evidence, flush, speech, speechEvents)
    evidence.ok = true
  } catch (error) {
    // A hung or failed stage must still leave every earlier stage's evidence
    // on disk plus the reason — the phase 9 field failure wrote nothing at all.
    evidence.fatal = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  }
  await flush('done')
}

/**
 * The smoke's stage sequence; `evidence` and `flush` come from the
 * {@link runPixiesSmoke} wrapper so a fatal in any stage still persists the
 * partial record before the app quits.
 */
async function runPixiesStages(
  window: Electron.BrowserWindow,
  evidenceFile: string,
  evidence: Record<string, unknown>,
  flush: (stage: string) => Promise<void>,
  speech: PixiesSpeechController,
  speechEvents: PixiesSpeechEvent[],
): Promise<void> {
  try {
    // Read the injected markers out of the document the renderer actually ran.
    // It must NOT go over the desktop-host byte pipe: in the packaged app the
    // child accepts the request frame and never answers it (91 bytes written,
    // 0 bytes ever read back), so a pipe fetch hangs forever and every earlier
    // smoke died before writing its first stage. The page has already been
    // through the host's index-inject table, so the DOM carries both markers.
    const html = await evaluateInPage<unknown>(window.webContents, 'document.documentElement.outerHTML')
    evidence.indexHasShellFlag = typeof html === 'string' && html.includes('__DSH_PIXIES_SHELL__')
    evidence.indexHidesRoot = typeof html === 'string'
      && html.includes('body>*:not([data-pixies-shell]){display:none!important}')
  } catch (error) {
    evidence.indexError = error instanceof Error ? error.message : String(error)
  }
  await flush('index')
  // Poll until the client overlay mounts (or ~20 s).
  let page: Record<string, unknown> = {}
  for (let attempt = 0; attempt < 40; attempt += 1) {
    page = await evaluateInPage<Record<string, unknown>>(window.webContents, `({
      shellFlag: window.__DSH_PIXIES_SHELL__ === true,
      overlay: document.querySelector('[data-pixies-shell]') !== null,
      character: document.querySelector('[data-testid="pixies-character"]') !== null,
      mini: document.querySelector('[data-testid="pixies-mini"]') !== null,
      bridge: typeof window.dshPixies === 'object' && window.dshPixies !== null
        && typeof window.dshPixies.expand === 'function'
        && typeof window.dshPixies.collapse === 'function'
        && typeof window.dshPixies.startSpeech === 'function'
        && typeof window.dshPixies.stopSpeech === 'function'
        && typeof window.dshPixies.speakReply === 'function'
        && typeof window.dshPixies.onVoiceCommand === 'function'
        && typeof window.dshPixies.onVoiceReply === 'function',
    })`).catch(() => ({}))
    if (page.overlay === true) break
    await sleep(500)
  }
  evidence.page = page
  evidence.miniBounds = window.getContentBounds()
  // Phase 10: drag the MINI avatar through real pointer events. The mini
  // container is the drag handle; synthetic events fire no click, so the
  // tap-to-expand gesture stays out of the way.
  const pointerDrag: Record<string, unknown> = {
    mini: await measurePointerDrag(window, '[data-pixies-shell][data-mode="mini"]'),
  }
  evidence.pointerDrag = pointerDrag
  await flush('mini-pointer-drag')
  // Expand through the real renderer bridge, then record the expanded UI.
  await window.webContents.executeJavaScript('window.dshPixies.expand()').catch(() => undefined)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bounds = window.getContentBounds()
    if (bounds.width === WINDOW_SIZE.width && bounds.height === WINDOW_SIZE.height) break
    await sleep(250)
  }
  evidence.expandedBounds = window.getContentBounds()
  const pageEvidence = evidence.page as Record<string, unknown>
  pageEvidence.expanded = await evaluateInPage<Record<string, unknown>>(window.webContents, `({
    character: document.querySelector('[data-testid="pixies-character"]') !== null,
    mic: document.querySelector('[data-testid="pixies-mic"]') !== null,
    collapse: document.querySelector('[data-testid="pixies-collapse"]') !== null,
    mini: document.querySelector('[data-testid="pixies-mini"]') !== null,
  })`).catch(() => ({}))
  // Drag through the real renderer bridge: the pointer-delta IPC path must
  // actually move the window (phase 9 evidence; the stale-deploy regression
  // left both click-expand and drag dead in the field).
  const dragBefore = window.getContentBounds()
  await window.webContents.executeJavaScript('window.dshPixies.dragBy(30, 10)').catch(() => undefined)
  await sleep(500)
  const dragAfter = window.getContentBounds()
  evidence.drag = {
    before: { x: dragBefore.x, y: dragBefore.y },
    after: { x: dragAfter.x, y: dragAfter.y },
  }
  // Phase 10: same real-pointer check for the expanded drag bar.
  pointerDrag.expanded = await measurePointerDrag(window, '[data-testid="pixies-drag-bar"]')
  await flush('expanded-pointer-drag')
  window.show()
  await sleep(1_000)
  const image = await window.webContents.capturePage()
  const screenshot = evidenceFile.replace(/\.json$/u, '.png')
  await writeFile(screenshot, image.toPNG())
  evidence.screenshot = screenshot
  await flush('screenshot')
  // Phase 5: inject one final transcript through the renderer's own speech
  // channel (the real microphone is replaced, nothing else is) and wait for
  // the assistant's reply to reach the character bubble. The thinking
  // placeholder (data-mood="thinking") is NOT a reply — keep polling.
  const phase5: Record<string, unknown> = { transcript: SMOKE_TRANSCRIPT }
  window.webContents.send('pixies:speech', { type: 'final', text: SMOKE_TRANSCRIPT })
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const bubble = await evaluateInPage<unknown>(window.webContents, `(() => {
        const node = document.querySelector('[data-testid="pixies-bubble"]')
        if (node === null) return ''
        return JSON.stringify({ text: node.textContent ?? '', mood: node.getAttribute('data-mood') ?? '' })
      })()`).catch(() => '')
    if (typeof bubble === 'string' && bubble.startsWith('{')) {
      const parsed = JSON.parse(bubble) as { text: string; mood: string }
      if (parsed.text !== '' && parsed.mood !== 'thinking') {
        phase5.reply = parsed.text
        break
      }
      if (parsed.mood === 'thinking') phase5.thinkingObserved = true
    }
    await sleep(1_000)
  }
  // A failed delivery surfaces through the same bubble (Voice send failed:
  // …); it must be distinguishable from a real reply instead of silently
  // passing the "bubble is non-empty" check.
  const bubbleText = typeof phase5.reply === 'string' ? phase5.reply : ''
  if (/voice (send|input) failed|发送失败|语音输入失败/iu.test(bubbleText)) {
    phase5.errorBubble = bubbleText
    phase5.reply = ''
  }
  evidence.phase5 = phase5
  await flush('phase5')
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
  await flush('phase6')
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
  const hostReady = await host.start()
  // Pull the Host's session cookie once at boot so every forwarded renderer
  // request carries the same authority the Host's own UI does. Without this
  // the Host responds with `dsh web authentication required; reopen the URL`.
  const hostCookie = await authenticatePixiesHost(hostReady.url)

  // PIXIES routes every dsh-app://app request to the running Host on its
  // loopback HTTP endpoint. The Host's webserver owns the index HTML and is
  // the one that applies the `webserver/index-inject` table (which contains both
  // the client-modules facade and the PIXIES shell markers); if PIXIES served
  // the index page straight from disk the renderer would boot into
  // `__ModuleLoader__ bootstrap facade is missing`. The token query string
  // lives on the Host's ready URL and survives every proxy hop.
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return Promise.resolve(new Response(null, { status: 404 }))
    const ready = host
    if (ready === undefined) return Promise.resolve(new Response('backend unavailable', { status: 503 }))
    return forwardToPixiesHost(request, hostReady.url, hostCookie)
  })

  // Desktop's Web entry (`apps/web/src/main.ts`) only injects
  // `__DSH_TRANSPORT__` when the preload exposes `dshDesktopBoot`. Without the
  // Host's real stream origin the API gateway opens its event WebSocket at
  // `ws://app/api/remote.mux` (a custom scheme cannot serve WebSockets) and
  // retries forever: the panel renders, but no prompt ever reaches a session.
  // The Host already applied its index injections, so ours stays empty.
  ipcMain.handle('pixies:boot', () => pixiesBootPayload(hostReady.url))
  ipcMain.handle('pixies:boot:failed', (_event, message: unknown) => {
    console.error('pixies: web client boot failed:', String(message))
  })

  let quitting = false
  let pixiesWindow: Electron.BrowserWindow | undefined
  let settingsWindow: Electron.BrowserWindow | undefined
  let panelWindow: Electron.BrowserWindow | undefined
  let panelHideTimer: ReturnType<typeof setTimeout> | undefined
  let panelHeight = PANEL_MIN_HEIGHT
  let panelSettings = loadPanelSettings()
  // The Remote Event WebSocket bypasses `protocol.handle`, so it needs its own
  // Host authentication (Desktop does exactly this for its main window). All
  // three Pixies windows share the same boot-time cookie.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*'] }, (details, callback) => {
    const windowIds = [
      pixiesWindow?.webContents.id,
      settingsWindow?.webContents.id,
      panelWindow?.webContents.id,
    ]
    const id = details.webContentsId !== undefined && windowIds.includes(details.webContentsId)
      ? details.webContentsId
      : undefined
    callback(pixiesWebSocketHeaders(details, hostReady.url, hostCookie, id))
  })
  const preload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))

  /**
   * Open (or focus) the standalone settings window. The query selects the
   * settings-only face of the pixies client; both windows share the Host's
   * index injections, cookie, and Remote Event gateway.
   */
  const openSettingsWindow = (): void => {
    if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
      settingsWindow.show()
      settingsWindow.focus()
      return
    }
    const window = new BrowserWindow({
      width: SETTINGS_SIZE.width,
      height: SETTINGS_SIZE.height,
      show: false,
      title: 'Pixies 设置',
      autoHideMenuBar: true,
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
    window.on('closed', () => { settingsWindow = undefined })
    settingsWindow = window
    void window.loadURL(`${SCHEME}://app/index.html?pixiesSettings=1`)
    window.show()
  }
  ipcMain.handle('pixies:settings:open', () => { openSettingsWindow() })

  /** Stop the pending auto-hide without destroying the panel window. */
  const clearPanelHideTimer = (): void => {
    if (panelHideTimer !== undefined) clearTimeout(panelHideTimer)
    panelHideTimer = undefined
  }

  /** Hiding keeps the renderer and its answerer alive for the next result. */
  const hidePanel = (): void => {
    clearPanelHideTimer()
    if (panelWindow !== undefined && !panelWindow.isDestroyed()) panelWindow.hide()
  }

  /**
   * Create the panel once at startup. It stays hidden until a result arrives,
   * but its renderer must load early so the forwarded question waterfall
   * already has an answerer. `skipTaskbar` keeps it out of Dock/Cmd+Tab, and
   * `showInactive` never steals focus from the app the user is working in.
   */
  const createPanelWindow = (): void => {
    const window = new BrowserWindow({
      width: PANEL_WIDTH,
      height: PANEL_MIN_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      vibrancy: 'sidebar',
      visualEffectState: 'active',
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
    window.on('closed', () => {
      clearPanelHideTimer()
      panelWindow = undefined
    })
    window.on('close', (event) => {
      if (!quitting) {
        event.preventDefault()
        hidePanel()
      }
    })
    panelWindow = window
    void window.loadURL(`${SCHEME}://app/index.html?pixiesPanel=1`)
  }

  /** Pin the panel below the avatar for its current content height. */
  const positionPanel = (): void => {
    if (panelWindow === undefined || panelWindow.isDestroyed()) return
    const base = topRightPosition(
      { width: PANEL_WIDTH, height: panelHeight },
      screen.getPrimaryDisplay().workArea,
      PANEL_MARGIN,
    )
    panelWindow.setPosition(base.x, base.y + PANEL_TOP_OFFSET)
  }

  /** Clamp one measured content height and resize the window in place. */
  const resizePanel = (height: unknown): void => {
    if (typeof height !== 'number' || !Number.isFinite(height)) return
    if (panelWindow === undefined || panelWindow.isDestroyed()) return
    const clamped = Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, Math.ceil(height)))
    if (clamped === panelHeight) return
    panelHeight = clamped
    panelWindow.setSize(PANEL_WIDTH, clamped)
    positionPanel()
  }

  /** Show (or refresh) the panel for one result and restart its auto-hide. */
  const showPanel = (interactive: boolean, characters: number): void => {
    if (!panelSettings.enabled) return
    if (panelWindow === undefined || panelWindow.isDestroyed()) return
    clearPanelHideTimer()
    positionPanel()
    panelWindow.showInactive()
    const delay = panelHideDelay(panelSettings, interactive, characters)
    if (delay !== null) panelHideTimer = setTimeout(() => { hidePanel() }, delay)
  }

  ipcMain.handle('pixies:panel:show', (_event, interactive: unknown, characters: unknown) => {
    const count = typeof characters === 'number' && Number.isFinite(characters)
      ? Math.max(0, Math.floor(characters))
      : 0
    showPanel(interactive === true, count)
  })
  ipcMain.handle('pixies:panel:resize', (_event, height: unknown) => {
    resizePanel(height)
  })
  ipcMain.handle('pixies:panel:hide', () => { hidePanel() })
  ipcMain.handle('pixies:panel:settings:get', () => panelSettings)
  ipcMain.handle('pixies:panel:settings:set', (_event, value: unknown) => {
    panelSettings = parsePanelSettings(value)
    savePanelSettings(panelSettings)
    settingsWindow?.webContents.send('pixies:panel:settings', panelSettings)
    if (!panelSettings.enabled) hidePanel()
    return panelSettings
  })
  ipcMain.handle('pixies:panel:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string') return false
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      await shell.openExternal(parsed.href)
      return true
    } catch {
      return false
    }
  })
  createPanelWindow()

  // Only a voice-command round started while the icon was hidden shows a
  // temporary icon. Launch, tray clicks, shortcuts, drags and expands are all
  // explicit and keep the icon visible until the user hides it.
  let autoDismissIcon = false
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
      // A desktop companion stays above ordinary windows (and full-screen
      // spaces on macOS) but never steals focus on its own.
      window.setAlwaysOnTop(true, 'floating')
      if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      // Closing hides the tray window instead of destroying the app.
      window.on('close', (event) => {
        if (!quitting) {
          event.preventDefault()
          autoDismissIcon = false
          window.hide()
        }
      })
      pixiesWindow = window
      return {
        isDestroyed: () => window.isDestroyed(),
        isVisible: () => window.isVisible(),
        show: () => { window.show() },
        hide: () => { window.hide() },
        focus: () => { window.focus() },
        setPosition: (x, y) => { window.setPosition(x, y) },
        setSize: (width, height) => { window.setSize(width, height) },
        getBounds: () => {
          const bounds = window.getBounds()
          return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        },
        loadURL: url => window.loadURL(url),
        once: (event, listener) => { window.once(event, listener) },
      }
    },
    createTray: () => {
      const image = nativeImage.createFromBuffer(Buffer.from(spiderMaskIcon(18)))
      image.setTemplateImage(true)
      const tray = new Tray(image)
      const menu = Menu.buildFromTemplate([
        { label: '显示 / 隐藏 Pixies', click: () => { chrome.toggle() } },
        { label: '重置窗口位置', click: () => { clearPixiesWindowPlacement(); chrome.resetPosition() } },
        { type: 'separator' },
        { label: '退出 Pixies', click: () => { quitting = true; app.quit() } },
      ])
      // A macOS status item needs an attached context menu to stay visible,
      // and a text label as a fallback when menu-bar setups hide template
      // images: without it, hiding the floating icon leaves no visible entry.
      tray.setContextMenu(menu)
      tray.setTitle('Pixies')
      return tray
    },
    registerShortcut: (accelerator, callback) => globalShortcut.register(accelerator, callback),
    unregisterShortcut: (accelerator) => { globalShortcut.unregister(accelerator) },
    workArea: () => screen.getPrimaryDisplay().workArea,
    dragWorkArea: () => unionWorkArea(screen.getAllDisplays().map(display => display.workArea)),
  }
  const placement = loadPixiesWindowPlacement()
  // The chrome controller mutates this object in place, so a drag is visible
  // to the next mode switch and a tray "reset" can forget both modes.
  const livePlacement: PixiesWindowPlacement = {}
  if (placement?.mini !== undefined) livePlacement.mini = placement.mini
  if (placement?.expanded !== undefined) livePlacement.expanded = placement.expanded
  const chrome = createPixiesChrome(deps, {
    accelerator: SHORTCUT,
    windowSize: WINDOW_SIZE,
    screenMargin: SCREEN_MARGIN,
    tooltip: TOOLTIP,
    miniSize: MINI_SIZE,
    miniMargin: MINI_MARGIN,
    initialMode: 'mini',
    initialPosition: livePlacement,
    onDragged: (dragged) => {
      livePlacement[dragged.mode] = { x: dragged.x, y: dragged.y }
    },
    // Persist once per gesture, not once per pointermove: sync writes on every
    // frame made long drags stutter on slower disks.
    onDragEnd: (dragged) => {
      livePlacement[dragged.mode] = { x: dragged.x, y: dragged.y }
      savePixiesWindowPlacement(livePlacement)
    },
    // Any show/hide from the tray, shortcuts or IPC is an explicit origin;
    // beginVoiceCommand re-marks the one temporary case right after show().
    onVisibilityChange: () => { autoDismissIcon = false },
  })
  // Renderer-driven window modes and the speech subprocess (phase 3).
  const notifyMode = (mode: string): void => { pixiesWindow?.webContents.send('pixies:mode', mode) }
  ipcMain.handle('pixies:window:mode', () => chrome.mode)
  ipcMain.handle('pixies:window:expand', () => {
    autoDismissIcon = false
    chrome.setMode('expanded')
    notifyMode('expanded')
    pixiesWindow?.focus()
  })
  ipcMain.handle('pixies:window:collapse', () => {
    chrome.setMode('mini')
    notifyMode('mini')
  })
  const smokeFile = process.env.DSH_PIXIES_SMOKE_FILE
  // Phase 6 evidence sink: recorded only while the smoke runs, so a normal
  // session never accumulates speech events.
  const speechEvents: PixiesSpeechEvent[] = []
  const notifySpeech = (event: PixiesSpeechEvent): void => {
    if (smokeFile !== undefined) speechEvents.push(event)
    traceSpeechEvent(event)
    pixiesWindow?.webContents.send('pixies:speech', event)
  }
  const speech = new PixiesSpeechController({ binary: speechBinary(), onEvent: notifySpeech })
  const notifyVoice = (event: PixiesVoiceEvent): void => {
    if (event.type === 'error') console.warn(`[pixies] voice reply failed: ${event.message}`)
    pixiesWindow?.webContents.send('pixies:voice', event)
  }
  const voice = new PixiesVoiceController({ binary: speechBinary(), onEvent: notifyVoice })
  const startSpeech = async (): Promise<void> => {
    // The headless Swift helper cannot present a microphone prompt; ask from
    // the windowed main process first so TCC can attach the dialog to Pixies.
    if (process.platform === 'darwin' && !(await systemPreferences.askForMediaAccess('microphone'))) {
      notifySpeech({ type: 'error', message: 'microphone access denied; grant Microphone access in System Settings' })
      return
    }
    speech.start()
  }
  ipcMain.handle('pixies:speech:start', startSpeech)
  ipcMain.handle('pixies:speech:stop', () => { speech.stop() })
  // The renderer asks the main process to speak the newest assistant reply.
  // Text crosses an IPC boundary, so a non-string payload is dropped here.
  ipcMain.handle('pixies:voice:speak', (_event, text: unknown) => {
    if (typeof text === 'string') voice.speak(text)
  })
  ipcMain.handle('pixies:voice:cancel', () => { voice.cancel() })
  // Renderer drags send screen-space deltas; the controller clamps them
  // against the union of all displays before moving the window. The same delta
  // is also forwarded as a single `ipcMain.on` because there is no return
  // value to await — pointermove fires dozens of times per second.
  ipcMain.on('pixies:drag:end', () => { chrome.endDrag() })
  ipcMain.on('pixies:drag:move', (_event, deltaX: unknown, deltaY: unknown) => {
    if (typeof deltaX !== 'number' || typeof deltaY !== 'number') {
      console.warn(`[pixies] drag ignored: non-number delta (${typeof deltaX}, ${typeof deltaY})`)
      return
    }
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      console.warn(`[pixies] drag ignored: non-finite delta (${String(deltaX)}, ${String(deltaY)})`)
      return
    }
    autoDismissIcon = false
    try {
      chrome.dragBy(deltaX, deltaY)
    } catch (error) {
      console.error(`[pixies] dragBy failed at (${String(deltaX)}, ${String(deltaY)}):`, error)
    }
  })
  /** Right-click "hide" returns the floating icon to the menu bar. */
  ipcMain.handle('pixies:icon:hide', () => {
    autoDismissIcon = false
    chrome.hide()
  })
  /**
   * The renderer reports the end of a round (listening → thinking → reply
   * playback). Only an icon the voice shortcut showed from a hidden window is
   * dismissed; a user-shown icon stays put.
   */
  ipcMain.handle('pixies:icon:dismiss-auto', () => {
    if (!autoDismissIcon) return false
    autoDismissIcon = false
    chrome.hide()
    return true
  })
  /**
   * Cmd/Ctrl+Shift+J / +Q: one press opens a voice-command round. Feedback is
   * sent before the microphone permission check (which can wait on a TCC
   * dialog), so the avatar reacts on the keystroke itself. A second press ends
   * the round and delivers whatever the recognizer already transcribed. The
   * renderer stops the running turn for a `replace` round; a `queue` round
   * relies on the session's existing queued-prompt mechanism.
   */
  const beginVoiceCommand = (mode: VoiceCommandMode): void => {
    const wasHidden = !chrome.window.isVisible()
    if (wasHidden) {
      // A shortcut wake shows only the mini avatar as a round indicator; the
      // renderer dismisses it once the round finishes.
      chrome.setMode('mini')
      notifyMode('mini')
      chrome.show()
      autoDismissIcon = true
    }
    voice.cancel()
    if (speech.active) {
      speech.stop()
      pixiesWindow?.webContents.send('pixies:voice-command', { type: 'stop' })
      return
    }
    pixiesWindow?.webContents.send('pixies:voice-command', { type: 'start', mode })
    void startSpeech()
  }
  /** Cmd/Ctrl+Shift+S: stop the running turn and discard any live voice round. */
  const stopTask = (): void => {
    voice.cancel()
    if (speech.active) speech.stop()
    pixiesWindow?.webContents.send('pixies:voice-command', { type: 'cancel' })
  }
  /** Cmd/Ctrl+Shift+K: open the conversation panel, or collapse it back to the avatar. */
  const toggleConversation = (): void => {
    const next = nextConversationMode(chrome.mode, chrome.window.isVisible())
    chrome.setMode(next)
    notifyMode(next)
    if (next === 'expanded') chrome.show()
  }
  for (const [accelerator, callback] of [
    [VOICE_COMMAND_SHORTCUT, () => { beginVoiceCommand('replace') }],
    [QUEUE_VOICE_COMMAND_SHORTCUT, () => { beginVoiceCommand('queue') }],
    [STOP_TASK_SHORTCUT, stopTask],
    [CONVERSATION_SHORTCUT, toggleConversation],
  ] as const) {
    if (!chrome.registerShortcut(accelerator, callback)) {
      console.warn(`[pixies] global shortcut ${accelerator} could not be registered (already in use)`)
    }
  }
  await chrome.window.loadURL(`${SCHEME}://app/index.html`)
  // The avatar is the product: show it as soon as the page is ready instead of
  // waiting for a tray click that the user has no reason to make on launch.
  chrome.show()
  if (smokeFile !== undefined && pixiesWindow !== undefined) {
    await runPixiesSmoke(pixiesWindow, smokeFile, speech, speechEvents)
    quitting = true
    chrome.dispose()
    speech.dispose()
    voice.dispose()
    await host.stop().catch(() => undefined)
    host = undefined
    app.exit(0)
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
    clearPanelHideTimer()
    if (panelWindow !== undefined && !panelWindow.isDestroyed()) panelWindow.destroy()
    chrome.dispose()
    speech.dispose()
    voice.dispose()
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
