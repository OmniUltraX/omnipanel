## ADDED Requirements

### Requirement: 远端 tmux 能力探测

系统 SHALL 在建立远程终端会话前探测目标主机的 tmux 可用性与版本，并据此选择 control mode 路径或直连 shell 路径。探测结果 MUST 记录在会话元信息中，供前端展示当前模式。

#### Scenario: 远端具备受支持的 tmux 版本

- **WHEN** 目标主机 `tmux -V` 返回版本不低于受支持下限
- **THEN** 系统 SHALL 以 control mode 建立会话，且会话元信息标记 `mode = "tmux"` 与实际版本号

#### Scenario: 远端未安装 tmux

- **WHEN** 目标主机 `tmux -V` 返回非零退出码或 command not found
- **THEN** 系统 SHALL 静默降级为直连 `request_shell` 路径，会话元信息标记 `mode = "direct"`
- **AND** 系统 MUST NOT 向用户抛出错误弹窗或使连接失败

#### Scenario: 远端 tmux 版本过低

- **WHEN** 探测到的 tmux 版本低于受支持下限（control mode 行协议不兼容）
- **THEN** 系统 SHALL 降级为直连路径，并在会话元信息中记录降级原因

#### Scenario: 探测结果按主机缓存

- **WHEN** 同一主机在同一应用生命周期内再次建立远程终端会话
- **THEN** 系统 SHALL 复用已缓存的探测结果，MUST NOT 重复执行探测命令

### Requirement: control mode 行协议解析

系统 SHALL 实现 tmux control mode 的行协议解析器，正确处理 `%output`、`%begin`/`%end`/`%error` 响应块与会话生命周期通知。

#### Scenario: 解析 %output 并反转义

- **WHEN** 收到形如 `%output %0 <data>` 的行
- **THEN** 解析器 SHALL 提取 pane 标识 `%0` 与数据段，并将八进制字面量（如 `\033`、`\007`、`\015`、`\012`）反转义为对应字节
- **AND** 反转义后的字节流 MUST 与 pane 内进程写出的原始字节逐字节一致

#### Scenario: OSC 序列完整保留

- **WHEN** pane 内进程输出 OSC 133（A/B/C/D）、OSC 7、OSC 0、OSC 1337 或 OSC 633 序列，无论以 BEL 还是 ST 结尾
- **THEN** 反转义后的字节流 SHALL 完整保留这些序列
- **AND** 前端 Blocks 的命令边界识别、退出码提取、cwd 追踪与 shell history 同步 MUST 与直连模式行为一致

#### Scenario: 命令响应块配对

- **WHEN** 系统向 control channel 发送 tmux 命令后收到 `%begin <ts> <num> <flags>` 至 `%end <ts> <num> <flags>` 之间的内容
- **THEN** 解析器 SHALL 将该内容作为对应命令的响应返回给发起方

#### Scenario: 命令执行失败

- **WHEN** 响应块以 `%error <ts> <num> <flags>` 结束
- **THEN** 解析器 SHALL 将其作为错误结果返回，并携带 tmux 给出的错误文本封装为 `OmniError`

#### Scenario: 收到未知通知行

- **WHEN** 收到解析器未识别的 `%<name>` 通知行
- **THEN** 解析器 SHALL 忽略该行并继续处理后续输入，MUST NOT 中断会话或丢弃后续 `%output`

### Requirement: 单连接多 pane 路由

系统 SHALL 在单条 SSH 连接的单个 control channel 上承载多个远程终端会话，并将每个 pane 的输出准确路由到对应的前端会话。

#### Scenario: 多个远程 Tab 复用同一连接

- **WHEN** 用户对同一主机打开第二个及后续远程终端 Tab
- **THEN** 系统 SHALL 在已有 control channel 上新建 pane，MUST NOT 建立新的 TCP 连接或重复执行 SSH 认证

#### Scenario: pane 输出路由到对应会话

- **GIVEN** 单个 control channel 上存在多个 pane，且各自映射到不同的前端 `session_id`
- **WHEN** 某个 pane 产生输出
- **THEN** 系统 SHALL 依据 `%output` 携带的 pane 标识查出对应 `session_id`，并仅向该会话发送 `terminal-output` 事件

#### Scenario: 事件契约保持不变

- **WHEN** 远程会话经 tmux 路径产生输出
- **THEN** 系统 SHALL 沿用既有 `terminal-output` 事件与 `{ session_id, data: base64 }` 载荷格式
- **AND** 前端 xterm.js 渲染路径 MUST NOT 需要任何改动即可正确显示

#### Scenario: 首个 Tab 承担建连成本

- **WHEN** 用户打开某主机的首个远程终端 Tab
- **THEN** 系统 SHALL 完成 TCP 握手、SSH 认证与 control mode 启动
- **AND** 后续 Tab 的开启延迟 SHALL 显著低于首个 Tab

### Requirement: 输入与尺寸变更转译

系统 SHALL 将前端的写入与 resize 请求转译为对应 pane 的 tmux 命令，且保持既有 Tauri 命令签名不变。

#### Scenario: 键盘输入写入指定 pane

- **WHEN** 前端对某远程会话调用 `ssh_write` 提交字节
- **THEN** 系统 SHALL 将字节以十六进制安全编码形式（`send-keys -H`）投递到该会话对应的 pane
- **AND** 二进制安全性 MUST 得到保证：任意字节序列（含控制字符与非 UTF-8 字节）均能原样送达

#### Scenario: 终端尺寸变更

- **WHEN** 前端对某远程会话调用 `ssh_resize` 提交新的 cols/rows
- **THEN** 系统 SHALL 对该会话对应的 pane 执行尺寸调整，使 pane 内进程收到正确的窗口尺寸

#### Scenario: 命令签名向后兼容

- **WHEN** 前端调用 `ssh_connect`、`ssh_connect_connection`、`ssh_connect_config_host`、`ssh_write`、`ssh_resize` 或 `ssh_disconnect`
- **THEN** 这些命令的参数与返回类型 SHALL 与本变更前保持一致

### Requirement: 单会话逃生阀

系统 SHALL 允许用户将单个远程终端会话切换为直连 shell 模式，以规避 tmux 路径的吞吐损耗。

#### Scenario: 切换到直连模式

- **GIVEN** 某远程终端 Tab 当前运行在 tmux 模式
- **WHEN** 用户对该 Tab 触发「直连模式」开关
- **THEN** 系统 SHALL 为该 Tab 建立直连 shell 会话并更新其模式标识
- **AND** 同主机其余 Tab 的 tmux 会话 MUST NOT 受影响

#### Scenario: 模式对用户可见

- **WHEN** 远程终端 Tab 处于 tmux 模式或直连模式
- **THEN** 界面 SHALL 以可辨识的方式展示当前模式，用户可据此理解性能与持久化特性差异

### Requirement: 本地终端路径不受影响

本变更 MUST NOT 改变本地终端、Docker exec 终端与数据库 CLI 终端的既有行为与性能特征。

#### Scenario: 本地终端保持直连 PTY

- **WHEN** 用户打开本地终端 Tab
- **THEN** 系统 SHALL 继续使用 portable-pty 直连路径，MUST NOT 引入 tmux
- **AND** 本地终端吞吐与输入延迟 SHALL 不因本变更而退化

#### Scenario: 其他终端类型不受影响

- **WHEN** 用户使用 Docker 容器 exec 终端、Docker 宿主机 shell 或数据库 CLI 终端
- **THEN** 这些会话的建立与 I/O 路径 SHALL 与本变更前一致
