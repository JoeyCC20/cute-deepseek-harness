# Pixies desktop companion

English | [中文](README.zh.md)

`apps/pixies` is the macOS menu-bar client form of DeepSeek Harness: a floating Spider-Man avatar
that is always visible, freely draggable, and one click away from a real conversation. It reuses the
desktop host chain (frame protocol + the private `@deepseek-ai/dsh-desktop-host` child) verbatim and
adds no listening port, so the security posture of `apps/desktop` is preserved.

Everything this feature owns lives in two additive trees — `apps/pixies` and
`packages/extensions/pixies` — and no existing file of the main workspace is modified.

## Run

```sh
pnpm run build             # build the workspace once
pnpm run build:speech      # Swift SFSpeechRecognizer CLI + embedded TCC Info.plist
pnpm run dev:pixies        # full rebuild + prepared project + Electron
pnpm run start:pixies      # reuse the prepared project and launch immediately
```

Dev state lives under `apps/pixies/.pixies-build/development`: `home` (Harness home), `project`
(disposable profile), `electron-user-data`, and `office-skills` (restored automatically). The window
appears on launch; tray click toggles it, `Cmd/Ctrl+Shift+P` shows it, `Cmd/Ctrl+Shift+J` starts or
ends a voice command that replaces the running turn, `Cmd/Ctrl+Shift+Q` starts or ends one that queues
behind it, `Cmd/Ctrl+Shift+S` stops the running turn, `Cmd/Ctrl+Shift+K` toggles the conversation panel,
and the tray right-click menu offers show/hide, reset position, and quit. Set
`DSH_PIXIES_OPEN_DEVTOOLS=1` to debug the renderer.

Credentials come from the repository root `.env` (`DSH_PIXIES_ENV_FILE` in development), from
`~/.config/dsh/env`, or from your shell rc files; the pre-boot injector never overwrites a value
already present in the environment. `DEEPSEEK_API_KEY` is required for replies.

## Behavior

- The window starts as a 112×112 spider-mask avatar near the top-right. Drag anywhere on the avatar
  to move it across displays; the final position is saved once per gesture. A short tap (not a drag)
  expands the 420×640 panel, and the collapse button, the tray, or `Escape` shrink it back. Mode
  changes grow around the avatar's current position instead of jumping back to a corner.
- The expanded panel is a conversation: a scrollable history of user/assistant/system messages, a
  text composer (`Enter` sends, `Shift+Enter` inserts a newline), and the mic button. Thinking,
  listening, speech errors, and failed turns all have visible states — a failed turn is never silent.
- Live reasoning streams into a thinking disclosure under the transcript. The block is collapsed by
  default, expands on click, and keeps streaming while open; a recorded-session replay reconstructs
  the same text from the durable reasoning blocks when client-only live chunks are absent.
- The header's clock button stows a history drawer: sessions grouped by today's morning, today's
  afternoon, and earlier days, with the followed session marked, plus a preview of the visible
  conversation context. Selecting a row switches the session the character follows and prompts; the
  preference stays local to Pixies because the host catalog does not project a current selection.
  The drawer is collapsed by default.
- Both text prompts and final speech transcripts are queued into the followed session through
  `promptPixiesSession`; assistant replies stream back into the history. The window mode is owned by
  the main process and reconciled by the renderer on mount.
- The mic button asks the windowed main process for microphone access first, then drives the Swift
  `SFSpeechRecognizer` CLI subprocess (`speech/PixiesSpeech.swift`): partial transcripts fill a
  listening bubble, and a final transcript is sent as a prompt. First use triggers macOS microphone
  and speech-recognition prompts. `build:speech` embeds `speech/Info.plist` into the helper and
  ad-hoc signs it; the dev launcher starts Electron through LaunchServices so TCC attributes those
  prompts to a Pixies bundle rather than the IDE or terminal that spawned it. The launcher's
  executable is a symlink to the Electron binary — a shell-script launcher leaves the menu-bar
  tray invisible — and passes its environment/log paths to `src/pixies-keychain.cjs` via argv.
- `Cmd/Ctrl+Shift+J` starts a voice command without any click: the running turn is cancelled on that
  first press, the mini avatar switches to a red pulsing listening ring while the Swift recognizer
  accepts the instruction, and a second press ends the round and sends the recognized draft as a new
  queued prompt. `Cmd/Ctrl+Shift+Q` runs the same round without cancelling: the transcript joins the
  session's existing inbox queue and runs after the current turn. `Cmd/Ctrl+Shift+S` just cancels the
  running turn (and discards a live voice round); pending queued work survives cancellation. From a
  submit until the first reply the avatar shows a blue rotating thinking ring instead, so a long model
  call never looks idle. `Cmd/Ctrl+Shift+K` toggles the conversation panel: one press shows and expands
  it, a second press collapses it back to the mini avatar. All shortcuts are owned by the tray chrome
  and released on quit.
- While a turn runs, the composer's Send button becomes a red Stop button. Stopping from there, from
  `Cmd/Ctrl+Shift+S`, or from a replacing `Cmd/Ctrl+Shift+J` round clears the thinking state immediately
  and leaves a visible "task stopped" line in the transcript.
- Assistant replies are returned by voice first through the same Swift helper's `speak` subcommand
  (`AVSpeechSynthesizer`), with the voice language chosen from the reply and a speaker toggle in the
  panel header to mute them. Spoken output is reduced to prose (code, links, and URLs are dropped)
  and capped; a synthesis failure is shown in the panel instead of failing silently.
- The tray uses an anti-aliased spider-mask template image, so the menu bar recolors it for light
  and dark themes.

## Layout

- `src/main.ts` — Electron entry: `dsh-app://` protocol, desktop boot contract + WebSocket header
  authentication, host child, tray chrome, IPC handlers, startup show.
- `src/chrome.ts` — facade-owned tray/window/shortcut lifecycle: mini/expanded modes, multi-display
  drag bounds, anchored resizing, persisted placement; unit-testable without Electron.
- `src/host-proxy.ts` — loopback forwarder, desktop boot payload, WebSocket upgrade authentication.
- `src/preload-app.ts` — sandboxed preload bridge (`window.dshPixies` and `dshDesktopBoot`).
- `src/speech.ts` — Node-side controller for the `pixies-speech` subprocess (NDJSON streaming,
  visible error events for a missing binary, a failed spawn, or an unexpected exit).
- `src/voice.ts` — Node-side controller for spoken replies: NDJSON status, newest-reply
  cancellation, speakable-text reduction, and visible synthesis errors.
- `speech/PixiesSpeech.swift` — the Swift speech CLI (`probe` / `listen` / `speak`).
- `speech/Info.plist` — TCC usage descriptions embedded in the helper and ad-hoc signed by the build.
- `scripts/launch-services.ts` — LaunchServices dev launcher: owns the app's privacy prompts and links Electron as the bundle executable.
- `src/host-process.ts` / `src/host-protocol.ts` — verbatim copies of the desktop frame-pipe carrier.
- `src/icon.ts` — deterministic runtime PNGs for the tray dot and the spider-mask template icon.
- `src/pixies-keychain.cjs` — pre-boot credential injection and dev-launcher argv setup (copied into `lib/` by the build).
- `scripts/dev.ts` — build + speech-helper rebuild + disposable-project reuse + LaunchServices launcher.
- `scripts/stage.ts` — profile/bundle staging and Office-skill asset restoration.
- `tests/` — unit tests for the chrome facade, forwarder, icons, keychain, and speech controller.
- `docs/` — agent-facing handoff pages: architecture, core components, features, and the behavior/implementation map ([index](docs/index.md)).

The React surfaces live in the sibling additive plugin `packages/extensions/pixies/src/client`:
`conversation.tsx` (avatar, expanded panel, collapsible reasoning and history surfaces),
`character.tsx` (illustrated SVG mask, listening and
thinking rings, voice-reply toggle),
`window-drag.ts` (thresholded pointer drag), `store.ts` (conversation history and reasoning stream),
`feed.ts` (session events and live chunks), `shell.tsx` (mount + input routing + session selection),
and `locale.ts` (locale-owned copy).

## Known Limitations and Deferred Work

- Speech recognition needs one-time macOS Microphone and Speech Recognition grants for the Pixies
  bundle. A denial is shown in the panel instead of leaving the bubble on "listening"; automated
  smoke covers the bridge and the subprocess pipeline, live recognition is verified by hand on
  first use.
- A macOS packaging script exists (`scripts/package-mac.ts`), but the primary supported path is the
  development launcher above.
