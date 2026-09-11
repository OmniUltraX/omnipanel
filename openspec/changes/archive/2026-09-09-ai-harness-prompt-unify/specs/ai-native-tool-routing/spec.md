## ADDED Requirements

### Requirement: ACP 原生文件工具优先 omni_files
当本轮工具列表包含 `omni_files_*` 时，系统 MUST 将 ACP 原生 Read/Write/Edit 映射为对应 files 工具，而不是默认 `cat`/`echo` 进 `omni_terminal_exec`。当本轮没有 files 工具时，MUST fallback 到当前 Tab 执行，且命令语法 MUST 匹配会话 shell（PowerShell 用 `Get-Content` 等，而非盲目 `cat`）。

#### Scenario: Run 模式 Read 走 files
- **GIVEN** 本轮工具含 `omni_files_read` 或等价 files 读工具
- **WHEN** ACP 发出原生 Read
- **THEN** 客户端工具名为 files 工具而非 `omni_terminal_exec`

#### Scenario: 终端-only PowerShell 用 Get-Content
- **GIVEN** 本轮无 files 工具且会话 shell 为 PowerShell
- **WHEN** ACP 原生 Read 一个路径
- **THEN** 映射为 `omni_terminal_exec`，command 使用 PowerShell 读文件语法

### Requirement: 缺 resource_id 的 ssh exec 不鼓励走 PTY
系统 MUST NOT 在提示词或工具描述中鼓励「无 resource_id 的 omni_ssh_exec 等于当前 Tab」。内联兼容若仍把无 id 的 ssh exec 打进 PTY，MUST 可观测（日志），文案 MUST 引导使用 `omni_terminal_exec`。

#### Scenario: 文案不再写兼容路由
- **GIVEN** 模型阅读 omni_ssh_exec 描述
- **WHEN** 查看 compact/full description
- **THEN** 要求必须提供 resource_id，不写「可省略并走当前 Tab」
