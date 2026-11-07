---
description: "为 dsh profile 添加可拖拽的蜘蛛侠桌面伙伴：观察审批与提问 waterfall，把助手回复折叠成气泡，并在悬浮 Electron 窗口中对话。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-pixies

[English](README.md) | 中文

## 概述

在 profile 中挂载 `@deepseek-ai/dsh-pixies`，即可添加一个会播报助手回复、并对审批做出反应的悬浮蜘蛛侠伙伴。启动 Pixies 桌面应用后，可以跨显示器拖拽 112×112 头像，短按展开 420×640 对话面板，把文本消息或语音最终转写发进当前跟随的会话。插件只观察 waterfall 并读取会话日志，因此未挂载它的 profile 仍照常使用标准应用。需要轻量的置顶角色界面时选择它；需要完整的工具、文件与审批 UI 时使用常规 Web 客户端。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `cordis.yml` patch 中挂载该插件行（或运行 `dsh plugin --profile <name> add @deepseek-ai/dsh-pixies`），然后从 `apps/pixies` 启动桌面壳。

### 何时选择

需要轻量的置顶对话界面时选择这个伙伴；需要完整的工具、文件与审批 UI 时保留标准 Web 客户端。

### 最小配置

bundle patch 插入宿主行；Web 客户端按包的 manifest 声明解析 client 面。四个配置字段都是可选的。

```yaml
- id: pixies
  name: '@deepseek-ai/dsh-pixies'
  config:
    character: spider-man
    enabled: true
    observeApproval: true
    observeQuestions: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `character` | `spider-man` | 传给客户端展示的角色 id。 |
| `enabled` | `true` | 总开关；`false` 时只注册服务。 |
| `observeApproval` | `true` | 观察并委托 `approval/request`。 |
| `observeQuestions` | `true` | 观察并委托 `user-questions/request`。 |

构建与启动命令、凭证发现，以及托盘和快捷键行为见 [Pixies 桌面应用](../../../apps/pixies/README.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

宿主插件注册 `ctx.pixies`，维护每个会话的最新展示，并发出 `pixies/presentation` 与 `pixies/interaction`。它通过纯函数、回放稳定的折叠从 `assistant/message` 派生展示，并在所观察的 waterfall 中始终调用 `next()`。当 `DSH_PIXIES_SHELL=1` 时，它向所服务的页面注入 shell 标记与隐藏标准 UI 的样式；随后 client 函数插件挂载全窗 shell、跟随当前会话，并把事件折叠进有上限的 store。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、委托型 waterfall 观察者与会话事件折叠。 |
| [`src/client/index.ts`](src/client/index.ts) | client 函数插件与会话绑定。 |
| [`src/client/conversation.tsx`](src/client/conversation.tsx) | 可拖拽头像、展开面板、输入区与状态气泡。 |
| [`src/client/window-drag.ts`](src/client/window-drag.ts) | 带阈值的跨显示器指针拖拽。 |
| [`src/client/feed.ts`](src/client/feed.ts) | 把会话事件折叠进可见 store。 |
| [`src/client/locale.ts`](src/client/locale.ts) | 由 locale 持有的产品文案。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Pixies 桌面应用](../../../apps/pixies/README.zh.md) — 构建命令、凭证、托盘与全局快捷键。
- [宿主插件入口](src/index.ts) — 服务与事件注册。
- [client 函数插件](src/client/index.ts) — 会话跟随与 store 接线。
- [对话 UI](src/client/conversation.tsx) — 头像、面板、输入区与状态气泡。

<a id="model-experience"></a>
## 模型体验

### 会话展示与交互观察

#### 模型所见

该插件不注册工具、提示词段落或模型可见的会话事件：它把已记录的 `assistant/message` 流折叠成 `pixies/presentation`，并把 `approval/request` 与 `user-questions/request` waterfall 观察为 `pixies/interaction`，两者都只发给桌面客户端。

#### Token 影响

经 `promptPixiesSession` 排队的文本消息或语音最终转写以一条普通用户消息到达模型；角色 UI 不会给请求增加额外文本、工具 schema 或指导。

#### KV Cache 影响

插件不添加请求前缀；已组合的提示词与既有工具 schema 保持原有的前缀稳定性。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅蜘蛛侠** — `character` 是开放的配置字段，但桌面头像只绘制一张插画级蜘蛛面具；其他 id 不会改变画面。
- **仅 macOS 语音输入** — 最终转写来自随包附带的 Swift `PixiesSpeech` 辅助程序；其他平台可以输入文本，但没有麦克风采集。
- **历史仅在内存** — `store.ts` 为当前窗口保留有上限的对话历史；关闭 Electron 窗口会丢弃可见消息，而会话日志仍然保留。
- **单一悬浮窗** — 迷你与展开模式共用同一个锚定在当前显示器工作区的窗口；没有多角色或多会话布局。

<a id="dev-note"></a>
### 开发备注

无。
