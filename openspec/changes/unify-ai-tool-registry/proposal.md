## Why

当前 AI 工具（MCP 工具）的定义分散在四处各写一份、互不同步：Rust 的 `native::input_schema_for`、前端 `moduleMcpCatalog`/`modules/*/ai/mcpTools.ts`、OmniMCP 的 `builtin.rs`（schemars）、以及 ACP 的 `client_tools.rs`（硬编码 prompt）。这直接导致线上事故：DeepSeek（HTTP 直连）调用 `omni_terminal_run_terminal_command` 时参数为空 `{}`——因为注入模型的 schema 缺 `command` 字段。同时工具开关（`internal_enabled` / `external_exposed`）与模块开关的联动存在语义漏洞，三条执行路径（HTTP / ACP / OmniMCP）行为不一致。此为 Phase 1 AI 基座的正确性问题，必须先夯实再继续扩展工具生态。

本次重构确立「后端为唯一真相源」，让工具定义、schema、执行类型集中一处，三条路径共用同一份，并与配置开关正确关联。

## What Changes

- **新增后端工具 spec 单一真相源**：以 Rust 静态 `ToolSpec`（name / module_key / description / input_schema / exec_kind）集中定义全部内置工具，取代分散的硬编码 schema。
- **DB 持久化 schema**：`mcp_tools` 表新增 `input_schema` 列；`McpToolRecord` 带出 schema；种子/修复以 spec 为准写入（保留用户开关）。
- **三路径共用工具清单与 schema**：
  - HTTP DirectInject 从 registry 读 schema（修复空参数）。
  - **BREAKING（内部行为）** ACP `client_tools` 由「硬编码单终端工具」改为从 registry 动态生成，尊重开关与模块状态；顺带修复 `client_tools.rs` 中重复拼接数十次 `Respond now:` 的 bug。
  - OmniMCP `builtin.rs` 对外工具列表由 spec 派生并按 `external_exposed` 过滤，消除「设置页承诺可暴露 terminal/database，实际只暴露 knowledge」的不一致。
- **开关语义修复**：`external_exposed` 增加模块 open 校验；模块重新 open 时恢复被动禁用的工具；`load_skill` 纳入 spec 统一管理；停止 `enabled` 遗留列双写。
- **定义前端 IPC 契约**：`mcp_tool_list` 返回含 `input_schema`，供前端渲染/校验（前端当前为假数据、真实对接不在本次范围）。

## Capabilities

### New Capabilities

- `ai-tool-registry`: AI 工具的单一真相源定义与持久化——`ToolSpec` 静态清单、`input_schema` 落库、registry 装配与执行类型分类、对前端暴露的查询契约。
- `ai-tool-gating`: 工具可用性与开关治理——`internal_enabled` / `external_exposed` 语义、与模块 open 状态的双向联动、模块重开恢复策略、`load_skill` 等系统工具纳管。
- `ai-tool-runtime`: 三条工具注入与调用路径（HTTP DirectInject、ACP client-tools、OmniMCP 对外）共用同一工具清单与 schema、统一过滤与结果回传契约。

### Modified Capabilities

<!-- openspec/specs/ 目前为空，无既有能力被修改。 -->

## Impact

- **crates/omnipanel-mcp**：新增 `registry/spec.rs`；改 `registry/mod.rs`、`registry/native.rs`、`manager.rs`、`builtin.rs`。
- **crates/omnipanel-store**：`mcp_tool.rs` 表结构迁移（新增 `input_schema` 列）、`McpToolRecord`、种子/修复/开关逻辑；`app_module.rs` 联动。
- **crates/omnipanel-ai**：`providers/acp/client_tools.rs` 动态化、`providers/acp/mod.rs` 调用点。
- **src-tauri/src/commands**：`ai_chat.rs`（ACP 分支接入 registry 工具清单）、`mcp_tool.rs`（命令返回带 schema、external 校验）。
- **IPC/前端契约**：`tauri-specta` 自动重生成 `frontend/src/ipc/bindings.ts`（`McpToolRecord` 增字段）；前端真实对接后续单独进行。
- **数据迁移**：旧库经列迁移平滑升级；schema/描述以代码为准会覆盖历史值，用户开关保留。
- **环境标签与确认策略**：终端/数据库工具仍走既有危险命令拦截与 prod 二次确认，本次不改变执行侧安全基线，仅统一「工具是否被注入/可调用」的判定。
