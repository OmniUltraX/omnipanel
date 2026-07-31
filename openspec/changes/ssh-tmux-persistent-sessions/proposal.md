## Why

远程终端目前每开一个 Tab 就新建一条完整 SSH 连接（TCP + 握手 + 认证），且会话完全绑定应用进程生命周期：网络抖动、笔记本合盖、应用崩溃或升级重启，正在跑的编译、数据库迁移、长任务全部丢失，`output_buffers` 的 256KB 内存快照也一并归零。对一个定位「工程工作站」的产品，这是可用性上的硬伤。tmux control mode（`tmux -CC`）能同时解决连接复用与会话持久化两件事，代价是远程侧吞吐下降——本提案主张接受这个取舍。

## 背景与动机

- **Phase**：Phase 1（终端 + SSH 基座）深化，同时为 Phase 3（服务器管理）与 Phase 4（Blocks 后端化）铺路。影响路由 `/terminal` 的远程 Tab 与 `/server` 的 SSH 终端工作区。
- **现状能力**：`ssh_connect` → `SshSession::connect`（russh `request_pty` + `request_shell`）→ `SshSink` 回调 → `terminal-output` 事件（base64）→ 前端 xterm.js。前端用 `detachedRuntime`（30 分钟 TTL、上限 12 个）在应用层模拟 detach，`terminal_snapshot` 从 256KB 内存缓冲重建屏幕。
- **结构缝隙**：
  - 每个远程 Tab 一个独立 `SshSession`，N 个 Tab = N 条 SSH 连接，握手/认证/心跳成本线性增长，弱网下建连延迟感知明显，也逼近服务端 `MaxStartups`。
  - `omnipanel-ssh` 中 `exec_gate: Semaphore(1)` 因 russh Handle 不支持并发 `channel_open_session` 而串行化同连接上的 exec/SFTP。
  - 所有会话状态纯内存，进程退出即全灭；`detachedRuntime` 活不过重启。
- **已验证的关键假设**（tmux 3.6 实测，spike 已完成）：
  - **OSC 序列在 control mode 下 100% 原样透传**。`%output` 转发的是 pane 原始字节，仅将控制字符转为八进制字面量（ESC→`\033`、BEL→`\007`、CR/LF→`\015\012`）。OSC 133 的 A/B/C/D 四阶段、BEL 与 ST 两种结尾、OSC 7/0/1337/633、SGR 全部完好，`allow-passthrough` 开关无影响（它管的是 DCS，不需要）。**Blocks、shell history 同步、cwd 追踪可原封不动继续工作。**
  - **单连接多 pane 路由可行**。三个 pane（含跨 window）分别打上 `%0`/`%1`/`%2`，`list-panes -a` 回报 `%0 @0`、`%1 @0`、`%2 @1`，分流干净。
  - **detach 存活性成立**。强杀 control client 后 session 仍在，pane 内进程继续运行，`capture-pane -p -S -N` 完整取回历史。
  - **吞吐代价已量化**：同一读取路径下，8.5MB 纯文本直连 PTY 传输 0.17s、tmux -CC 1.09s；4.7MB 富 ANSI 为 0.08s 对 0.66s，即 **吞吐降至 12%–15%（慢约 6.5–8 倍）**。线路膨胀率仅 1.09x/1.26x，说明瓶颈是 tmux server 的 VT 解析与 grid 维护（CPU），而非八进制转义带来的带宽。
  - **`TERM` 风险已排除**：tmux 下 `TERM` 由 `xterm-256color` 变为 `tmux-256color`，但集成脚本的 OSC 为无条件 `printf`、不走 `TERM` 分支。以项目真实注入方式（`bash --init-file`）实测，tmux 与直连两条路径的 OSC 命中数逐项一致（133;A 各 2 次、133;C 各 3 次、1337;CurrentDir 各 2 次），无需改脚本或设 `default-terminal`。
  - **版本兼容矩阵已实测**（3.0a / 3.2a / 3.4 / 3.6，详见 `tmux-compat-matrix.md`）：行协议与八进制转义四版本完全一致；**支持下限由 3.0 上调至 3.2**（3.0a 的 `resize-window` 只改元数据、pane 内实际尺寸不变）；并发现一条硬约束——`set-option -g window-size manual` 生效期间执行 `new-window` 会**崩溃 tmux 3.4/3.6 服务端并丢失全部会话**，必须改用 window 级 `set-option -w -t @N`。
- **前置验证中发现的既有缺陷**（与 tmux 无关，但直接影响本变更的 Blocks 验收）：
  - **OSC 133;D 退出码失真**：实测 `true` / `(exit 7)` / `false` / `(exit 42)` 四组命令，本地 `bash.sh` 恒发 `D;1`（所有命令显示为失败），前端远程注入版恒发 `D;0`（所有命令显示为成功）。根因是 `$?` 在传递前被覆盖——回调中 `__omnipanel_in_prompt=1` 赋值即冲掉真实退出码，本地版另叠加 `__omnipanel_is_history_sync && return` 短路后的返回值污染。
  - **集成脚本换行符不一致**：`git ls-files --eol` 显示 `bash.sh` / `fish.fish` / `powershell.ps1` 均为 `i/lf w/crlf`，而 `.gitattributes` 声明 `eol=lf`（工作区 checkout 早于该属性生效，git 不会自动重规范化）。CRLF 版经 `include_str!` 嵌入后，bash 加载即报 `syntax error near unexpected token $'{\r'`，集成整体失效；PowerShell 容忍 CRLF 不受影响。
  - **OSC 133;B 经核实不属于缺陷**：前端全代码库不解析 B，三份脚本亦均不发射，属一致的设计取舍，本变更不做改动。
- **用户取舍**：远程会话愿意用吞吐换持久化与连接复用；不接受本地终端性能退化，也不接受无逃生阀。

## 目标

1. 远程 SSH 终端默认经由 `tmux -CC new -A -s omnipanel-<workspace>` 建立，**N 个远程 Tab 复用 1 条 SSH 连接 + 1 个 control channel**。
2. 远程会话**跨应用重启、崩溃与断网存活**；重新 attach 后 pane 内进程仍在运行，屏幕内容经 `capture-pane` 恢复。
3. **Blocks 能力零退化**：OSC 133 命令边界、退出码、shell history 同步、cwd 追踪在 tmux 路径下与直连一致。
4. **前端零改动接入**：control mode 解析在 Rust 侧完成，`%output %<pane>` 映射为既有 `session_id`，继续复用 `terminal-output` 事件契约与 xterm.js 渲染路径。
5. 提供**逃生阀**：单个远程 Tab 可切回直连 shell，用于大输出与高频重绘 TUI 场景。
6. 远端不具备 tmux 或版本过低时**静默降级**到现有直连路径，不向用户抛错。

## 非目标（Non-goals）

- **不在本地终端引入 tmux**。Windows 无原生 tmux（主平台），且本地既不需跨重启持久化也不需连接复用，接入纯亏吞吐。本地 PTY 路径不做任何改动。
- **不透传 tmux 自身 UI**。不显示 tmux status line、不使用其边框绘制、不引入 `Ctrl+B` 前缀键（会与应用快捷键正面冲突）。tmux 的 window/pane 仅作为传输层概念存在。
- **不在本次做 tmux pane ↔ dockview 分屏映射**。终端分屏本身尚未实现（`useGlobalShortcuts.ts` 中 `split-vertical`/`split-horizontal` 仍是占位），待分屏落地后另行提案。
- **不改动 `terminal-output` / `terminal-event` 事件契约**，不改动本地 PTY、Docker exec、数据库 CLI 终端的既有链路。
- **不替换 `output_buffer.rs`**。tmux 的 `capture-pane` 作为远程侧的增强来源接入，本地侧沿用现有 256KB 缓冲。
- **不追求 PRD 的 >500MB/s 吞吐目标覆盖远程 tmux 路径**（见「成功标准」中的定位说明）。

## What Changes

- **新增 control mode 协议层**：在 `crates/omnipanel-ssh` 下实现 `tmux -CC` 行协议解析器——`%output %<pane> <data>` 的八进制反转义、`%begin`/`%end`/`%error` 命令响应块配对、`%window-add`/`%unlinked-window-close`/`%layout-change`/`%exit` 等生命周期通知。
- **改造 `SshSession`**：从「一个 channel 一个 shell」改为「一个 control channel 承载 N 个 pane」。新增 pane 注册表维护 `pane_id ↔ session_id` 双向映射；`ssh_write` / `ssh_resize` 转译为 `send-keys -H` / `resize-pane`。既有 Tauri 命令签名保持不变。
- **新增远端能力探测与降级**：连接时探测 `tmux -V`，版本低于阈值或不存在则回落直连 `request_shell`，并在会话元信息中标注当前模式。
- **新增会话恢复路径**：重新 attach 时以 `capture-pane -p -e -S -N` 拉取历史注入 xterm，替代远程侧对 256KB 内存快照的依赖。
- **新增僵尸会话治理**：固定 `omnipanel-<workspace>` 命名前缀，`/server` 模块提供远端 tmux 会话列表、attach、kill 的可见管理入口；配置 `history-limit` 上限。
- **新增逃生阀设置**：单 Tab 级「直连模式」开关，切换后重建为直连 shell。
- **修复 OSC 133;D 退出码失真**：本地 `bash.sh` 与前端 `injectRemoteShellIntegration` 两处的 `$?` 均在传递前被覆盖，导致 Blocks 显示的退出码恒为固定值。前置验证实测确认（见下）。
- **修正 shell 集成脚本换行符**：`bash.sh` / `fish.fish` 工作区为 CRLF，与 `.gitattributes` 声明的 `eol=lf` 不一致，Windows 构建时经 `include_str!` 嵌入会使脚本在目标 shell 中语法错误、Blocks 静默失效。

## Capabilities

### New Capabilities

- `ssh-tmux-multiplex`: 基于 tmux control mode 的远程终端多路复用——单 SSH 连接承载多 pane、`%output` 行协议解析与 pane↔session 路由、写入/resize 转译、远端能力探测与直连降级。
- `remote-session-persistence`: 远程会话跨进程生命周期存活——命名会话 attach-or-create、detach 后进程续跑、`capture-pane` 历史恢复、僵尸会话可见与清理、单 Tab 逃生阀。
- `shell-integration-correctness`: shell 集成脚本的正确性基线——OSC 133;D 退出码如实反映命令结果、集成脚本以 LF 换行保证跨平台可加载。

### Modified Capabilities

<!-- openspec/specs/ 目前为空，无既有能力规格被修改；对 SSH 终端的行为变更由上述两个新能力承载。 -->

## 成功标准

- **连接复用**：同一主机开 10 个远程 Tab，服务端 `who` / `ss` 观测到 1 条 SSH 连接（当前为 10 条）；建连耗时仅首个 Tab 承担完整握手认证，后续 Tab 接近即开。
- **持久化**：远程 Tab 内启动长任务 → 强杀应用进程 → 重启应用 → 该 Tab 恢复后任务仍在运行且输出连续，屏幕内容与 detach 前一致。
- **Blocks 零退化**：tmux 模式下 Blocks 的命令分块、退出码标记、cwd 追踪与直连模式逐项比对一致；`TERM` 被 tmux 置为 `screen-256color`/`tmux-256color` 后，shell-integration 脚本的注入与分支行为不受影响。
- **性能定位明确**：交互式输入延迟无可感退化；大输出场景吞吐相对直连下降不超过实测基线（约 1/7），且逃生阀切换后恢复直连吞吐。PRD 性能目标（>500MB/s、输入延迟 <5ms）继续以**本地终端直连路径**为准绳，远程 tmux 路径单列指标。
- **降级可靠**：远端无 tmux / tmux 2.x 时自动走直连，用户侧无报错、无功能缺失感知，会话元信息如实反映当前模式。
- **无僵尸堆积**：`/server` 可列出并清理本应用创建的远端 tmux 会话；长期使用后目标机上不出现命名前缀匹配的孤儿 session 累积。

## Impact

- **crates/omnipanel-ssh/src/lib.rs**：`SshSession` 结构与 I/O 循环改造，新增 control mode 解析模块与 pane 注册表；`exec_gate: Semaphore(1)` 的串行约束在 tmux 路径下可绕开。
- **src-tauri/src/commands/ssh.rs**：`ssh_connect` / `ssh_connect_connection` / `ssh_connect_config_host` / `ssh_write` / `ssh_resize` / `ssh_disconnect` 内部实现调整，**命令签名与 `terminal-output` 事件契约保持不变**。
- **src-tauri/src/background/ssh_pool.rs**：连接池需感知 control 连接的复用语义与生命周期。
- **frontend/src/modules/server/**：新增远端 tmux 会话管理 UI；`frontend/src/modules/terminal/`：新增单 Tab 直连逃生阀入口与模式标识。
- **frontend/src/hooks/useTerminal.ts**：远程会话恢复来源从 `terminal_snapshot` 扩展到 `capture-pane`（前端仍走既有事件与 invoke 路径，无渲染层改动）。
- **crates/omnipanel-core/resources/shell-integration/**：`bash.sh` 退出码传递修正与换行符规范化；`fish.fish` 换行符规范化。
- **frontend/src/hooks/useTerminal.ts**：`injectRemoteShellIntegration` 注入脚本的退出码传递修正。
- **不影响**：本地 PTY 传输链路（`crates/omnipanel-core/src/terminal/`）、Docker exec 终端、数据库 CLI 终端、前端 xterm.js 渲染与 dockview 布局。
- **安全与环境标签**：tmux history 会留存 pane 内输入内容，需与凭据不落盘基线对齐（敏感输入不因 tmux 而进入远端可读缓冲）；对 `prod` 标签主机创建/清理 tmux 会话属于影响远端状态的操作，`kill-session` 须走二次确认。
- **依赖**：不引入新的 Rust/npm 依赖；新增对**远端主机** tmux 可执行文件的可选运行时依赖（缺失即降级）。
