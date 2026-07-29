## ADDED Requirements

### Requirement: Feedback uses whole orchestration unit

Skill 提取/outcome 引导 MUST 优先基于整次编排（父会话 + plan 终态 + cluster 摘要），避免仅使用单条子会话碎片作为默认输入。

#### Scenario: Extract prompt includes digest

- **WHEN** 用户从 Trace/Harness 反馈入口触发「提取 Skill」且存在 digest
- **THEN** 提交给 AI 的提取上下文 MUST 包含 digest 文本（或等价结构化摘要）

### Requirement: Human-gated harness edits

对 prompt/agent 等 harness 静态组件的变更 MUST 经用户确认或既有设置页保存流程；本阶段 MUST NOT 自动覆写用户自定义 prompt。

#### Scenario: Default prompt seed does not clobber

- **WHEN** 用户目录已存在自定义 `agents/{id}.md`
- **THEN** 种子逻辑 MUST NOT 覆盖该文件（除非命中明确的 legacy 升级启发式）
