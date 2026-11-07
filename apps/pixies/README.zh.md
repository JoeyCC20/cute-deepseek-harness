# Pixies 桌面伙伴

[English](README.md) | 中文

`apps/pixies` 是 DeepSeek Harness 的 macOS 菜单栏客户端形态：一个始终可见、可任意拖拽的蜘蛛侠
悬浮头像，点一下就能开始真正的对话。它逐字复用 desktop 的 host 链路（帧协议 + 私有
`@deepseek-ai/dsh-desktop-host` 子进程），不开放任何监听端口，与 `apps/desktop` 的安全姿态一致。

这个功能拥有的全部代码都在两个新增目录 —— `apps/pixies` 与 `packages/extensions/pixies` —— 不修改
主工程任何既有文件，因此可以随时拉取主工程更新而不产生冲突。

## 运行

```sh
pnpm run build             # build the workspace once
pnpm run build:speech      # Swift SFSpeechRecognizer CLI + embedded TCC Info.plist
pnpm run dev:pixies        # full rebuild + prepared project + Electron
pnpm run start:pixies      # reuse the prepared project and launch immediately
```

开发状态位于 `apps/pixies/.pixies-build/development`：`home`（Harness home）、`project`（一次性
profile）、`electron-user-data`，以及自动补齐的 `office-skills`。启动后窗口即显示；点击托盘切换显示，
`Cmd/Ctrl+Shift+P` 唤起，托盘右键菜单提供显示/隐藏、重置位置与退出。需要调试渲染进程时设置
`DSH_PIXIES_OPEN_DEVTOOLS=1`。

凭证来自仓库根目录 `.env`（开发模式通过 `DSH_PIXIES_ENV_FILE` 明确指定）、`~/.config/dsh/env`
或 shell rc 文件；预启动注入器不会覆盖环境中已有的值。要拿到模型回复需要 `DEEPSEEK_API_KEY`。

## 行为

- 窗口启动即为右上角附近的 112×112 蜘蛛面具头像。在头像上任意位置拖拽即可跨显示器移动，每次
  拖拽结束只持久化一次位置。短按（非拖拽）展开 420×640 面板，收起按钮、托盘或 `Escape` 可缩回；
  模式切换以头像当前位置为中心伸缩，不会跳回默认角落。
- 展开面板是一段完整对话：可滚动的用户/助手/系统消息历史、文本输入区（`Enter` 发送、
  `Shift+Enter` 换行）与麦克风按钮。思考中、聆听中、语音错误、turn 失败都有可见状态，失败不再静默。
- 文本消息与语音 final 转写都通过 `promptPixiesSession` 排队进入当前跟随的会话，助手回复会流式
  追加到历史中。窗口模式由主进程持有，渲染进程挂载时会主动对齐。
- 麦克风按钮先由有窗口的主进程申请麦克风权限，再驱动 Swift `SFSpeechRecognizer` CLI 子进程
  （`speech/PixiesSpeech.swift`）：partial 转写填充"聆听中"气泡，final 转写作为一条消息发出。
  首次使用会触发 macOS 麦克风与语音识别授权弹窗。`build:speech` 会把 `speech/Info.plist`
  内嵌进 helper 并做 ad-hoc 签名；开发启动器通过 LaunchServices 启动 Electron，让 TCC 把授权
  归给 Pixies 自己的 bundle，而不是启动它的 IDE 或终端。
- 托盘使用抗锯齿的蜘蛛面具 template 图，菜单栏明暗主题会自动重新着色。

## 结构

- `src/main.ts` — Electron 入口：`dsh-app://` 协议、desktop boot 契约与 WebSocket 头鉴权、host 子进程、
  托盘 chrome、IPC handler、启动即显示。
- `src/chrome.ts` — facade 化的托盘/窗口/快捷键生命周期：mini/expanded 双态、多显示器拖拽边界、
  锚定伸缩、位置持久化；无需 Electron 即可单测。
- `src/host-proxy.ts` — 回环转发、desktop boot 载荷、WebSocket upgrade 鉴权。
- `src/preload-app.ts` — 沙箱化 preload 桥（`window.dshPixies` 与 `dshDesktopBoot`）。
- `src/speech.ts` — `pixies-speech` 子进程的 Node 侧控制器（NDJSON 流解析；二进制缺失、启动失败或
  异常退出都会发出可见的 error 事件）。
- `speech/PixiesSpeech.swift` — Swift SFSpeechRecognizer CLI（`probe` / `listen`）。
- `speech/Info.plist` — 内嵌进 helper 的 TCC 用途说明，构建时做 ad-hoc 签名。
- `scripts/launch-services.ts` — 负责承载应用隐私授权的 LaunchServices 开发启动器。
- `src/host-process.ts` / `src/host-protocol.ts` — desktop 帧管道载体的逐字副本。
- `src/icon.ts` — 运行时确定性生成托盘红点与蜘蛛面具 template PNG。
- `src/pixies-keychain.cjs` — 预启动凭证注入（构建时由脚本复制进 `lib/`）。
- `scripts/dev.ts` — 构建 + 语音 helper 重编译 + 复用一次性项目 + LaunchServices 启动器。
- `scripts/stage.ts` — profile/bundle 装配与 Office-skill 资产补齐。
- `tests/` — chrome facade、转发器、图标、凭证注入与语音控制器的单元测试。

React 界面位于并列的新增插件 `packages/extensions/pixies/src/client`：`conversation.tsx`（头像 +
展开面板）、`character.tsx`（插画级 SVG 面具）、`window-drag.ts`（带阈值的指针拖拽）、`store.ts`
（会话历史）、`feed.ts`（会话事件）、`shell.tsx`（挂载 + 输入路由）、`locale.ts`（locale-owned 文案）。

## 已知限制与后续工作

- 语音识别需要为 Pixies bundle 一次性授予 macOS 麦克风与语音识别权限。若被拒绝，面板会直接显示
  拒绝原因，而不会一直停在"聆听中"；自动冒烟覆盖桥与子进程管线，真实识别在首次使用时人工验证。
- 已有 macOS 打包脚本（`scripts/package-mac.ts`），但主要支持的路径仍是上面的开发启动器。
