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
ends a voice command, `Cmd/Ctrl+Shift+K` opens the conversation panel, and the tray right-click menu
offers show/hide, reset position, and quit. Set `DSH_PIXIES_OPEN_DEVTOOLS=1` to debug the renderer.

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
- Both text prompts and final speech transcripts are queued into the followed session through
  `promptPixiesSession`; assistant replies stream back into the history. The window mode is owned by
  the main process and reconciled by the renderer on mount.
- The mic button asks the windowed main process for microphone access first, then drives the Swift
  `SFSpeechRecognizer` CLI subprocess (`speech/PixiesSpeech.swift`): partial transcripts fill a
  listening bubble, and a final transcript is sent as a prompt. First use triggers macOS microphone
  and speech-recognition prompts. `build:speech` embeds `speech/Info.plist` into the helper and
  ad-hoc signs it; the dev launcher starts Electron through LaunchServices so TCC attributes those
  prompts to a Pixies bundle rather than the IDE or terminal that spawned it.
- `Cmd/Ctrl+Shift+J` starts a voice command without any click: the mini avatar switches to a red
  pulsing listening ring while the Swift recognizer accepts the instruction, and a second press ends
  the round and sends the recognized draft. `Cmd/Ctrl+Shift+K` shows the window and expands the
  conversation panel. Both shortcuts are owned by the tray chrome and released on quit.
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
- `scripts/launch-services.ts` — LaunchServices dev launcher that owns the app's privacy prompts.
- `src/host-process.ts` / `src/host-protocol.ts` — verbatim copies of the desktop frame-pipe carrier.
- `src/icon.ts` — deterministic runtime PNGs for the tray dot and the spider-mask template icon.
- `src/pixies-keychain.cjs` — pre-boot credential injection (copied into `lib/` by the build).
- `scripts/dev.ts` — build + speech-helper rebuild + disposable-project reuse + LaunchServices launcher.
- `scripts/stage.ts` — profile/bundle staging and Office-skill asset restoration.
- `tests/` — unit tests for the chrome facade, forwarder, icons, keychain, and speech controller.

The React surfaces live in the sibling additive plugin `packages/extensions/pixies/src/client`:
`conversation.tsx` (avatar + expanded panel), `character.tsx` (illustrated SVG mask, listening ring,
voice-reply toggle),
`window-drag.ts` (thresholded pointer drag), `store.ts` (conversation history), `feed.ts`
(session events), `shell.tsx` (mount + input routing), and `locale.ts` (locale-owned copy).

## Known Limitations and Deferred Work

- Speech recognition needs one-time macOS Microphone and Speech Recognition grants for the Pixies
  bundle. A denial is shown in the panel instead of leaving the bubble on "listening"; automated
  smoke covers the bridge and the subprocess pipeline, live recognition is verified by hand on
  first use.
- A macOS packaging script exists (`scripts/package-mac.ts`), but the primary supported path is the
  development launcher above.
