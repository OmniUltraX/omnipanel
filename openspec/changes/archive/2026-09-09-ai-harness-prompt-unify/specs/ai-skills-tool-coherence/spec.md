## ADDED Requirements

### Requirement: load_skill 对模块 Agent 可用
系统 MUST 将 `load_skill` 视为跨模块工具，与 `omni_ask_user` 等一并注入模块 Agent（含 terminal）。`omni_skill_recall` MUST 同样跨模块（若该工具启用）。

#### Scenario: 终端 Agent 可 load_skill
- **GIVEN** 用户在终端内联使用 terminal Agent
- **WHEN** 本轮注入工具列表
- **THEN** 列表包含 `load_skill`

### Requirement: Skills 摘要与工具面一致
系统 MUST 仅在本轮工具列表包含 `load_skill` 时，在 Skills 摘要中承诺「通过 load_skill 加载」。已出现在 Composer `skill_ids` 中的 Skill MUST NOT 再出现在摘要目录，只保留 Active Skills 全文。

#### Scenario: 勾选后不重复目录
- **GIVEN** 用户勾选了 skill `ops-ssh-patrol`
- **WHEN** 组装 system_append
- **THEN** `## Skills` 目录不含该 id，`## Active Skills` 含其正文

### Requirement: 模块 Agent 不暗示未注入的外部 MCP
当本轮 `module_filter` 不是 master 时，系统 MUST NOT 在提示词中声称外部 MCP 工具可用。外部 MCP 仍仅在 Run/master 注入。

#### Scenario: 终端 Agent 不见 extmcp
- **GIVEN** moduleFilter=terminal
- **WHEN** 注入工具与提示词
- **THEN** 无 `extmcp::` 工具，提示词不写「可使用已启用的外部 MCP」
