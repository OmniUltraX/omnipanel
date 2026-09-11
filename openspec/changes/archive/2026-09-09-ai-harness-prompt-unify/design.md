## Context

一次终端 NL 请求把同一路由政策写进 6+ 层。Skills 摘要承诺 `load_skill`，但 `builtin_tool_is_cross_module` 不含它。HTTP `build_system_message` 注入本机时间，又要求远程 Tab 跑 `date`。

## Goals / Non-Goals

**Goals:** 一层一事；Skills/MCP 只描述本轮工具；ACP/HTTP 共用 routing 片段。

**Non-Goals:** 覆盖深度自定义提示词；模块 Agent 全量 MCP；改确认闸。

## Decisions

### 1. 分层

| 层 | 真相 | 职责 |
|----|------|------|
| L0 | `routing-policy.md` | 选工具 |
| L0b | `system-prompt.md` | 仅 ACP JSON 协议 |
| L1 | `agents/{id}.md` | 角色边界 |
| L2 | `[Terminal Context]` | shell/OS/cwd |
| L3 | `builtin_tool_spec.rs` | 参数契约 |
| L4 | 用户原话 | 禁止追加军令 |

### 2. HTTP 现场

去掉 `Current local date-time`。已有 Terminal Context 的 Working directory 时不再写 `Current working directory`。Resource id 标明仅供 `omni_ssh_*`。

### 3. Skills

`load_skill` + `omni_skill_recall` 进 cross-module。摘要仅在本轮有 `load_skill` 时承诺该工具。勾选 id 从目录去掉。

### 4. Native 映射

本轮有 `omni_files_*` 时 Read/Write 走 files；否则走当前 Tab exec，命令按 shell 选 Unix vs PowerShell。

## Risks

- 官方提示词迁移误伤自定义：仅当仍像官方标题才整篇替换。
- 去掉 user 军令后弱模型少调工具：L0+L2+L3 仍在；用「当前的时间」回归。
