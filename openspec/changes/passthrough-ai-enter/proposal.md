## Why

用户要对齐阿里云 WebSSH：**在真直通终端里跑 Agent 循环**——AI 输出 → 命令审核 → 真实 PTY 执行 → 采输出 → AI 再输出 → …，而不是单次「问一句出一张聊天卡」。当前直通几乎只做 PTY 透传；命令栏虽有工具审批碎片，但缺少「嵌在直通流里的连续 shell-tool 环」。

## 目标

- 在**直通模式**保持原生编辑（Ctrl+R / Tab / vim），并用智能 Enter 把自然语言**接入**终端 Agent 环（入口，不是全部）。
- 实现与 PTY 绑定的 **shell-tool Agent 循环**：
  1. AI 文本输出（解释/计划）
  2. 提出 shell 命令 + **命令级审核**（已同意 / 拒绝）
  3. 命令在**当前会话真实 PTY**执行
  4. 采集 stdout/stderr（及退出码）作为 observation
  5. 自动续轮：再输出 / 再提命令，直到任务结束或用户「开启新会话」
- 审核与写回遵守危险命令 / 环境标签 / 既有审批策略；AI 不静默执行高风险操作。
- 命令栏（Block）模式保持独立；本变更主战场是直通上的 Agent 环。

## 非目标（Non-goals）

- **不**把体验做成「复用一次内联聊天回复」；单卡问答不是成功标准。
- **不**把直通改成命令栏 UI，也**不**用 Warp Block 冒充阿里环。
- **不**在编辑期拦截 Tab / Ctrl+R；仅 Enter 分流（门闩允许时）作为入环手段。
- **不**首期做网页搜索等非 shell 工具（可后续加 tool）；MVP 主工具 = 本会话 shell 执行。
- **不**要求注入远端 `command_not_found`（可选后续）。
- **不**做赞踩运营闭环；「开启新会话」只需重置 Agent 上下文。

## 背景与动机

- 参考截图闭环：VACUUM 失败 `sqlite3: command not found` → 灯泡/观察 → AI 自动提出 `apt-get install sqlite3` → 再审核 → 再执行。
- 可复用积木：`shouldRouteInputToAi`、OSC 133、`terminalApprovalPolicy`、`inlineToolBridge` / 终端 tool-call 渲染、PTY write——但需收成**显式 Agent 环状态机**，而非一次性 `submitAiPrompt`。
- Phase：Phase 1 `/terminal` + SSH 复用终端；不阻塞 Database。

## What Changes

- **入口**：直通行缓冲 + Enter 闸门；NL → 清行 → 启动/继续终端 Agent 会话。
- **环核心**：终端 Agent runtime（会话态、流式文本块、shell tool 提案、审核、执行、observation 回灌、自动续轮）。
- **UI**：终端流内嵌 AI 文本块 + 命令审核卡（已同意等）；执行仍显示在真实 prompt 回显中。
- **门闩**：alt-screen / reverse-i-search / 命令运行中禁用 NL Enter 分流。
- 设置：启用直通 Agent、可选自动续轮；i18n；单测（门闩 + 环状态转换）。

## Capabilities

### New Capabilities

- `terminal-shell-agent-loop`: 与 PTY 绑定的 shell-tool Agent 循环（输出→审核→执行→观察→续轮→新会话）。
- `passthrough-ai-enter`: 直通自然语言 Enter 分流，作为进入/续写 Agent 环的入口。
- `passthrough-ai-gates`: alt-screen / reverse-i-search / 运行中等门闩，保证原生能力不被破坏。

### Modified Capabilities

<!-- openspec/specs/ 暂无既有能力目录 -->

## 成功标准

- 直通下普通命令 / Ctrl+R / Tab / vim 与改造前一致（门闩生效）。
- 用户用自然语言启动任务后，能看到**至少两轮**「AI 说明 → 命令卡同意 → 真执行 → 基于输出的下一步」（例如缺依赖时自动提出安装命令），而不是停在单次回复。
- 命令执行发生在当前 PTY；拒绝/新会话可打断环；危险/prod 仍需确认。
- 关闭相关设置后，直通回到纯透传。

## Impact

- 前端：`modules/terminal/`（Agent 环、审核卡、流内块）、`hooks/useTerminal.ts`（Enter 闸门）、`inlineToolBridge` / 审批策略扩展、settings / i18n。
- AI：复用现有模型调用与 tool 协议能力，编排为终端专用 loop（可能轻量新模块，避免旁路 Harness 乱聊）。
- 路由：`/terminal`、SSH/嵌入直通会话。
- 后端：优先无新 IPC；PTY 写读沿用现有。若需独立 agent turn 命令再评估 specta。
- 环境与确认：每条写回命令走审批策略。
