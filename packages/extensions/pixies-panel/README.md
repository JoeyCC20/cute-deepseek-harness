---
description: "The model-facing show_result_panel tool for Pixies' standalone result panel, for users and maintainers composing or debugging desktop result presentations."
kind: "package-reference"
---

# @deepseek-ai/dsh-pixies-panel

English | [中文](README.zh.md)

## Summary

`show_result_panel` lets a model present a concrete result outside the transcript: images, text, clickable links, and short choices. Pixies renders the payload in a standalone, translucent panel at the screen's top right. This package owns only the tool schema, one bounded payload parser, the `tool/result.meta` projection, and the question encoding that carries the payload to the panel. Whether a model can call the tool, and whether it can interpret images, depends on that model's own capabilities.

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

Compose this plugin wherever the model should be able to show a result in Pixies' desktop panel. It registers `show_result_panel` on `ctx.tools` and uses the `ctx.userQuestions` seam for every call: choice items wait for a human answer, while a display-only question lets the panel answerer acknowledge a non-interactive panel immediately. The Pixies desktop app supplies the answerer and the window.

### When to call the tool

The model calls `show_result_panel` when it has a concrete result worth seeing outside the transcript: an image, a computed or queried result, a set of links, or a short choice the user must make. It decides for itself whether a result benefits from a panel; short answers, intermediate reasoning, and progress updates do not.

```json
{
  "title": "Build result",
  "items": [
    { "kind": "text", "content": "42 passing, 0 failing", "format": "plain" },
    { "kind": "image", "source": "/tmp/report.png", "alt": "Coverage chart" },
    { "kind": "link", "label": "Full report", "url": "https://example.com/report" },
    { "kind": "choice", "question": "Publish it?", "options": [{ "label": "Yes" }, { "label": "No" }] }
  ]
}
```

### What the model gets back

The tool returns `{ "shown": true, "items": 4, "answers": [...] }`. A `choice` item pauses the call until the panel answerer returns; the selected labels are echoed with the stable id of their item. A display-only question carries a non-interactive payload and is acknowledged at once, so no human decision is required.

### Image sources and links

`image.source` accepts a local filesystem path or an absolute http(s) URL; other schemes are refused at the wire boundary. `link.url` accepts only absolute http(s) URLs, opened in the default browser. Local images are served through the Pixies Host file route, so the panel never loads a `file:` URL.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/types.ts` is the single structural parser shared by the tool body and the panel renderer. It normalizes raw arguments into a bounded payload, validates local and remote references, and projects the durable `tool/result.meta` fact so live and replayed sessions agree. The panel payload travels to the Client inside the first panel question's `detail`, marked by a dedicated `header`; this reuses the forwarded `user-questions/request` event and needs no new Session event. A panel without choices sends one display-only question that the answerer acknowledges with no answers.

### Source map

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Tool registration, schema, execute path, render, and presentation meta. |
| [`src/types.ts`](src/types.ts) | Wire-safe payload, parser, question encoding, and result-meta projection. |
| — | No runtime invariant companion is published because the tool owns no independent lifecycle stream; its only cross-boundary relation is the user-questions waterfall owned by that seam. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-pixies-panel) — the generated `show_result_panel` schema.
- [Pixies desktop app](../../../apps/pixies/README.md) — the standalone panel window, auto-hide settings, and launch behavior.
- [Pixies package](../pixies/README.md) — the Host and Client plugin that consumes this tool's presentation.
- [user-questions seam](../../interaction/user-questions/README.md) — the waterfall that carries choice items to an answerer.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`show_result_panel` schema](../../../docs/tool-catalog.md#deepseek-aidsh-pixies-panel): an optional `title`, a bounded `items` array, and the `kind`-specific fields for image, text, choice, and link items. The description leaves the decision to call the tool to the model itself, and also documents the `[voice]...[/voice]` marker: a long or detailed text reply carries one short spoken takeaway, while the full reply stays readable in the transcript.

#### Token effect

A fixed schema cost on every request where the tool is visible; a call adds only its arguments and canonical result.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

The full arguments stay in the assistant tool-call. The next step sees the rendered text `Shown a result panel with N item(s).` plus any choice answers as compact JSON; the panel's visual state, its auto-hide timer, and the user's clicks are not model context.

#### Token effect

Arguments and answers are data-dependent retained tokens; the panel itself costs no tokens.

#### KV Cache effect

Append-only; newly visible results follow the reusable request prefix and do not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the tool is a poor fit. They are current package constraints, not a UI backlog.

- **No answerer means no panel** — every call needs a panel answerer that claims the marked `user-questions/request`; without one the call fails instead of degrading.
- **A non-interactive panel borrows a display-only question** — a generic question UI that claims the request before the panel answerer can show a placeholder prompt; the Pixies desktop app mounts the panel answerer first.
- **Panels are bounded and transient** — at most twelve items per call, and the window is a lightweight presentation surface, not a document viewer or a durable record; the Session log holds the durable `tool/result.meta` fact.
- **Local images need the Pixies Host** — a local path renders only where the Host file route is available; remote images require an absolute http(s) URL.
- **Markdown renders; raw HTML does not** — `format: 'markdown'` renders GFM headings, lists, tables, bold, fenced code and links (links open externally); raw HTML stays literal for safety. Prefer Markdown for structured results.
- **No new Session event** — the panel is a pure projection of `tool/call` arguments and `tool/result.meta`, so sessions recorded before this plugin existed cannot reconstruct a panel.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Pixies bundle patch mounts the plugin; the desktop app owns the window, the settings file, and the auto-hide timer. Keep `src/types.ts` free of Electron and DOM references so the Client can import its `/types` subpath.

</details>
