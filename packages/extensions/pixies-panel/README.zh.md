---
description: "Pixies 独立结果面板的模型侧 show_result_panel 工具；供组合或排查桌面结果展示的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pixies-panel

[English](README.md) | 中文

## 概述

`show_result_panel` 让模型在对话记录之外展示一个具体结果：图片、文字、可点击链接和简短选择。Pixies 把载荷渲染为屏幕右上角独立的半透明面板。本包只负责工具 schema、一个有界载荷解析器、`tool/result.meta` 投影，以及把载荷送进面板的问题编码。模型能否调用该工具、能否理解图片，取决于模型自身的能力。

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

凡模型应当能够在 Pixies 桌面面板里展示结果的场景，都可组合此插件。它在 `ctx.tools` 上注册 `show_result_panel`，并且每次调用都使用 `ctx.userQuestions` seam：`choice` 条目等待人类回答，而非交互面板由展示专用问题让 answerer 立即确认。Pixies 桌面应用提供 answerer 和窗口。

### 何时调用该工具

当模型拿到值得在对话记录之外查看的具体结果时调用 `show_result_panel`：图片、计算或查询结果、一组链接，或者用户必须做出的简短选择。是否值得开面板由模型自行判断；简短回答、中间推理和进度更新都不适合。

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

### 模型拿回什么

工具返回 `{ "shown": true, "items": 4, "answers": [...] }`。`choice` 条目会暂停调用，直到面板 answerer 返回；所选标签连同该条目的稳定 id 一起回传。展示专用问题携带非交互载荷并被立即确认，因此无需人类决策。

### 图片来源与链接

`image.source` 接受本地文件路径或绝对 http(s) URL，其他协议在 wire 边界被拒绝。`link.url` 只接受绝对 http(s) URL，用默认浏览器打开。本地图片通过 Pixies Host 的文件路由提供，因此面板不会加载 `file:` URL。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>展开实现内部细节</summary>

`src/types.ts` 是工具主体与面板渲染器共享的唯一结构解析器。它把原始参数归一化为有界载荷，校验本地与远程引用，并投影持久化的 `tool/result.meta` 事实，使实时会话与回放会话保持一致。面板载荷编码在第一个面板问题的 `detail` 中，由专用 `header` 标记；这复用了已转发的 `user-questions/request` 事件，无需新增 Session 事件。不含选择项的面板会发送一个展示专用问题，answerer 以空答案立即确认。

### 源码索引

| 文件 | 职责 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 工具注册、schema、执行路径、render 与 presentation meta。 |
| [`src/types.ts`](src/types.ts) | wire-safe 载荷、解析器、问题编码与 result-meta 投影。 |
| — | 不发布运行时 invariant companion，因为该工具不拥有独立的生命周期流；它唯一的跨边界关系是由该 seam 持有的 user-questions waterfall。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-pixies-panel) — 生成的 `show_result_panel` schema。
- [Pixies 桌面应用](../../../apps/pixies/README.zh.md) — 独立面板窗口、自动隐藏设置与启动行为。
- [Pixies 包](../pixies/README.zh.md) — 消费本工具呈现的 Host 与 Client 插件。
- [user-questions seam](../../interaction/user-questions/README.zh.md) — 把选择条目送达 answerer 的 waterfall。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`show_result_panel` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-pixies-panel)：可选的 `title`、有界的 `items` 数组，以及 image / text / choice / link 各类条目的专属字段。描述把是否调用面板的判断留给模型自己，同时也说明了 `[voice]...[/voice]` 标记：较长或细节繁多的文字回复附带一句供播报的核心结论，完整回复仍在对话页可读。

#### Token 影响

凡是该工具可见的请求都有一份固定 schema 成本；一次调用只增加它自己的参数与规范化结果。

#### KV Cache 影响

定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使该 schema 的复用失效。

### 工具调用历史与结果

#### 模型看到什么

完整参数留在 assistant 的 tool-call 中。下一步看到渲染文本 `Shown a result panel with N item(s).`，以及紧凑 JSON 形式的选择答案；面板的视觉状态、自动隐藏计时器和用户点击都不进入模型上下文。

#### Token 影响

参数与答案是随数据变化的常驻 token；面板本身不消耗 token。

#### KV Cache 影响

仅追加；新可见的结果接在可复用的请求前缀之后，不会使已有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制说明何时不适合使用该工具。它们是当前包的约束，而不是 UI 待办清单。

- **没有 answerer 就没有面板** — 每次调用都需要能认领带标记的 `user-questions/request` 的面板 answerer；缺失时调用直接失败，而不是降级。
- **非交互面板借用展示专用问题** — 若通用问题 UI 先于面板 answerer 认领请求，会显示一个占位提示；Pixies 桌面应用会先挂载面板 answerer。
- **面板有界且短暂** — 每次调用最多十二个条目，窗口是轻量呈现表面，不是文档查看器或持久记录；持久事实保存在 Session log 的 `tool/result.meta` 中。
- **本地图片依赖 Pixies Host** — 本地路径只在 Host 文件路由可用时才能渲染；远程图片必须是绝对 http(s) URL。
- **Markdown 会渲染，原始 HTML 不会** — `format: 'markdown'` 会渲染 GFM 标题、列表、表格、粗体、围栏代码与链接（链接在外部浏览器打开）；出于安全考虑原始 HTML 保持字面文本。结构化结果请优先使用 Markdown。
- **不新增 Session 事件** — 面板是 `tool/call` 参数与 `tool/result.meta` 的纯投影，因此在本插件出现之前记录的会话无法重建面板。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>展开维护者工作上下文</summary>

Pixies 的 bundle patch 挂载此插件；桌面应用持有窗口、设置文件与自动隐藏计时器。`src/types.ts` 不得引用 Electron 或 DOM，以便 Client 通过 `/types` 子路径导入。

</details>
