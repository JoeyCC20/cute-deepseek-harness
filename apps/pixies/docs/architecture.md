# Pixies architecture

Pixies is an additive desktop companion: the Electron shell runs a private Host child, and three BrowserWindows load the same client bundle with different query flags. Nothing in the shared workspace is modified; the feature composes from two plugins and one app tree.

## Process topology

The main process owns the Host child, the `dsh-app://` protocol, tray and window chrome, global shortcuts, and every IPC handler. It creates three windows: the 112×112 transparent avatar and the 420×640 conversation panel share `index.html`, the result panel loads `?pixiesPanel=1`, and settings load `?pixiesSettings=1`. The result panel is created hidden at startup so its answerer is already subscribed when the first question arrives.

`src/preload-app.ts` exposes `window.dshPixies` to the renderer. Nineteen `ipcMain.handle` channels cover boot, window mode, speech, voice, icon, and panel operations; two `ipcMain.on` channels carry drag deltas; five `webContents.send` channels push mode, speech, voice, voice-command, and panel settings back to the renderer. Only `http(s)` URLs pass `pixies:panel:open-external`.

## Package boundaries

| Tree | Owns | Does not own |
|---|---|---|
| `apps/pixies` | Window lifecycle, IPC, tray and shortcuts, Swift speech helper, reading-time and auto-hide policy | Session events, tool definitions, React rendering |
| `packages/extensions/pixies` | `ctx.pixies` service, presentation projection, shell injection, the React client, settings and model gateway | Electron windows, the result-panel tool |
| `packages/extensions/pixies-panel` | `show_result_panel` registration, payload parsing, the Host-to-Client wire detail | Rendering, window placement, session storage |

## Event to transcript

`followPixiesSession` retains a session snapshot and subscribes to its event stream; replay hydrates durable entries with `includeUser: true` and live events use `includeUser: false`. `feedSessionEvent` maps each event to one store operation in arrival order, so process rows sit between the prompt and the reply that ended the turn.

1. `turn/start` opens the live thinking state; `assistant/live-chunk` reasoning deltas append to it.
2. `tool/call`, `tool/result`, and content-block tool calls append `process` rows with their own kind.
3. `assistant/message` settles reasoning into its own row, appends tool calls, then calls `speak` to append the assistant row and end thinking.
4. `turn/end` ends thinking and appends a system row when the turn failed.

`createPixiesStore` keeps the ordered message array with roles `user`, `assistant`, `system`, and `process`. `conversation.tsx` groups consecutive process rows with `transcriptBlocks` without moving them, renders each group as a collapsed `WorkGroup`, and renders replies after their own work.

## Result panel path

The tool never writes a session event. `show_result_panel` forwards one user-question carrying an encoded payload; the Client answerer decodes it, claims the request, and calls the preload bridge to show the window.

1. `packages/extensions/pixies-panel/src/index.ts` registers the tool and builds the display-only or choice question.
2. `packages/extensions/pixies/src/client/panel-answerer.ts` claims the question and resolves non-interactive calls immediately.
3. `panel.tsx` renders the four item kinds, reports its height with a `ResizeObserver`, and forwards hover and link clicks.
4. `apps/pixies/src/main.ts` calls `showPanel`, which schedules auto-hide from `panelHideDelay` and pauses on hover.

## Window lifecycle

`chrome.ts` owns mini/expanded geometry, multi-display clamping, anchored resizing, and persisted placement without importing Electron. `panel-settings.ts` owns the pure auto-hide policy: reading time is estimated at 400 Chinese characters per minute above a ten-second floor, choice panels and a disabled or zero delay never auto-hide, and `pointerInPanel` plus `panelHideRemaining` let the main process freeze the countdown and resume from the remaining time.
