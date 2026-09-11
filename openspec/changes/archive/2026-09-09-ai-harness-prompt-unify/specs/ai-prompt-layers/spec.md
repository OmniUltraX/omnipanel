## ADDED Requirements

### Requirement: 用户消息不含强制 exec 后缀
系统 MUST NOT 把「必须调用 omni_terminal_exec / 不要凭记忆编造 / 不要传 resource_id」追加到终端自然语言的 user 正文。user 正文 MUST 仅为用户原话，可选附带 blockContext。

#### Scenario: 命令栏 NL 保持原话
- **GIVEN** 用户在命令栏或直通输入「当前的时间」
- **WHEN** 系统构造内联 AI user 消息
- **THEN** 消息不含「必须调用 omni_terminal_exec」

### Requirement: HTTP 与 ACP 共用路由片段
HTTP DirectInject 的工具路由短句与 ACP preamble 的路由政策 MUST 来自同一 `routing-policy.md`。系统 MUST NOT 再维护一份平行的 `TOOL_ROUTING_POLICY` 长字符串。

#### Scenario: 关键短语同源
- **GIVEN** 构建 HTTP system 或 ACP 首轮 prompt
- **WHEN** 注入路由政策
- **THEN** 两者都包含 `routing-policy.md` 中的当前 Tab exec / ssh exec / ask_user 要点

### Requirement: HTTP 不注入本机时钟冒充终端时间
当请求带有终端现场上下文时，HTTP system MUST NOT 注入网关本机 `Current local date-time`。若 `[Terminal Context]` 已含 Working directory，system MUST NOT 再追加一行 `Current working directory`。

#### Scenario: 远程 Tab 问时间
- **GIVEN** SSH 终端 Tab 绑定且已注入 Terminal Context
- **WHEN** HTTP 路径组装 system
- **THEN** 无 `Current local date-time` 行

### Requirement: ACP 切换 Agent 重注角色
同一 ACP conversation 的 `agent_id` 变化时，系统 MUST 重新注入 `[Agent]` 角色块，MUST NOT 继续使用上一 Agent 首轮锁定的角色提示词。

#### Scenario: Plan 切到 Run
- **GIVEN** 会话先以 plan 发出首轮
- **WHEN** 用户将同一会话切到 run 再提问
- **THEN** 新一轮包含 run 的 Agent 角色，且工具面为 master
