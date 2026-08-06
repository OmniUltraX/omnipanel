## ADDED Requirements

### Requirement: 直通自然语言 Enter 作为入环入口
在输入模式为直通（`interactive`）且入口开关启用时，系统 MUST 在主 prompt 下对 Enter 评估当前行；若判定为自然语言，MUST NOT 将该 Enter 交给 PTY 执行该自然语言行，MUST 清除远端当前输入行，并 MUST 将文本送入终端 Shell Agent 循环（启动或继续）。

#### Scenario: 中文自然语言入环
- **GIVEN** 直通模式、主 prompt、入口启用
- **WHEN** 用户输入「当前的时间」并 Enter
- **THEN** 远端 MUST NOT 因该行出现 command not found
- **AND** 系统 MUST 启动或继续 Shell Agent 循环

#### Scenario: 普通命令不入环
- **GIVEN** 直通模式主 prompt
- **WHEN** 用户输入 `ls -la` 并 Enter
- **THEN** 系统 MUST 将提交交给 PTY，不启动 Agent 环

#### Scenario: 关闭入口
- **GIVEN** 直通智能 Enter / Agent 入口关闭
- **WHEN** 用户输入自然语言并 Enter
- **THEN** 系统 MUST 将整行交给 PTY（纯直通）

### Requirement: 自然语言判定
系统 MUST 使用与命令栏共享的 `shouldRouteInputToAi`（或等价共享函数）判定是否入环。

#### Scenario: 英文问句
- **WHEN** 用户输入 `how do I list open ports` 并 Enter
- **THEN** 系统 MUST 入环而非 PTY 执行该行

### Requirement: 清行后再入环
自然语言入环前，系统 MUST 向 PTY 发送清行序列（优先 Ctrl+U 或当前 shell 等价序列）。

#### Scenario: 清行
- **WHEN** 自然语言 Enter 触发入环
- **THEN** 系统 MUST 先尝试清除远端当前输入行
- **AND** 再将文本交给 Shell Agent

### Requirement: 入口不是单次聊天结束
通过 Enter 入环后，系统 MUST 按 `terminal-shell-agent-loop` 推进多轮工具循环，MUST NOT 将一次助手文本回复视为唯一交付物。

#### Scenario: 入环后可续轮
- **GIVEN** 用户已通过自然语言入环
- **WHEN** Agent 执行某命令后仍需后续步骤且自动续轮启用
- **THEN** 系统 MUST 继续环内下一轮，而非仅停留在首轮文本

### Requirement: 命令栏行为不变
本能力 MUST NOT 改变命令栏（`external`）既有输入与 Block 行为。

#### Scenario: 命令栏回归
- **GIVEN** 输入模式为命令栏
- **WHEN** 用户使用自然语言或 `#` 提问
- **THEN** 行为 MUST 与本变更前一致
