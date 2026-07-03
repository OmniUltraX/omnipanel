## 1. 后端：工具定义单一真相源

> 落地调整：因 `omnipanel-mcp` 依赖 `omnipanel-store`（若把 spec 放 mcp 会导致 store 种子反向依赖，形成环依赖），单一真相源改放在 **omnipanel-store** 的 `mcp_tool_spec.rs`（`BUILTIN_TOOL_SPECS` + `ToolExecKind`），mcp 侧复用之。

- [x] 1.1 新增 `crates/omnipanel-store/src/mcp_tool_spec.rs`：定义 `BuiltinToolSpec { tool_name, module_key, description, input_schema, exec_kind }` 与 `BUILTIN_TOOL_SPECS`，集中定义 terminal(1)+database(4)+knowledge(3)+load_skill；终端 schema 含 `command`(必填)+`session_id`(可选)
- [x] 1.2 `registry/mod.rs` 删除硬编码 `NATIVE_TOOL_NAMES`，`is_native_tool` 改读 `omnipanel_store::builtin_tool_is_native`
- [x] 1.3 `registry/native.rs`：`input_schema_for` 改为查 `builtin_tool_spec()`，移除逐工具硬编码 match
- [x] 1.4 `cargo test`：spec 单测校验 schema 非空 / object、terminal 含 `command` required、exec_kind 正确

## 2. 后端：schema 落库与开关存储（omnipanel-store）

- [x] 2.1 `ensure_mcp_tool_columns` 增加 `input_schema TEXT` 列迁移（幂等）；`McpToolRecord` 增加 `input_schema` 字段并在 `mcp_tool_list`/`mcp_tool_get` 带出
- [x] 2.2 `repair_mcp_tools` 遍历 `BUILTIN_TOOL_SPECS`：`INSERT ... ON CONFLICT DO UPDATE description/module_key/input_schema`，保留开关
- [x] 2.3 删除 `DEFAULT_MCP_TOOLS` 三元组，统一以 spec 为来源；`load_skill` 纳入种子
- [x] 2.4 `enabled` 仅作兼容保留，`is_enabled`/`is_available` 以 `internal_enabled` 为准
- [x] 2.5 `mcp_tool_set_external_exposed` 增加模块 open 校验 + 仅 Native 可暴露校验，否则 `OmniError::InvalidInput`
- [x] 2.6 新增 `mcp_tool_restore_for_module(module_key)`：模块重开时恢复该模块工具 `internal_enabled=true`
- [x] 2.7 `cargo test -p omnipanel-store`：覆盖列带出、catalog 不覆盖 spec 描述、external 校验、模块关闭禁用 + 重开恢复

## 3. 后端：registry 装配读 DB schema（omnipanel-mcp）

- [x] 3.1 `registry/mod.rs::list_enabled`：`input_schema` 改为读 `record.input_schema`，解析失败回退 spec；保持 `internal_enabled + mcp_tool_is_available` 过滤
- [x] 3.2 `manager.rs::to_internal_tool_defs`：移除 `load_skill` 无条件追加，改由 registry 统一产出
- [x] 3.3 `cargo test -p omnipanel-mcp`：装配单测——禁用工具不出现、模块关闭不出现、schema 带 required、load_skill 出现

## 4. 后端：OmniMCP 对外暴露一致性（omnipanel-mcp）

> 落地调整：OmniMCP 只能后端直执工具，终端 / 数据库无法对外提供。故不在 builtin.rs 遍历 spec 暴露不可执行工具，而是在 store 侧 `mcp_tool_set_external_exposed` 加「仅 Native 可暴露」guard，使可暴露集合与 OmniMCP 实际可服务集合一致。

- [x] 4.1 OmniMCP 列表 / 调用继续按 `mcp_tool_is_exposed_available` 过滤（knowledge native 工具）；非 Native 工具由 store guard 阻止开启 external
- [x] 4.2 `cargo test`：`external_exposed_rejects_ui_delegated` 覆盖——终端被拒、知识库可暴露

## 5. 后端：ACP 路径动态化与共用（omnipanel-ai + commands）

- [x] 5.1 `client_tools.rs`：`build_client_tools_prompt` 增参 `tools: &[ToolDef]`，新增 `build_available_functions_section` 动态生成 `Callable names` + `Compact schemas`，删除 `AVAILABLE_FUNCTIONS_SECTION` 硬编码
- [x] 5.2（作废）经核实 `client_tools.rs` 无重复 `Respond now:` 片段，原报告系读取渲染故障
- [x] 5.3 `ai_chat.rs` ACP 分支：经 `McpManager::to_internal_tool_defs` 取过滤后工具（仅内置 UiDelegated），传入 prompt；执行门由 `==终端` 放宽为 registry 已知 UiDelegated 工具，PendingTool 携带真实工具名
- [x] 5.4 `cargo test -p omnipanel-ai`：compact 生成含多工具与 optional 字段、终端必填 `command`、空清单产出空段

## 6. Tauri 命令桥接与 IPC 契约（src-tauri）

- [x] 6.1 `mcp_tool_list` 返回带 `input_schema`（随 `McpToolRecord` 字段）；`mcp_tool_set_external_exposed` 透传 store 校验错误（命令层仅桥接）
- [x] 6.2 `McpToolRecord` 已 `#[derive(specta::Type)]`，新增字段随构建触发 `tauri-specta` 重生成 `bindings.ts`
- [x] 6.3 `app_module_set_status` open 转换调用 `mcp_tool_restore_for_module`，close 维持批量禁用

## 7. 全量验证与回归

- [x] 7.1 `cargo check`（workspace）+ `cargo test -p omnipanel-mcp -p omnipanel-store -p omnipanel-ai` 全绿
- [ ] 7.2 手动：HTTP 直连（DeepSeek）「现在的时间」验证终端工具带 `{"command":"date"}`，不再空 `{}`
- [ ] 7.3 手动：ACP（Cursor/composer）同题验证工具清单动态、终端工具可执行
- [ ] 7.4 手动：数据库工具带全参（connection_name/database_name/sql）注入正确
- [ ] 7.5 手动：关闭再打开某模块，验证其工具被禁用后恢复；对未 open 模块 / UiDelegated 工具开启 external 被拒
- [x] 7.6 更新 `CHANGELOG.md`（中文、约定式提交口径）记录 external 暴露收紧等行为变化

## 8. 前端对接契约占位（非本次实现，仅登记）

- [ ] 8.1 记录前端后续对接点：`mcpToolStore` 消费 `mcp_tool_list.input_schema`、设置页对不可对外工具隐藏/置灰 external 开关、移除前端本地 schema 硬编码（前端当前为假数据，真实对接单独立项）
