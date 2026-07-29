## ADDED Requirements

### Requirement: 模块工具栏「问 AI」

系统 MUST 在 database、docker、files、server 模块左侧栏顶栏提供「问 AI」入口。点击后 MUST 打开 AI Dock，并将会话 Agent 设为该模块对应 Agent（`agentIdForModule`）。

#### Scenario: 在 Docker 页问 AI

- **WHEN** 用户位于 `/docker` 且 ContextBridge 已挂载，点击「问 AI」
- **THEN** 打开 Dock，会话 `agentId` 为 `docker`，并提交或预填模块引导提示

#### Scenario: 在 Database 页问 AI

- **WHEN** 用户位于 `/database`，点击「问 AI」
- **THEN** 会话 `agentId` 为 `database`，且后续请求可携带模块上下文（有 provider 时 `moduleContextAppend` 非空）

### Requirement: 不新增旁路聊天

模块「问 AI」MUST NOT 直接 `invoke` 聊天 API；MUST 复用 `askAiFromSurface` → `sendToAiDock` / `submitAiPrompt`。

#### Scenario: 统一入口

- **WHEN** 任意首批模块触发「问 AI」
- **THEN** 调用链经过共享 surfaces API，不出现第二套会话写入路径

### Requirement: 安全与确认不变

「问 AI」仅发起建议对话；高风险与 prod 操作 MUST 仍经既有 ToolGate / 环境标签确认，表面层 MUST NOT 自动批准 Draft。

#### Scenario: 不自动批准

- **WHEN** AI 提出需确认的写操作
- **THEN** 仍进入既有审批/Draft 流程，不因来自模块按钮而跳过
