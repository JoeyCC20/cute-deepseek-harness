# Pixies core components

Each layer owns one decision, so a change has one obvious entry point. Package READMEs carry the file-by-file layout; this page names the module that owns each behavior and the symbol to start from.

## Shell layer

`apps/pixies/src/main.ts` creates the three windows, registers every IPC channel, and owns the Host child. `chrome.ts` is the unit-testable geometry and tray facade: `createPixiesChrome`, `nextConversationMode`, `topRightPosition`, and `clampPositionToWorkArea` keep window placement out of the Electron entry. `preload-app.ts` defines the renderer's bridge contract, and `panel-settings.ts` holds the pure panel policy behind `panelHideDelay`, `panelReadingMs`, `pointerInPanel`, and `panelHideRemaining`.

`host-proxy.ts` authenticates and forwards the loopback connection, `speech.ts` and `voice.ts` control the Swift helper as NDJSON subprocesses, `icon.ts` draws the tray images, and `scripts/dev.ts` rebuilds and stages the development project.

## Host plugin layer

`packages/extensions/pixies/src/index.ts` declares `ctx.pixies`, the `pixies/presentation` and `pixies/interaction` events, and the waterfall observers for approval and user questions. It projects `assistant/message` events through `presentationFromAssistantMessage`, whose deterministic `<sessionId>#<seq>` id lets the client deduplicate replies. `presentation.ts` owns that projection, `types.ts` owns the wire-safe presentation types, and `shell-inject.ts` hides the standard Web UI for the Pixies face.

## Client layer

`src/client/index.ts` owns the singleton store, session selection, the model and API-key gateway, and mounts the settings page or the shell by query flag. `shell.tsx` bridges the preload API, follows a session, routes text and voice input, and speaks the newest reply. `feed.ts` translates session events into store operations; `store.ts` owns the ordered transcript, the live thinking text, and `hydrate`.

`conversation.tsx` renders both window modes: `PixiesMiniView`, `PixiesExpandedView`, `transcriptBlocks`, `WorkGroup`, `ProcessRow`, `MessageRow`, and `liveBubble`. `character.tsx` supplies the SVG mask, status rings, control buttons, and the legacy `PixiesPanel` used by non-shell pages. `locale.ts` is the only owner of UI copy through `resolvePixiesMessages`.

## Result panel layer

`packages/extensions/pixies-panel/src/index.ts` owns the tool description, the schema, and the question construction. `types.ts` owns the single Host-to-Client wire contract: `parsePanelPayload`, `encodePanelDetail`, `decodePanelDetail`, and `panelResultMeta`. On the client, `panel-answerer.ts` claims questions, `panel-bridge.ts` resolves and narrows the bridge, and `panel.tsx` renders items, reports height, and forwards hover, close, and link events.

## Where to start

Match the change to its owning layer before editing; the lines below name the first file and the check that follows.

- UI copy or a new label: `packages/extensions/pixies/src/client/locale.ts`, then `pnpm run verify-client-ui-i18n`.
- Transcript order, grouping, or a status title: `feed.ts`, `store.ts`, and `conversation.tsx` together.
- Auto-hide or hover timing: `apps/pixies/src/panel-settings.ts` plus the pause and resume closures in `main.ts`.
- Tool behavior or model-visible wording: `packages/extensions/pixies-panel/src/index.ts`, then `pnpm run gen-tool-catalog` and the catalog pairing record.
