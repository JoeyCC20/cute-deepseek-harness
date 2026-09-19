# dsh-pixies

[English](README.md) | 中文

Pixies 菜单栏角色客户端，宿主半。Electron 壳（Phase 2，`apps/pixies`）展示可定制的卡通形象——先做蜘蛛侠——
用气泡框播报 agent 输出并对权限询问做出反应；本包是喂给它的宿主侧大脑，不触碰任何既有组合代码。

## 职责

`dsh-pixies` 是纯增量的 Cordis 插件：从不认领 answerer 链，也从不修改既有包。

- **Waterfall 观察**。以委托型观察者监听 `approval/request` 与 `user-questions/request`：每个
  handler 记录待处理的交互、发出 `pixies/interaction`，并**始终调用 `next()`**。既有 answerer
  链及其 fail-closed 语义被完整保留。
- **会话展示**。通过纯函数、回放稳定的 `presentationFromAssistantMessage`，把 `assistant/message`
  会话事件折叠成气泡展示（`pixies/presentation`）。同样的输入产生同样的输出——实时流与录制会话
  回放一致。
- **服务**。`ctx.pixies` 维护每个会话的最新展示（`latest(sessionId)`），并把每条展示发布到
  `pixies/presentation`。

## 事件

| 事件 | 模式 | 载荷 | 含义 |
|---|---|---|---|
| `pixies/presentation` | emit | `PixiesPresentation` | 角色可以开口的一条气泡。 |
| `pixies/interaction` | emit | `PixiesInteraction` | 审批或提问进入 answerer 瀑布流（已观察、已委托）。 |

## 配置

```yaml
- id: pixies
  name: '@deepseek-ai/dsh-pixies'
  config:
    character: spider-man   # which character speaks (open set; spider-man today)
    enabled: true           # master switch
    observeApproval: true   # observe (and delegate) approval/request
    observeQuestions: true  # observe (and delegate) user-questions/request
```

代码块内的字段含义：`character` 由哪个角色开口（开放集合；当前为 spider-man）、`enabled` 总开关、
`observeApproval` 观察（并委托）`approval/request`、`observeQuestions` 观察（并委托）
`user-questions/request`。

## 不改既有代码的启用方式（三选一）

```sh
# 1) bundle install (auto-appends to dsh.profile.bundles)
dsh plugin --profile web add /path/to/dsh-pixies

# 2) one-off overlay
dsh --profile web --patch ./pixies.cordis.yml

# 3) home-level overlay (all profiles)
echo '- insert: [{ id: pixies, name: "@deepseek-ai/dsh-pixies" }]' >> "$DSH_HOME/cordis.patch.yml"
```

三条路径分别是：bundle 安装（自动追加进 `dsh.profile.bundles`）、一次性 overlay、home 级
overlay（对所有 profile 生效）。

## 状态

Phase 1（宿主半）、2b（浏览器半）、2c（shell 集成）、3（迷你"露头"窗 + 语音输入）已完成。

- **宿主半**（`src/index.ts`）：如上，waterfall 观察 + 会话展示折叠。
- **浏览器半**（`src/client`，`@deepseek-ai/dsh-pixies/client`）：client 函数插件（`pixies-client`，
  注入 `remote` 与 `sessions`），把转发而来的 `approval/request` / `user-questions/request` waterfall
  观察进窗口内共享 store（**始终 `next()` 委托**），经 `feedSessionEvent` 复用同一纯折叠，并跟随
  当前会话（`followPixiesSession`：只把晚于绑定时刻的输出送给角色——历史绝不回放），导出蜘蛛侠角色
  组件（`PixiesCharacter` / `PixiesBubble` / `PixiesPanel` / 麦克风与收起按钮）以及全窗挂载入口
  （`mountPixiesShell`）。面板文案 locale-owned、由 props 注入。
- **Shell 集成**（Phase 2c）：pixies 壳运行时（`DSH_PIXIES_SHELL=1`），宿主向服务的页面注入 shell
  标记与隐藏标准应用 UI 的样式，client 挂载角色 overlay。不带该 env 的桌面/Web 照常渲染标准应用。
- **迷你"露头"窗 + 语音输入**（Phase 3）：悬浮窗默认是钉在右上角的 96×96 迷你露头头像（点击展开
  面板，收起按钮缩回）；麦克风按钮驱动 Swift `SFSpeechRecognizer` CLI 子进程（`apps/pixies/speech`），
  partial 转写填充"聆听中"气泡，final 文本经 `promptPixiesSession` 排队发进当前跟随会话。

验证方法与留档证据位于 `test-validation/pixies/`。
