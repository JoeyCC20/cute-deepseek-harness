# Pixies

This folder is the handoff surface for Pixies work. Read the page that matches your question instead of re-deriving the three Pixies trees from source at the start of every session; all four pages describe current behavior, not change history.

## Pages

| Page | Read it when |
|---|---|
| [Architecture](architecture.md) | You need the process topology, package boundaries, or the event-to-transcript dataflow. |
| [Core components](components.md) | You need the owning layer and entry symbol for a Pixies behavior. |
| [Features](features.md) | You need the user-visible capabilities and the limits that shape them. |
| [Behavior map](behavior-map.md) | You need the current contract behind a conversation or result-panel requirement and its verification path. |

## Scope

Pixies spans three additive trees: `apps/pixies` owns the Electron shell, `packages/extensions/pixies` owns the Host plugin and the React client, and `packages/extensions/pixies-panel` owns the `show_result_panel` tool. Package-owned contracts stay in the three READMEs; this folder owns cross-tree orientation and the behavior map.

## Where contracts live

- Generated tool, config, and module-graph entries stay authoritative in `docs/tool-catalog.md`, `docs/config-catalog.md`, and `docs/module-graph.md`.
- Design rationale stays in Agent Notes; this folder states the resulting contract once and links to the owning module.
- Per-package behavior and known limitations stay in `apps/pixies/README.md`, `packages/extensions/pixies/README.md`, and `packages/extensions/pixies-panel/README.md`.
