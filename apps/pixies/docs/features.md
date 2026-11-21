# Pixies features

Pixies presents one always-available companion whose behavior spans the shell, the client, and the result-panel tool. Per-package behavior and known limitations stay in the three READMEs; this page maps each capability to the layer that delivers it.

## Companion window

The window starts as a draggable 112×112 avatar near the top-right and expands in place into a 420×640 conversation panel. `chrome.ts` saves the position once per gesture, clamps it to the union of display work areas, and grows the panel around the avatar instead of jumping back to a corner. The tray toggles visibility and offers reset and quit; `Cmd/Ctrl+Shift+P` shows the window, `K` toggles the panel, `J` and `Q` start replacing and queued voice commands, and `S` stops the running turn.

## Conversation

The expanded panel renders an ordered transcript. Assistant replies are full-width Markdown documents with a role header, user prompts keep a bubble, and failures or control feedback keep their literal text. Work rows for thinking, tool calls, and tool results sit at the position where they happened, grouped into one collapsed disclosure per turn; opening it lists the steps, and opening a step shows its full text. The group heading uses `copy.thinking` while the turn runs and `copy.thinkingProcess` once reasoning has settled.

`liveBubble` covers only a speech draft and an error, so a running turn never produces a separate thinking bubble. Header status text still reports listening, speaking, thinking, and idle, and the mini avatar uses a rotating thinking ring rather than a bubble.

## Voice

The mic button asks the main process for microphone access and drives the Swift `SFSpeechRecognizer` helper; partial transcripts fill the listening bubble and a final transcript becomes a prompt. Replacing and queued shortcut rounds cancel or join the running turn as configured, and a stop leaves a visible task-stopped line. Assistant replies are spoken through `AVSpeechSynthesizer`, with a header toggle to mute them. `voice-summary.ts` reduces spoken output to prose; a `[voice]...[/voice]` takeaway at the start of a long reply selects only that sentence for speech while the transcript keeps the complete reply.

## Result panel

`show_result_panel` is the primary presentation surface for results: computed values, lookups, summaries, tables, code, links, images, and short choices. Four item kinds render in a compact window; structured text uses Markdown and never raw HTML. A choice pauses the tool call until the user answers, and the answer returns as selected labels. The tool description requires one call before the final reply for most result-bearing turns and forbids mentioning the panel or the tool in that reply.

The panel is created hidden and shown without taking focus. Non-interactive results auto-hide after a reading-time estimate with a ten-second floor; a pointer entering the panel freezes the countdown and leaving resumes the remaining time. Settings in `?pixiesSettings=1` toggle the panel and its delay, and a pointer already over the panel when a result arrives pauses immediately.

## Sessions and settings

The header history drawer groups host sessions by morning, afternoon, and earlier days, marks the followed session, and switches the session the character prompts. New-session, model, and API-key controls live in the same client; the window mode is owned by the main process and reconciled on mount. `window-drag.ts` suppresses the click that follows a real drag so dragging never expands the panel.

## Limits

Three boundaries shape the feature; each is verified where its owner is testable.

- Speech recognition needs one-time macOS microphone and speech-recognition grants attributed to a Pixies bundle; the development launcher owns that attribution.
- The `?pixiesPanel` legacy character-plus-bubble panel has no work-group region, so it keeps its own thinking bubble.
- The result panel renders local images through the Host file API and only `http(s)` links; other URL schemes are rejected.
