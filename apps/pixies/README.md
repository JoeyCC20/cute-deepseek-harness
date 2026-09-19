# Pixies tray shell

English | [中文](README.zh.md)

`apps/pixies` is the macOS menu-bar client form of DeepSeek Harness: a tray entry, a global
shortcut, and a frameless always-on-top window pinned to the top-right of the screen. It reuses the
desktop host chain (frame protocol + the private `@deepseek-ai/dsh-desktop-host` child) verbatim and
adds no listening port, so the security posture of `apps/desktop` is preserved.

Status: **development-run only**. `scripts/dev.ts` builds the workspace, prepares a disposable
project (same as `dev:desktop`), and launches Electron. A packaged release pipeline is still
deferred; the cartoon client half and voice input are delivered (see Behavior).

## Run

```sh
pnpm run build
pnpm run build:speech   # compile the Swift SFSpeechRecognizer CLI to lib/pixies-speech
pnpm run dev:pixies
```

Dev state lives under `apps/pixies/.pixies-build/development`: `home` (Harness home), `project`
(disposable profile), `electron-user-data`. Tray click toggles the window; `Cmd/Ctrl+Shift+P` shows
it; the tray right-click menu quits.

## Behavior

- The window starts as a 96×96 mini avatar pinned to the top-right corner (the "peek"); clicking it
  expands the 420×640 panel and the collapse button shrinks it back (`window.dshPixies` bridge,
  `src/chrome.ts` mini/expanded modes).
- The mic button drives the Swift `SFSpeechRecognizer` CLI subprocess (`speech/PixiesSpeech.swift`):
  partial transcripts fill a listening bubble, and a final transcript is queued into the followed
  session. First use triggers the macOS microphone + speech-recognition permission prompts for the
  dev shell; the launcher patches `NSSpeechRecognitionUsageDescription` into Electron.app
  automatically (Electron ships only the microphone key).

## Layout

- `src/main.ts` — Electron entry: `dsh-app://` protocol, host child, tray chrome, IPC handlers.
- `src/chrome.ts` — facade-owned tray/window/shortcut lifecycle with mini/expanded modes,
  unit-testable without Electron.
- `src/preload-app.ts` — the sandboxed preload bridge (`window.dshPixies`): window expand/collapse,
  speech start/stop, and speech/mode event streams.
- `src/speech.ts` — Node-side controller for the `pixies-speech` subprocess (NDJSON streaming,
  fail-soft when the binary is absent).
- `speech/PixiesSpeech.swift` — the Swift SFSpeechRecognizer CLI (`probe` / `listen`).
- `src/host-process.ts` / `src/host-protocol.ts` — verbatim copies of the desktop frame-pipe carrier.
- `src/icon.ts` — deterministic runtime PNG for the menu-bar dot (no binary assets in the checkout).
- `scripts/dev.ts` — build + disposable-project + Electron launcher.
- `tests/` — unit tests for the chrome facade and the speech controller.

## Known Limitations and Deferred Work

- Development-run only; no packaged release pipeline yet.
- Speech recognition depends on the macOS TCC grants of the dev shell; automated smoke covers the
  bridge and the subprocess pipeline, live recognition is verified by hand on first use.
- Tray icon is a plain red dot, not yet a template image for menu-bar theme adaptation.
