## 1. 去重复注入

- [x] 1.1 删除 `buildNaturalLanguagePrompt` 强制 exec 后缀；L2 已有 cwd 时不写「当前目录」
- [x] 1.2 HTTP `build_system_message`：去本机时间、去重复 cwd、Resource id 标明仅供 ssh
- [x] 1.3 Composer 与活动会话 Terminal Context 去重
- [x] 1.4 收短 `TERMINAL_CONTEXT_IMPORTANT_LINE`

## 2. 路由与角色

- [x] 2.1 新增 `routing-policy.md`；HTTP `tool_routing_policy` include 之
- [x] 2.2 瘦身 `system-prompt.md` 与 agents/terminal.md、run.md；官方文件可迁移
- [x] 2.3 补齐 server/knowledge/protocol/workflow/tasks 的 agents md
- [x] 2.4 停传 registry 长 systemRole；ACP `agent_id` 变化重注角色

## 3. 工具 / Skills / MCP

- [x] 3.1 spec 描述 MUST 靠前；前端 handler 描述改短
- [x] 3.2 `load_skill` / `omni_skill_recall` 进 cross-module（Rust + 前端 Set）
- [x] 3.3 Skills 摘要按是否有 load_skill 裁剪；勾选 id 移出目录；Web ai.rs 补勾选全文
- [x] 3.4 模块 Agent 不提未注入 MCP；Harness inventory 显示工具族

## 4. Native / Bridge

- [x] 4.1 native_tools：有 files 则映射 files，否则按 shell 选 cat/Get-Content
- [x] 4.2 无 resource_id 的 ssh exec：文案引导 terminal_exec；兼容路径打日志

## 5. 校验

- [x] 5.1 rust/vitest 覆盖 routing 同源、NL 无军令、skills 不重复
- [x] 5.2 `cd frontend && npx tsc -b`
