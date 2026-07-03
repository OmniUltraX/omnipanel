## Context

AI 工具（MCP 工具）当前有四份互不同步的定义来源，且三条执行路径（HTTP DirectInject、ACP client-tools、OmniMCP 对外）行为分叉，已造成 DeepSeek 调终端工具参数为空 `{}` 的线上问题。相关代码：

- 后端 schema：`crates/omnipanel-mcp/src/registry/native.rs` 的 `input_schema_for`（只覆盖 knowledge，其余落空 `{}`）
- 工具装配：`crates/omnipanel-mcp/src/registry/mod.rs`（`list_enabled` / `to_tool_defs`，含硬编码 `NATIVE_TOOL_NAMES`）
- 工具存储与开关：`crates/omnipanel-store/src/mcp_tool.rs`（`mcp_tools` 表、`DEFAULT_MCP_TOOLS`、`internal_enabled` / `external_exposed` / 遗留 `enabled`）
- 模块开关：`crates/omnipanel-store/src/app_module.rs`（`DEFAULT_APP_MODULES`）
- 三路径入口：`src-tauri/src/commands/ai_chat.rs`（HTTP + ACP）、`crates/omnipanel-ai/src/providers/acp/client_tools.rs`（硬编码清单）、`crates/omnipanel-mcp/src/builtin.rs`（OmniMCP 仅 knowledge）
- 前端：`frontend/src/lib/ai/context/moduleMcpCatalog.ts` 等（当前为假数据、未真实对接）

约束：遵守分层（逻辑在 crate、`commands/` 只做薄桥接）、crate 单向依赖、IPC 走 tauri-specta 生成 bindings、不引入 PRD 未规划的重型依赖、文案与错误走既有规范。

## Goals / Non-Goals

**Goals:**

- 后端建立工具定义单一真相源 `ToolSpec`（name / module_key / description / input_schema / exec_kind）。
- `mcp_tools` 表持久化 `input_schema`，以 spec 为准写入并保留用户开关。
- HTTP / ACP / OmniMCP 三路径共用同一 registry 工具清单与 schema，统一按开关 + 模块 open 过滤。
- 修复开关语义：`external_exposed` 加模块校验、模块重开恢复被动禁用工具、`load_skill` 纳管、停止 `enabled` 双写。
- 定义前端 IPC 契约（`mcp_tool_list` 返回带 `input_schema`），并修复 `client_tools.rs` 的 `Respond now:` 重复拼接 bug。

**Non-Goals:**

- 前端 UI 的真实对接与重写（当前为假数据）——仅锁定 IPC 契约，具体对接后续单独进行。
- 新增业务工具（本次只统一现有 terminal / database / knowledge / load_skill）。
- 改变工具执行侧的安全基线（危险命令拦截、prod 二次确认、audit_log 保持不变）。
- 外部自定义 MCP 服务（extmcp）的注册模型改造，仅保证其与内置工具在装配阶段兼容。

## Decisions

### 决策 1：真相源放后端（Rust），而非前端

模型注入发生在后端（HTTP 与 ACP 均在 Rust 侧构造 prompt/tool defs），ACP 也需要 schema；前端当前为假数据。故以后端 `ToolSpec` 为权威源，DB 落库，前端经 IPC 只读消费。

- 备选：前端 catalog 为源经 `sync_catalog` 推 schema 到 DB。否决——后端仍需在前端未加载时独立注入，且 knowledge 为后端 Native 执行、前端只有 stub，反向补全成本高。

### 决策 2：新增 `registry/spec.rs` 承载静态清单，DB 落 schema 作二级缓存

`ToolSpec` 静态定义在 `crates/omnipanel-mcp/src/registry/spec.rs`；`repair_mcp_tools` 遍历 spec `INSERT OR IGNORE` 并对已存在行 `UPDATE description/input_schema/module_key`（不动开关）。装配时 `list_enabled` 优先读 DB `input_schema`，解析失败回退 spec。

- 理由：DB 落库让前端一次查询即得 schema，也为将来动态/外部工具留出持久化位；spec 保证代码永远是最终权威与回退。
- `exec_kind` 进入 spec，删除 `native.rs::input_schema_for` 硬编码与 `mod.rs::NATIVE_TOOL_NAMES` 名单。

### 决策 3：ACP 清单动态化，与 HTTP 共用 `to_internal_tool_defs`

`ai_chat.rs` 的 ACP 分支先调用 `McpManager::to_internal_tool_defs`（已按 `internal_enabled` + 模块 open 过滤）取得工具集合，压成 compact（name + required/optional）传入改造后的 `build_client_tools_prompt`。删除 `AVAILABLE_FUNCTIONS_SECTION` 硬编码，顺带修掉重复的结尾指令拼接。

- 理由：一处过滤、一份 schema，彻底消除 ACP/HTTP 分叉。compact 格式沿用以最小化对 ACP agent 的行为冲击。

### 决策 4：OmniMCP 对外列表由 spec 派生 + 暴露开关落实

`builtin.rs::build_tools` 遍历 spec 中「可对外」的工具并按 `mcp_tool_is_exposed_available` 过滤。对暂不支持对外执行的工具，在设置页对 `external` 开关隐藏/置灰（前端对接时落实），后端 `mcp_tool_set_external_exposed` 增加模块 open 校验，避免 UI 承诺与实现不符。

### 决策 5：开关联动与遗留清理

- `app_module_set_status` 在 open 分支调用新方法恢复「被动禁用」工具。区分「被动禁用 vs 主动禁用」采用最简策略：模块重开即把该模块工具恢复默认开（记录在 tasks 中，如需精确区分可加辅助列，作为 Open Question）。
- `load_skill` 纳入 spec（归 `knowledge` 或新增 `system` 模块归属），走统一装配，不再无条件追加。
- 停止对 `enabled` 列的读依赖，仅以 `internal_enabled` 判定；列保留但标注废弃，避免破坏旧库。

### 前后端边界与 IPC

- 逻辑全部在 crate：`omnipanel-mcp`（spec/registry/manager/builtin）、`omnipanel-store`（表与开关）、`omnipanel-ai`（ACP prompt）。
- `src-tauri/src/commands/mcp_tool.rs` 与 `ai_chat.rs` 仅做薄桥接。
- IPC：`McpToolRecord` 增加 `input_schema` 字段（`#[derive(specta::Type)]`），`mcp_tool_set_external_exposed` 错误经 `OmniError`。`tauri-specta` 在构建时自动重生成 `frontend/src/ipc/bindings.ts`，前端禁止手写命令字符串。

### 数据流图

```
                    +---------------------------+
                    |  registry/spec.rs         |
                    |  builtin_tool_specs()     |  <== 单一真相源
                    +------------+--------------+
                                 | 种子/修复(以 spec 为准, 保留开关)
                                 v
                    +---------------------------+
                    |  mcp_tools 表 (omnipanel-store)
                    |  + input_schema 列        |
                    |  internal_enabled/exposed |
                    +------------+--------------+
                                 | list_enabled (按 internal_enabled + 模块 open 过滤; schema 读 DB, 回退 spec)
                                 v
                    +---------------------------+
                    |  ToolRegistry / McpManager |
                    |  to_internal_tool_defs()   |
                    +----+-----------+----------+-+
                         |           |          |
             HTTP DirectInject   ACP client   OmniMCP 对外
             (ai_chat.rs)        (client_tools 动态)  (builtin.rs, 按 exposed 过滤)
                         |           |          |
                         v           v          v
                    模型 tool_calls (统一工具名 + 同一 schema)
                         |
             ui-delegated 挂起 -> 前端 dispatch -> aiChatToolResult 回传
                         |
             native 后端直执 (knowledge/load_skill)
```

### 模块联动点

- terminal / database / knowledge 工具的可用性受各自模块 open 状态约束（与侧栏模块开关、`app_module` 联动）。
- 终端工具执行仍复用终端模块的危险命令确认与 `session_id` 定位（与 SSH→终端复用一致）。
- 数据库工具执行复用 DB 模块连接解析（`connection_name` → 连接），为后续 DB→AI NL2SQL 提供一致的工具契约。

## Risks / Trade-offs

- [DB 迁移覆盖用户手改描述] → schema/描述以代码为准是刻意设计；开关字段保留。迁移前于 tasks 中加校验测试。
- [ACP 由单工具变多工具，agent 可能不适应多工具 JSON] → 保留 compact 最小格式；分路径灰度：先终端，再逐步放开 database，必要时以配置限制 ACP 可注入模块。
- [模块重开恢复策略过粗（无法区分主动/被动禁用）] → 首版采用「重开即恢复默认开」；若用户反馈误恢复，再引入辅助列精确记录（Open Question）。
- [external 暴露收紧可能使既有对外调用失败] → 仅对「模块未 open」新增拦截，属修正不一致；变更在 CHANGELOG 标注。
- [specta 重生成导致 bindings diff] → 属预期，随 `McpToolRecord` 字段新增自动产生，前端消费为可选（当前假数据）。

## Migration Plan

1. 后端加 `spec.rs` 与 `input_schema` 列迁移（`ensure_mcp_tool_columns` 幂等），启动 `repair_mcp_tools` 回填。
2. registry / manager / builtin / ACP 依次切到 spec 源；保持工具名不变，确保回退可用。
3. 回滚策略：迁移仅新增列不删旧列；如需回滚代码，旧逻辑读 `internal_enabled` 仍有效，`input_schema` 列被忽略不影响旧版本运行。
4. 验证：`cargo test`（store 迁移/开关联动、mcp 装配、ai acp prompt）+ 手动 HTTP/ACP 双路径回归。

## Open Questions

- `load_skill` 归属：并入 `knowledge` 模块，还是新增 `system` 模块类别并在设置页只读展示？（默认并入 knowledge）
- 模块重开恢复是否需要精确区分「主动禁用」（是否加 `user_disabled` 辅助列）？（默认不加，先用粗策略）
- ACP 是否需要限制可注入的模块范围（例如默认只放行 terminal + database）以控风险？（默认全放行，按开关过滤）
