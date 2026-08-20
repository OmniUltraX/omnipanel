## Why

命令栏模式下 `ls` 结果可点：目录发 `cd`、文件开预览。直连（`inputMode = interactive`）只有 xterm 字符缓冲，同样操作点不了。仓库里已有 `useTerminalFileLinkProvider`，但写死 `enabled: false`，且识别范围、行坐标、目录行为都对不齐命令栏。现在要把直连左键补齐到同一套心智。

## What Changes

- 仅在直连 / live-native xterm 上启用路径链接（命令栏仍走 `LsListingView`，不改）。
- 点击**目录** → 向当前 PTY 发送 `cd`（与命令栏 `terminalCdCommand` 同一套路径语义）。
- 点击**文件** → `tryOpenTerminalFilePreview`（与命令栏同一入口、同一门禁）。
- 扩展识别：除带 `/` 或盘符的 token 外，覆盖 `ls` 网格里的裸文件名；用颜色 / `ls -F` 后缀 / 必要时 stat 区分目录与文件。
- 修正现有 ILink 行号写死为 `y: 1` 的定位错误。
- 全屏鼠标协议应用（vim / less / htop）激活时不抢点击。

## 目标

- 直连会话里点 `ls` 出来的目录会进入该目录，点文件会打开预览窗。
- 识别足够准，不把 man page / git log 里的普通词大批量变成链接。
- 与命令栏共用预览与 `cd` 路径工具，不新造预览协议。

## 非目标（Non-goals）

- 第一版不做右键菜单（复制路径、在 SFTP 中显示等）。
- 不把 `LsListingView` HTML 盖到 xterm 格子上。
- 不改命令栏 / Warp Block Feed 既有列表点击。
- 不新增 Rust IPC / specta 命令（stat 只用现有 SFTP / 本地文件命令）。
- 不在 OSC 8 上做 ls 注入（不改远端 `ls` 别名）。

## 背景与动机

Phase 1 终端（`/terminal`）与 SSH 直通已是主路径。命令栏把 `ls` 解析成结构化卡片，直连没有这块 DOM。用户明确要求直连「跟命令栏模式一样」：**目录 cd、文件预览**；右键可后做。

## 成功标准

- 直连本地 / SSH 会话：`ls` 后点击目录，PTY 执行 `cd` 且 cwd 更新；点击文本类文件打开既有预览窗。
- 带 `/` 的绝对/相对路径同样可点。
- vim / htop 等开启鼠标跟踪时，链接不拦截鼠标。
- 命令栏模式行为不变。
- `cd frontend && npx tsc -b` 通过；路径识别有 vitest。

## Capabilities

### New Capabilities

- `direct-terminal-path-clicks`: 直连 xterm 中文件/目录左键：识别、分类、cd / 预览、鼠标协议让路

### Modified Capabilities

- （无既有 `openspec/specs/` capability）

## Impact

- **Phase / 路由**：Phase 1 终端；`/terminal` 与 SSH 直连会话
- **前端**：`useTerminalFileLinkProvider.ts`、`terminalFileLinks.ts`、`useTerminal.ts`、`TerminalView.tsx`；复用 `terminalFilePreviewStore`、`terminalCdCommand` / `shellCdCommand`
- **后端 / IPC**：无新命令；分类若走 stat，只用现有本地/SFTP 列举或 stat
- **环境**：只读预览 + 用户主动点击才 `cd`；不涉及生产库写操作
