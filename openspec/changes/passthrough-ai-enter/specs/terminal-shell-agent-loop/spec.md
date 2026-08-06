## ADDED Requirements

### Requirement: 终端 Shell Agent 循环
系统 MUST 提供与终端 PTY 会话绑定的 Agent 循环：助手文本输出、shell 命令工具提案、用户审核、真实执行、将执行结果作为 observation 回灌，并在任务未结束时继续下一轮，直到停止条件满足。

#### Scenario: 多轮闭环（缺依赖后续装）
- **GIVEN** 用户已启动终端 Shell Agent 任务
- **WHEN** 某条已同意命令执行失败（例如 command not found）且自动续轮启用
- **THEN** 系统 MUST 将失败输出回灌给模型
- **AND** MUST 允许模型再次提出后续 shell 命令并展示新的审核卡
- **AND** MUST NOT 将单次文本回复视为循环结束（除非模型明确结束或达到停止条件）

#### Scenario: 命令在真实 PTY 执行
- **GIVEN** 用户对提案命令选择同意
- **WHEN** 执行开始
- **THEN** 命令 MUST 写入当前终端会话 PTY 并在该会话中产生真实输出

### Requirement: 命令级审核
每条 Agent 提出的 shell 命令在执行前 MUST 经过命令级审核 UI（同意/拒绝或等价交互），且 MUST 遵守 `terminalApprovalPolicy` 与环境标签；高风险与 prod MUST NOT 被静默跳过。

#### Scenario: 用户同意
- **WHEN** 用户同意某条提案命令
- **THEN** 系统 MUST 将该命令提交执行层写 PTY
- **AND** UI MUST 可感知已同意状态

#### Scenario: 用户拒绝
- **WHEN** 用户拒绝某条提案命令
- **THEN** 系统 MUST NOT 执行该命令
- **AND** MUST 将拒绝结果回灌模型以便调整或结束

#### Scenario: 生产环境高风险
- **GIVEN** 资源环境标签为 prod 且命令为高风险
- **WHEN** Agent 提案该命令
- **THEN** 系统 MUST 要求符合策略的确认且 MUST NOT 自动执行

### Requirement: 开启新会话
用户 MUST 能开启新的 Agent 会话以重置 Agent 对话上下文；此操作 MUST NOT 强制销毁底层 PTY（除非产品另有明确销毁入口）。

#### Scenario: 新会话
- **WHEN** 用户选择开启新会话
- **THEN** 后续 Agent 轮次 MUST NOT 默认携带上一 Agent 会话的历史工具与对话上下文
- **AND** 终端 PTY 会话 MUST 可继续使用

### Requirement: 停止与取消
系统 MUST 支持用户取消进行中的 Agent 环（例如取消生成或中断等待审核/执行）；取消后直通输入 MUST 恢复可用。

#### Scenario: 取消环
- **WHEN** 用户取消进行中的 Shell Agent
- **THEN** 系统 MUST 停止自动续轮
- **AND** 用户 MUST 能继续向 PTY 正常输入

### Requirement: 主工具为会话 shell
MVP 中 Agent 的主执行工具 MUST 是针对当前终端会话的 shell 执行；MUST NOT 以「仅展示命令让用户手工复制」作为唯一闭环手段。

#### Scenario: 工具形态
- **WHEN** Agent 需要在机器上执行操作
- **THEN** 系统 MUST 通过可审核的 shell 工具提案推进，而非仅输出不可执行的纯文本命令列表作为唯一路径
