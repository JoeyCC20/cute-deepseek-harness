# dsh-pixies

English | [中文](README.zh.md)

Pixies menu-bar character client, host half. The Electron shell (Phase 2, `apps/pixies`) shows a
customizable cartoon character — Spider-Man first — that speaks agent output in speech bubbles and
reacts to permission prompts; this package is the host-side brain that feeds it, without touching any
existing composition code.

## Role

`dsh-pixies` is a purely additive Cordis plugin. It never claims an answerer chain and never modifies
existing packages:

- **Waterfall observation.** It listens to `approval/request` and `user-questions/request` as a
  delegating observer: each handler records the pending interaction, emits `pixies/interaction`, and
  always calls `next()`. The existing answerer chain and its fail-closed semantics are preserved.
- **Session presentation.** It folds `assistant/message` session events into speech-bubble
  presentations (`pixies/presentation`) through a pure, replay-stable function
  (`presentationFromAssistantMessage`). Same event in, same presentation out — on live streaming and
  recorded-session replay alike.
- **Service.** `ctx.pixies` keeps the latest presentation per session (`latest(sessionId)`) and
  publishes every presentation to `pixies/presentation`.

## Events

| Event | Mode | Payload | Meaning |
|---|---|---|---|
| `pixies/presentation` | emit | `PixiesPresentation` | A speech bubble is ready for the character. |
| `pixies/interaction` | emit | `PixiesInteraction` | An approval or question entered the answerer waterfall (observed, delegated). |

## Config

```yaml
- id: pixies
  name: '@deepseek-ai/dsh-pixies'
  config:
    character: spider-man   # which character speaks (open set; spider-man today)
    enabled: true           # master switch
    observeApproval: true   # observe (and delegate) approval/request
    observeQuestions: true  # observe (and delegate) user-questions/request
```

## Enabling without touching existing code

Three zero-intrusion paths (any of them):

```sh
# 1) bundle install (auto-appends to dsh.profile.bundles)
dsh plugin --profile web add /path/to/dsh-pixies

# 2) one-off overlay
dsh --profile web --patch ./pixies.cordis.yml

# 3) home-level overlay (all profiles)
echo '- insert: [{ id: pixies, name: "@deepseek-ai/dsh-pixies" }]' >> "$DSH_HOME/cordis.patch.yml"
```

## Status

Phases 1 (host half), 2b (browser half), 2c (shell integration), and 3 (mini peek window + voice
input) are done.

- **Host half** (`src/index.ts`): waterfall observation + session presentation folding, as above.
- **Browser half** (`src/client`, `@deepseek-ai/dsh-pixies/client`): a client function plugin
  (`pixies-client`, injects `remote` and `sessions`) that observes the forwarded `approval/request` /
  `user-questions/request` waterfalls into a shared in-window store (always delegating via `next()`),
  reuses the same pure fold via `feedSessionEvent`, follows the live session (`followPixiesSession`:
  only output newer than the bind time reaches the character — history is never replayed), and
  exports the Spider-Man character components (`PixiesCharacter` / `PixiesBubble` / `PixiesPanel` /
  mic + collapse buttons) plus the full-window mount (`mountPixiesShell`). Panel copy is
  locale-owned and injected via props.
- **Shell integration** (Phase 2c): when the pixies shell runs (`DSH_PIXIES_SHELL=1`), the host
  injects shell markers plus hide-the-standard-UI styles into the served page, and the client mounts
  the character overlay. Desktop/web without that env keep rendering the standard app untouched.
- **Mini peek window + voice input** (Phase 3): the floating window starts as a 96×96 top-right
  mini peek avatar (click expands the panel, the collapse button shrinks it back); the mic button
  drives a Swift `SFSpeechRecognizer` CLI subprocess (`apps/pixies/speech`) whose partial transcript
  fills a listening bubble and whose final text is queued into the followed session via
  `promptPixiesSession`.

Validation methods and recorded evidence live under `test-validation/pixies/`.
