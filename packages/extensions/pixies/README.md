---
description: "Add a draggable Spider-Man desktop companion to a dsh profile: observe approval and question waterfalls, fold assistant replies into speech bubbles, and chat from a floating Electron window."
kind: "package-bundle"
---

# @deepseek-ai/dsh-pixies

English | [中文](README.zh.md)

## Summary

Mount `@deepseek-ai/dsh-pixies` in a profile to add a floating Spider-Man companion that speaks assistant replies and reacts to approvals. Launch the Pixies desktop app to drag the 112×112 avatar across displays, tap it to open a 420×640 conversation panel, and send typed prompts or final speech transcripts into the followed session. The plugin only observes waterfalls and reads the Session log, so profiles without it keep the standard app. Choose it for a lightweight always-on-top character surface; use the ordinary Web client when you need the full tool, file, and approval UI.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin row in a `cordis.yml` patch (or run `dsh plugin --profile <name> add @deepseek-ai/dsh-pixies`), then launch the desktop shell from `apps/pixies`.

### When to choose it

Choose the companion for a lightweight, always-on-top conversation surface; keep the standard Web client when you need the full tool, file, and approval UI.

### Minimal configuration

The bundle patch inserts the Host row; the Web client resolves the Client face from the package manifest. All four config fields are optional.

```yaml
- id: pixies
  name: '@deepseek-ai/dsh-pixies'
  config:
    character: spider-man
    enabled: true
    observeApproval: true
    observeQuestions: true
```

| Field | Default | Meaning |
|---|---|---|
| `character` | `spider-man` | Character id passed to the client presentation. |
| `enabled` | `true` | Master switch; `false` registers the service only. |
| `observeApproval` | `true` | Observe and delegate `approval/request`. |
| `observeQuestions` | `true` | Observe and delegate `user-questions/request`. |

Build and launch commands, credential discovery, and tray and shortcut behavior are documented in the [Pixies desktop app](../../../apps/pixies/README.md).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host plugin registers `ctx.pixies`, keeps the latest presentation per session, and emits `pixies/presentation` and `pixies/interaction`. It derives presentations from `assistant/message` through a pure, replay-stable fold and always calls `next()` in the observed waterfalls. When `DSH_PIXIES_SHELL=1`, it injects shell markers and hide-the-standard-UI styles into the served page; the Client function plugin then mounts the full-window shell, follows the live session, and folds events into a bounded store.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, delegating waterfall observers, and Session event fold. |
| [`src/client/index.ts`](src/client/index.ts) | Client function plugin and session binding. |
| [`src/client/conversation.tsx`](src/client/conversation.tsx) | Draggable avatar, expanded panel, composer, and status bubbles. |
| [`src/client/window-drag.ts`](src/client/window-drag.ts) | Thresholded pointer drag across displays. |
| [`src/client/feed.ts`](src/client/feed.ts) | Session event folding into the visible store. |
| [`src/client/locale.ts`](src/client/locale.ts) | Locale-owned product copy. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Pixies desktop app](../../../apps/pixies/README.md) — build commands, credentials, tray, and global shortcut.
- [Host plugin entry](src/index.ts) — service and event registration.
- [Client function plugin](src/client/index.ts) — session following and store wiring.
- [Conversation UI](src/client/conversation.tsx) — avatar, panel, composer, and status bubbles.

<a id="model-experience"></a>
## Model Experience

### Session presentation and interaction observation

#### What the model sees

The plugin registers no tool, prompt section, or model-visible Session event: it folds the already-logged `assistant/message` stream into `pixies/presentation` and observes the `approval/request` and `user-questions/request` waterfalls into `pixies/interaction`, both emitted for the desktop client only.

#### Token effect

A typed prompt or a final speech transcript queued through `promptPixiesSession` reaches the model as one ordinary user message; the character UI adds no extra text, tool schema, or guidance to the request.

#### KV Cache effect

The plugin adds no request prefix; the composed prompt and existing tool schemas keep their prefix stability.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Spider-Man only** — `character` is an open config field, but the desktop avatar renders one illustrated spider mask; other ids do not change the artwork.
- **macOS speech input** — final transcripts come from the bundled Swift `PixiesSpeech` helper; other platforms can type prompts but have no microphone capture.
- **In-memory history** — `store.ts` keeps a bounded conversation history for the current window; closing the Electron window drops the visible messages while the Session log persists.
- **One floating window** — the mini and expanded modes share a single window anchored to the current display work area; there is no multi-character or multi-session layout.

<a id="dev-note"></a>
### Dev Note

None.
