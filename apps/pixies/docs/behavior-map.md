# Pixies behavior and implementation map

This page is a current-contract lookup for the conversation and result-panel requirements that recur in Pixies work. It states what the product does now, which modules own the behavior, and how to verify it; decision rationale stays in Agent Notes and change history stays in commits.

## Conversation presentation

Each row names one user-visible contract and the first place to look when it changes.

| Requirement | Current contract | Owning modules | Verification |
|---|---|---|---|
| Assistant replies read as documents | Assistant messages are full-width Markdown with a role header; user prompts keep a bubble. | `conversation.tsx` (`bubbleStyle`, `MessageRow`) | `shell.client.spec.tsx` |
| Every turn keeps its work in execution order | Thinking, tool calls, and tool results are independent `process` rows written when the event arrives, positioned between the prompt and the reply. | `feed.ts`, `store.ts` (`appendProcessRow`) | `feed.client.spec.ts`, `store.client.spec.ts` |
| Work is summarized, not dumped | Consecutive process rows form one collapsed `WorkGroup`; opening it lists steps and opening a step shows its text. | `conversation.tsx` (`transcriptBlocks`, `WorkGroup`, `ProcessRow`) | `shell.client.spec.tsx` |
| No separate thinking bubble | `liveBubble` yields only a speech draft or an error; the work group heading shows `copy.thinking` while running and `copy.thinkingProcess` after reasoning settles. | `conversation.tsx`, `locale.ts` | `shell.client.spec.tsx` |
| Work rows are never spoken | `lastReply` returns only assistant or system messages; reasoning and tool text never reach `speakReply`. | `shell.tsx`, `voice-summary.ts` | `shell.client.spec.tsx` |
| Long replies keep a short spoken takeaway | `[voice]...[/voice]` selects speech text; `visibleReplyText` strips the marker and the transcript keeps the complete reply. | `voice-summary.ts`, the tool description | `voice-summary.client.spec.ts` |

## Result panel

The tool description is the model-visible control surface, so its catalog entry and pairing record move with any wording change.

| Requirement | Current contract | Owning modules | Verification |
|---|---|---|---|
| Most results use the panel | The description says to call `show_result_panel` by default before the final reply, including short answers, and to skip only turns with no concrete result. | `pixies-panel/src/index.ts` (`DESCRIPTION`), `docs/tool-catalog.md` | `pixies-panel.spec.ts`, `pnpm run verify-tool-catalog` |
| Replies never announce the panel | The description bans naming the tool or panel, lists banned phrasings in English and Chinese, and requires a reply written as if the panel did not exist. | `pixies-panel/src/index.ts` (`DESCRIPTION`) | `pixies-panel.spec.ts` |
| Hovering the panel pauses auto-hide | Entering freezes the timer with the remaining delay; leaving restarts from that remainder; a pointer already over a new result pauses immediately. | `panel-settings.ts`, `main.ts` (`pausePanelHide`, `resumePanelHide`), `panel.tsx` | `panel-settings.spec.ts`, `panel-mount.client.spec.tsx` |
| Auto-hide respects reading time | Delay is the larger of the configured value and a 400-characters-per-minute estimate above a ten-second floor; choice panels, a disabled panel, and a zero delay never auto-hide. | `panel-settings.ts` (`panelHideDelay`, `panelReadingMs`) | `panel-settings.spec.ts` |

## Verification commands

Run the focused behavior checks before a broader gate; direct tool invocations work when a pnpm wrapper is blocked by a host-side dependency check.

```sh
CI=1 pnpm exec vitest run packages/extensions/pixies packages/extensions/pixies-panel apps/pixies
./node_modules/.bin/tsc -b tsconfig.client.json
./node_modules/.bin/tsx scripts/run-oxlint.ts .
./node_modules/.bin/tsdown --env.DSH_BUILD_FACE client
pnpm run test:docs
git diff --check
```

`pnpm run typecheck`, `lint`, and `build:lib:client` wrap the same tools. `verify-client-ui-i18n` reports two pre-existing control markers in `voice-summary.ts`; they are not UI copy. The detached restart helper under `apps/pixies/local-scripts/` is owner-local and ignored by Git; the supported launch commands are `pnpm run dev:pixies` and `pnpm run start:pixies`.
