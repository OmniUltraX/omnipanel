## ADDED Requirements

### Requirement: OSC 133;D 必须如实反映命令退出码

shell 集成脚本发射的 `OSC 133;D;<code>` 中的 `<code>` MUST 等于用户命令的真实退出码。脚本内部的赋值、条件判断与函数调用 MUST NOT 污染待上报的 `$?`。

#### Scenario: 成功命令上报 0

- **WHEN** 用户在集成了 shell 脚本的终端中执行返回 0 的命令（如 `true`）
- **THEN** 脚本 SHALL 发射 `OSC 133;D;0`

#### Scenario: 失败命令上报真实非零码

- **WHEN** 用户执行返回特定非零退出码的命令（如 `(exit 7)`、`(exit 42)`、`false`）
- **THEN** 脚本 SHALL 分别发射 `OSC 133;D;7`、`OSC 133;D;42`、`OSC 133;D;1`
- **AND** 上报值 MUST NOT 是与实际结果无关的固定常量

#### Scenario: 本地与远程两条注入路径行为一致

- **GIVEN** 本地终端使用 `crates/omnipanel-core/resources/shell-integration/bash.sh`，远程会话使用 `frontend/src/hooks/useTerminal.ts` 的 `injectRemoteShellIntegration`
- **WHEN** 在两条路径下执行同一组命令
- **THEN** 两者上报的退出码 SHALL 一致且均等于真实退出码

#### Scenario: 历史同步命令不产生伪块

- **WHEN** 脚本内部的历史同步命令（`__omnipanel_history_sync__` / `__omnipanel_emit_history`）被执行
- **THEN** 脚本 SHALL 跳过 `OSC 133;C` 与 `OSC 133;D` 的发射
- **AND** 该跳过逻辑 MUST NOT 影响后续真实命令的退出码上报

#### Scenario: tmux 传输路径不改变退出码语义

- **WHEN** 远程会话经由 tmux control mode 传输
- **THEN** 前端收到的 `OSC 133;D` 退出码 SHALL 与直连模式一致

### Requirement: shell 集成脚本必须以 LF 换行

随二进制嵌入的 shell 集成脚本 MUST 使用 LF 换行，确保在任意构建平台产出的二进制均可被目标 shell 正确加载。

#### Scenario: 脚本换行符与仓库属性一致

- **WHEN** 检查 `crates/omnipanel-core/resources/shell-integration/` 下的脚本
- **THEN** 工作区文件的换行符 SHALL 为 LF，与 `.gitattributes` 声明的 `eol=lf` 一致

#### Scenario: Windows 构建产物在 POSIX shell 中可加载

- **GIVEN** 二进制在 Windows 平台构建，集成脚本经 `include_str!` 嵌入
- **WHEN** 该产物在 bash / zsh / fish 中注入集成脚本
- **THEN** 脚本 SHALL 正常加载，MUST NOT 因 CR 字符产生语法错误
- **AND** OSC 133 序列 SHALL 正常发射
