## ADDED Requirements

### Requirement: 命名会话的 attach-or-create

系统 SHALL 以工作区维度的确定性命名建立远程 tmux 会话，优先 attach 已存在的同名会话，不存在时才创建。

#### Scenario: 首次连接创建会话

- **GIVEN** 目标主机上不存在名为 `omnipanel-<workspace>` 的 tmux 会话
- **WHEN** 用户打开该主机的远程终端 Tab
- **THEN** 系统 SHALL 创建该命名会话并 attach

#### Scenario: 重连时复用既有会话

- **GIVEN** 目标主机上已存在名为 `omnipanel-<workspace>` 的 tmux 会话
- **WHEN** 用户再次打开该主机的远程终端 Tab
- **THEN** 系统 SHALL attach 到既有会话，MUST NOT 创建重复的同名会话

#### Scenario: 不同工作区互相隔离

- **WHEN** 用户在不同工作区中连接同一台主机
- **THEN** 系统 SHALL 使用各自工作区对应的会话名，两个工作区的远程会话 MUST 相互隔离

### Requirement: 会话跨进程生命周期存活

远程会话 SHALL 独立于应用进程存活。应用崩溃、正常退出、升级重启或网络中断后，pane 内进程 MUST 继续运行。

#### Scenario: 应用崩溃后任务续跑

- **GIVEN** 某远程终端 Tab 内正在运行长任务
- **WHEN** 应用进程被强制终止
- **THEN** 远端 tmux 会话 SHALL 继续存在，且 pane 内的长任务 MUST 继续运行

#### Scenario: 重启应用后恢复会话

- **GIVEN** 应用曾在某主机上创建过 tmux 会话且会话仍存活
- **WHEN** 用户重启应用并重新打开该远程终端 Tab
- **THEN** 系统 SHALL 重新 attach 到该会话
- **AND** 用户 SHALL 看到任务的持续输出，无需重新执行命令

#### Scenario: 网络中断后重连

- **WHEN** SSH 连接因网络中断而断开
- **THEN** 系统 SHALL 在重连后 attach 回原会话，pane 内进程状态 MUST 保持连续

### Requirement: 历史内容恢复

系统 SHALL 在 attach 远程会话时恢复 pane 的历史输出，使用户看到断开前的屏幕内容。

#### Scenario: attach 时拉取历史

- **WHEN** 系统 attach 到一个已存在的远程 tmux 会话
- **THEN** 系统 SHALL 通过 `capture-pane` 拉取该 pane 的历史内容（含转义序列）并注入前端终端
- **AND** 恢复的内容 SHALL 保留原有颜色与格式

#### Scenario: 历史容量受控

- **WHEN** 系统创建远程 tmux 会话
- **THEN** 系统 SHALL 设置有上限的 `history-limit`，避免远端内存无节制增长

#### Scenario: 本地快照机制保持不变

- **WHEN** 本地终端会话需要恢复屏幕内容
- **THEN** 系统 SHALL 继续使用既有的 `terminal_snapshot` 内存缓冲路径，MUST NOT 因本变更而改变本地行为

### Requirement: 远端会话可见与治理

系统 SHALL 让用户可以查看并管理本应用在远端主机上创建的 tmux 会话，避免僵尸会话累积。

#### Scenario: 列出远端会话

- **WHEN** 用户在 `/server` 模块查看某主机的会话管理入口
- **THEN** 系统 SHALL 列出该主机上匹配 `omnipanel-` 命名前缀的 tmux 会话，包含会话名、窗口数与创建时间

#### Scenario: 从列表 attach 会话

- **WHEN** 用户在会话列表中选择某个会话并触发 attach
- **THEN** 系统 SHALL 打开对应的远程终端 Tab 并 attach 到该会话

#### Scenario: 清理孤儿会话

- **WHEN** 用户在会话列表中对某个会话触发终止
- **THEN** 系统 SHALL 执行 `kill-session` 并从列表中移除该会话

#### Scenario: 生产环境主机的会话终止需二次确认

- **GIVEN** 目标主机带有 `prod` 环境标签
- **WHEN** 用户触发终止该主机上的 tmux 会话
- **THEN** 系统 MUST 弹出二次确认，明确提示该操作将终止远端正在运行的进程
- **AND** 该操作 MUST 写入审计日志

### Requirement: 敏感输入不因持久化而扩大暴露面

引入远端会话持久化 MUST NOT 削弱既有的凭据安全基线。

#### Scenario: 凭据不因 tmux 而落盘

- **WHEN** 系统建立远程 tmux 会话
- **THEN** SSH 凭据 SHALL 继续仅存于系统 keyring，MUST NOT 以任何形式出现在 tmux 命令行、会话名或远端可读文件中

#### Scenario: 敏感输入的留存风险提示

- **GIVEN** tmux 的 pane 历史会在远端主机内存中留存输入与输出内容
- **WHEN** 用户首次在某主机启用 tmux 持久化模式
- **THEN** 系统 SHALL 让该行为可被用户知晓（模式标识与设置项说明），使用户可对敏感场景选择直连模式

#### Scenario: 危险命令确认策略不变

- **WHEN** 用户在 tmux 模式的远程终端中输入危险命令
- **THEN** 既有的危险命令拦截与生产环境二次确认策略 SHALL 照常生效
