# Pixies 托盘壳

[English](README.md) | 中文

`apps/pixies` 是 DeepSeek Harness 的 macOS 菜单栏客户端形态：托盘入口、全局快捷键、以及钉在
屏幕右上角的无边框置顶悬浮窗。它逐字复用 desktop 的 host 链路（帧协议 + 私有
`@deepseek-ai/dsh-desktop-host` 子进程），不开放任何监听端口，与 `apps/desktop` 的安全姿态一致。

状态：**仅开发运行**。`scripts/dev.ts` 构建工作区、准备一次性项目（与 `dev:desktop` 相同）、启动
Electron。发布打包流水线仍然延后；卡通 client 半与语音输入已交付（见"行为"）。

## 运行

```sh
pnpm run build
pnpm run build:speech   # compile the Swift SFSpeechRecognizer CLI to lib/pixies-speech
pnpm run dev:pixies
```

三条命令分别是：构建工作区、把 Swift SFSpeechRecognizer CLI 编译到 `lib/pixies-speech`、启动
开发运行。

开发状态位于 `apps/pixies/.pixies-build/development`：`home`（Harness home）、`project`（一次性
profile）、`electron-user-data`。点击托盘切换悬浮窗；`Cmd/Ctrl+Shift+P` 唤起；托盘右键菜单退出。

## 行为

- 窗口默认是钉在右上角的 96×96 迷你头像（"露头"）；点击展开为 420×640 面板，收起按钮缩回
  （`window.dshPixies` 桥，`src/chrome.ts` 的 mini/expanded 双态）。
- 麦克风按钮驱动 Swift `SFSpeechRecognizer` CLI 子进程（`speech/PixiesSpeech.swift`）：partial 转写
  填充"聆听中"气泡，final 转写排队发进当前跟随的会话。首次使用会为开发壳触发 macOS 麦克风 +
  语音识别授权弹窗；启动器会自动把 `NSSpeechRecognitionUsageDescription` 补写进 Electron.app
  （Electron 自带只有麦克风键）。

## 结构

- `src/main.ts` — Electron 入口：`dsh-app://` 协议、host 子进程、托盘 chrome、IPC handler。
- `src/chrome.ts` — facade 化的托盘/窗口/快捷键生命周期（mini/expanded 双态），无需 Electron 即可单测。
- `src/preload-app.ts` — 沙箱化 preload 桥（`window.dshPixies`）：窗口展开/收起、语音启停、
  speech/mode 事件流。
- `src/speech.ts` — `pixies-speech` 子进程的 Node 侧控制器（NDJSON 流解析，二进制缺失时 fail-soft）。
- `speech/PixiesSpeech.swift` — Swift SFSpeechRecognizer CLI（`probe` / `listen`）。
- `src/host-process.ts` / `src/host-protocol.ts` — desktop 帧管道载体的逐字副本。
- `src/icon.ts` — 运行时确定性生成菜单栏红点 PNG（仓库内无二进制资产）。
- `scripts/dev.ts` — 构建 + 一次性项目 + Electron 启动器。
- `tests/` — chrome facade 与语音控制器的单元测试。

## 已知限制与后续工作

- 仅开发运行，暂无发布打包流水线。
- 语音识别依赖开发壳的 macOS TCC 授权；自动冒烟覆盖桥与子进程管线，真实识别在首次使用时人工验证。
- 托盘图标为纯红点，尚未做菜单栏主题适配的 template 图。
