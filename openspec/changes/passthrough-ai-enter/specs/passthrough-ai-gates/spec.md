## ADDED Requirements

### Requirement: alt-screen 期间禁用 Enter 入环
当终端处于交替屏（如 vim、less、top 等）时，系统 MUST 禁用自然语言 Enter 入环，所有按键（含 Enter）MUST 直通 PTY。

#### Scenario: vim 内回车
- **GIVEN** 直通会话中 alt-screen 激活
- **WHEN** 用户按下 Enter
- **THEN** 系统 MUST NOT 将输入送入 Shell Agent
- **AND** Enter MUST 送达 PTY

#### Scenario: 退出 alt-screen 后恢复
- **GIVEN** 用户退出 vim 回到主屏且入口启用
- **WHEN** 于主 prompt 输入自然语言并 Enter
- **THEN** 系统 MUST 允许再次入环

### Requirement: reverse-i-search 期间禁用入环
当会话处于反向搜索（如 Ctrl+R）时，系统 MUST 禁用自然语言 Enter 入环。

#### Scenario: Ctrl+R 接受命中
- **GIVEN** 用户处于 `(reverse-i-search)`
- **WHEN** 按下 Enter 接受命中
- **THEN** Enter MUST 交给 PTY
- **AND** 系统 MUST NOT 入环

### Requirement: 命令运行中禁用 NL 入环
在已检测到前台命令运行中时，系统 MUST 将 Enter 视为 PTY 输入，MUST NOT 用该 Enter 启动新的自然语言入环。

#### Scenario: 前台等待输入
- **GIVEN** 前台进程运行中
- **WHEN** 用户按下 Enter
- **THEN** Enter MUST 直通 PTY

### Requirement: Agent 执行写 PTY 期间的输入策略
当 Shell Agent 正在将已同意命令写入 PTY 或正在采集该命令输出时，系统 MUST 避免用户自然语言 Enter 再开并行环；用户中断（如 Ctrl+C）MUST 仍能送达 PTY。

#### Scenario: Agent 执行中
- **GIVEN** Agent 已同意命令正在执行/采集
- **WHEN** 用户尝试再次以自然语言 Enter 入环
- **THEN** 系统 MUST NOT 并行启动第二个 Shell Agent 环
- **AND** Ctrl+C MUST 可送达 PTY

### Requirement: 不确定时放行
当门闩或行缓冲无法可靠判断时，系统 MUST 将 Enter 交给 PTY（fail-open）。

#### Scenario: 行缓冲不可信
- **GIVEN** 当前行无法可靠重建
- **WHEN** 用户按下 Enter
- **THEN** 系统 MUST 放行 Enter 至 PTY
