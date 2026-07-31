## Context

远程终端当前的实现路径是：`ssh_connect` → `SshSession::connect`（russh `channel_open_session` + `request_pty` + `request_shell`）→ `tokio::select!` I/O 循环 → `SshSink` 回调 → `terminal-output` 事件（base64）→ 前端 `useTerminal` 写入 xterm.js。

三条现实约束塑造了本设计：

1. **一 Tab 一连接**。`ssh_connect` 每次调用都新建一个 `SshSession`，含完整 TCP 握手与认证。`src-tauri/src/state.rs` 中 `ssh_sessions: HashMap<String, SshSession>` 以 `ssh-{n}` 为键，彼此无共享。
2. **russh 的并发限制**。`SshSession` 里 `exec_gate: Arc<Semaphore>`（容量 1）串行化同连接上的 exec/SFTP，注释写明原因是「russh Handle 不支持并发 `channel_open_session`」。这意味着「一条连接跑多个 shell channel」这条朴素路线本身就走不通，必须依赖应用层多路复用。
3. **状态全在内存**。会话映射、`output_buffers`（256KB/会话）均为进程内，前端 `detachedRuntime`（30 分钟 TTL、上限 12）只是应用层模拟，无法跨进程。

spike 已验证 tmux 3.6 control mode 的三项关键行为：`%output` 是 pane 原始字节的八进制转义转发（OSC 序列零损失）、单 channel 可按 pane 分流、client 被杀后会话与进程存活。同时量化了代价：吞吐降至直连的 12%–15%，瓶颈在 tmux server 的 VT 解析与 grid 维护（线路膨胀率仅 1.09x/1.26x，不是带宽问题）。

## Goals / Non-Goals

**Goals:**

- 在不改变 `ssh_*` 命令签名与 `terminal-output` 事件契约的前提下，把远程终端的传输层从「一 Tab 一 shell channel」换成「一 Host 一 control channel + N 个 tmux window」。
- 让远程会话独立于应用进程存活，并在 attach 时恢复历史屏幕。
- 保证 Blocks 依赖的 OSC 133 链路零退化。
- 远端能力不足时无感降级，用户随时可对单 Tab 切回直连。

**Non-Goals:**

- 不改动本地 PTY（`crates/omnipanel-core`）、Docker exec、数据库 CLI 终端的任何链路。
- 不做 tmux pane ↔ dockview 分屏映射（终端分屏尚未实现）。
- 不引入新的 Rust/npm 依赖；control mode 解析器手写，不引入第三方 tmux 客户端库。
- 不替换本地侧 `output_buffer.rs`。

## Decisions

### D1：每个前端 Tab 映射为一个 tmux window（而非同 window 内的 pane）

**决策**：远程 Tab ↔ tmux window 一对一，每个 window 内只有一个 pane。

**理由**：tmux 中 pane 是 window 的空间划分，同 window 下各 pane 的尺寸由布局强耦合，无法让两个 pane 拥有各自独立的 cols/rows。而我们的每个前端 Tab 都是独立的 xterm 实例、有自己的尺寸。映射为 window 后，可用 `set-option -w window-size manual` + `resize-window -t @N -x <cols> -y <rows>` 对每个 window 独立控尺。

**替代方案**：全部塞进一个 window 的多个 pane，靠 `resize-pane` 调整。已否决——布局约束会导致所有 Tab 被迫共享一个总尺寸边界，resize 相互干扰。

**副作用与实测收口**（见 `tmux-compat-matrix.md`，四版本实测）：

- **受支持版本下限上调为 tmux ≥ 3.2**。3.0a 上 `resize-window` 只更新 `list-windows` 报告的 `window_width/height`，pane 内进程 `stty size` 仍是旧值，即未真正 resize，TUI 会渲染错位。3.2a / 3.4 / 3.6 均正常。
- **`window-size` 必须使用 window 级作用域，禁止 `-g`**：在 `set-option -g window-size manual` 生效期间执行 `new-window`，tmux 3.4 与 3.6 的**服务端直接崩溃**（control 连接收到 `%exit server exited unexpectedly`，全部会话丢失）。`default-size` 与 `new-window -d` 均无法规避。正确写法是每次建 window 后立即 `set-option -w -t @N window-size manual`。此约束为硬性要求，违反会造成用户所有远程会话丢失。

### D2：control mode 层放在 `crates/omnipanel-ssh`，commands 保持薄桥接

**决策**：新增 `crates/omnipanel-ssh/src/tmux/` 子模块承载全部协议逻辑；`src-tauri/src/commands/ssh.rs` 只做命令注册、参数桥接与事件 emit。

**理由**：符合仓库既定分层（crate 装业务、commands 装桥接）。协议解析是纯逻辑、无 Tauri 依赖，放在 crate 内可直接用 `cargo test -p omnipanel-ssh` 覆盖，不需要跑起 WebView。

**模块划分**：

- `tmux/parser.rs` — 行协议解析与八进制反转义，纯函数，零 I/O，单测主战场。
- `tmux/controller.rs` — `TmuxController`：持有 control channel、pane 注册表、命令响应队列。
- `tmux/probe.rs` — 远端能力探测与版本解析。

### D3：`%output` 反转义作为纯函数，与 I/O 解耦

**决策**：解析器接口设计为 `fn parse_line(line: &[u8]) -> ControlEvent`，反转义为独立的 `fn unescape_octal(src: &[u8]) -> Vec<u8>`。

**理由**：spike 已确认转义规则是稳定的八进制字面量（ESC→`\033`、BEL→`\007`、CR→`\015`、LF→`\012`，反斜杠自身→`\134`），可打印字符原样。这套规则可用表驱动实现并以属性测试覆盖「任意字节序列 → 转义 → 反转义 → 原字节」的往返一致性，这是保障 OSC 133 不退化的第一道防线。

**分片边界约束（高压实测收口）**：

- **单个八进制转义序列不会跨 `%output` 行拆分**（4 万帧 TUI 场景实测 0 次），因此逐行调用 `unescape_octal` 是安全的，无需在行边界维护半个转义序列的状态。
- **但 ESC 控制序列会跨 `%output` 行拆分**（同场景实测 3099 次，如 `\033[3` 落在一行、`1m` 落在下一行）。因此**反转义后的字节流必须跨行连续拼接后再交给下游**，任何按 `%output` 行边界做 VT/OSC 状态重置的实现都会漏检序列——OSC 133 同样可能被拦腰截断。这条约束直接决定：pane 字节流只能整体转发给前端 xterm.js，后端若要嗅探 OSC 133 必须自行维护跨行的流式状态机。

**关键测试点**：`\134` 必须先于其他序列正确处理，否则 `\\033` 这类内容会被二次反转义成 ESC，破坏字面反斜杠语义。

### D4：命令响应块用序号队列配对，不用文本匹配

**决策**：向 control channel 发送命令时按 FIFO 入队一个 oneshot sender，收到 `%begin <ts> <num> <flags>` 时取队首，累积至 `%end` 或 `%error` 后回填。

**理由**：control mode 保证命令响应严格按发送顺序返回，序号队列 O(1) 且无歧义。用输出文本猜归属在并发查询（如同时 `list-panes` 与 `capture-pane`）下会错配。

**边界**：`%error` 需封装为 `OmniError { code: ErrorCode::Ssh, cause: <tmux 错误文本> }`；未识别的 `%<name>` 通知行直接忽略并继续，绝不中断会话。

### D5：连接共享的键为 (host_identity, workspace_id)

**决策**：新增 `tmux_controllers: HashMap<ControllerKey, Arc<TmuxController>>` 到 `AppState`，键为主机身份与工作区的组合；tmux 会话名为 `omnipanel-<workspace>`。

**理由**：会话名已按工作区隔离（见 `remote-session-persistence` 规格），控制器复用粒度必须与之对齐，否则两个工作区会争抢同一 controller 却期望不同会话名。

**生命周期**：最后一个 Tab 关闭时**不**立即断开 control 连接（用户很可能马上再开），设置空闲超时后回收；controller 断连时标记失效，下次请求重建。这与 `ssh_pool.rs` 已有的 `is_closed()` + 自动重建思路一致。

### D6：写入走 `send-keys -H`，保证二进制安全

**决策**：`ssh_write` 的字节流编码为十六进制序列，经 `send-keys -t @N -H <hex...>` 投递。

**理由**：control mode 的命令通道是文本行协议，直接透传原始字节会破坏行边界。`-H` 接受十六进制值列表，对任意字节（含控制字符与非 UTF-8）均安全。

**权衡**：每字节膨胀为 3 字符（含分隔空格）。输入是低频小数据（人类击键），代价可忽略；但**粘贴大段文本**会放大这一开销，需要分批发送并设置单命令长度上限。

### D7：降级判定发生在连接阶段，且结果按主机缓存

**决策**：探测 `tmux -V` 经由已建立连接的 `exec_command` 执行（复用现有能力，不额外建连）；结果以 (host_identity) 为键缓存于应用生命周期内。

**理由**：探测本身需要一次 exec 往返，弱网下不可忽略。缓存后同主机后续 Tab 零探测开销。降级路径直接回落到现有 `SshSession::connect`，代码复用度最高、风险最低。

### 数据流

```
frontend/src/hooks/useTerminal.ts  (xterm.js)
   │  ssh_write / ssh_resize                    ▲  terminal-output {session_id, base64}
   ▼                                            │
src-tauri/src/commands/ssh.rs   ── 薄桥接：签名不变、只做参数转换与 emit ──
   │                                            │
   ▼                                            │
crates/omnipanel-ssh/src/tmux/
 ┌──────────────────────────────────────────────────────────┐
 │ TmuxController                                           │
 │   ├─ PaneRegistry     pane_id(%0) ↔ session_id(ssh-3)    │
 │   │                   window_id(@0) ↔ tab                │
 │   ├─ CommandQueue     FIFO ⇄ %begin/%end/%error          │
 │   └─ ControlParser    %output 行 → unescape_octal → bytes │
 └──────────────────────┬───────────────────────────────────┘
                        │  单条 russh channel（exec: tmux -CC）
                        ▼
                   SshSession（复用；新增 control 构造路径）
                        │  单条 TCP + 单次认证
                        ▼
                远端 tmux server  ──  @0/%0  @1/%1  @2/%2 ...
                （detach 后独立存活，进程续跑）
```

降级路径：探测失败时 `TmuxController` 不参与，直接走既有 `SshSession::connect` 的 `request_shell`，下游链路完全不变。

### 前后端边界

| 位置 | 职责 |
|------|------|
| `crates/omnipanel-ssh/src/tmux/` | 行协议解析、pane 注册表、命令队列、探测与版本判定 |
| `crates/omnipanel-ssh/src/lib.rs` | `SshSession` 新增 control channel 构造路径，保留既有 `connect` / `connect_no_shell` |
| `src-tauri/src/commands/ssh.rs` | 命令注册与参数桥接、`terminal-output` emit；不含协议逻辑 |
| `src-tauri/src/state.rs` | `tmux_controllers` 注册表与生命周期 |
| `frontend/src/modules/server/` | 远端会话列表 / attach / 终止 UI |
| `frontend/src/modules/terminal/` | 模式标识与单 Tab 逃生阀入口 |

### 新增 IPC 命令

全部返回 `Result<T, OmniError>`，用 `#[tauri::command]` + `#[specta::specta]` 标注，同步登记到 `collect_commands!` 与 `generate_handler!` 双清单，改完执行 `npm run gen:bindings` 重新生成 `frontend/src/ipc/bindings.ts`；前端一律经 `commands.*` + `unwrapCommand` 调用，不写裸 `invoke`。

- `ssh_tmux_list_sessions(connection_id: String) -> Vec<TmuxSessionInfo>`
- `ssh_tmux_kill_session(connection_id: String, session_name: String) -> ()`
- `ssh_tmux_capture_pane(session_id: String, lines: u32) -> String`
- `ssh_terminal_set_direct_mode(session_id: String, direct: bool) -> ()`

`TmuxSessionInfo { name, windows, created_at, attached }` 需派生 `Serialize` + `specta::Type`。

### UI 与设计系统

- **远端会话管理**：置于 `/server` 主机详情内，复用 `components/ui` 既有列表与操作按钮组件，沿用 `tokens.css` 的 `--surface` / `--accent` 与语义色；`prod` 标签主机的终止操作走既有二次确认组件与 `audit_log` 写入路径。
- **模式标识**：在终端 Tab 顶栏以低视觉权重的标签呈现（tmux / 直连），遵循「扁平层级、克制动效、高信息密度」的既有交互基调。
- **文案**：全部经 `useI18n`，默认简体中文，同步补 en-US。

### 与现有模块的联动点

- **SSH → Terminal**：`/server` 的 attach 动作复用 `lib/terminalSession.ts` 的 `openLocalTerminalSession` / `focusTerminalTab` 同类入口打开远程 Tab。
- **Terminal → Blocks**：OSC 133 链路不变，`blocksStore` 与 `terminalHistorySync` 无需感知传输层差异。
- **SSH → ssh_pool**：`background/ssh_pool.rs` 的连接池服务于 SFTP/监控/exec，与 control 连接是两类用途；需明确二者不复用同一 `SshSession` 实例，避免 control channel 的长驻 I/O 循环与池的健康检查互相干扰。
- **SSH → Docker**：Docker 的「SSH 宿主机」来源走独立路径，本变更不触碰。

## Risks / Trade-offs

- **[吞吐降至约 1/7]** → 限定在远程侧；本地终端零改动；提供单 Tab 逃生阀；`/server` 与 Tab 顶栏明示当前模式，让用户在大输出场景可主动切换。
- **[`TERM` 被改为 `screen-256color` / `tmux-256color`]** → **已实测排除**。集成脚本的 OSC 为无条件 `printf`、不走 `TERM` 分支，tmux 与直连两条路径 OSC 命中数逐项一致，无需改脚本或设 `default-terminal`。
- **[detached 会话持续消耗远端 CPU]** → 无人 attach 时 tmux 仍解析输出。缓解：设置有上限的 `history-limit`；`/server` 暴露会话可见性与终止入口，让用户能发现并清理。
- **[远端僵尸会话累积]** → 固定 `omnipanel-` 命名前缀使其可被识别与批量治理；会话名按工作区隔离避免跨项目污染。
- **[tmux history 留存敏感输入]** → 属于新增的暴露面。缓解：凭据仍只走 keyring 且绝不进入命令行或会话名；对敏感场景提供直连模式；在设置项说明中让用户知晓该特性。
- **[多版本行为差异]** → 已完成 3.0a / 3.2a / 3.4 / 3.6 矩阵验证：行协议与八进制转义格式四版本完全一致，差异集中在 resize 语义与 `window-size` 作用域（见 D1）。缓解：下限设为 3.2、`window-size` 只用 `-w`，解析器对未知通知行采取忽略而非报错的宽容策略。
- **[粘贴大段文本经 `send-keys -H` 膨胀]** → 分批发送 + 单命令长度上限；必要时对超大粘贴回退到提示用户使用直连模式或 SFTP 传输。
- **[control 连接单点]** → 一条连接承载 N 个 Tab，断连即全部受影响（当前是一 Tab 一连接，故障隔离更好）。缓解：会话持久化本身大幅削弱了这一风险——重连后 attach 回原会话，进程未丢；配合 `is_closed()` 检测与自动重建。

## Migration Plan

1. **只加不改**：control mode 路径与直连路径并存，探测决定走哪条。首版可用配置开关默认关闭 tmux 路径，内部验证通过后再翻默认值。
2. **回滚策略**：关闭开关即全量回落直连，无数据迁移、无 schema 变更、无 IPC 契约破坏，回滚成本接近零。
3. **既有会话不受影响**：本变更不触碰本地终端与其他终端类型，用户已有的使用习惯与布局持久化无需迁移。

## Open Questions

- ~~tmux 版本下限定在 3.0~~ **已收口**：四版本实测后下限上调至 **3.2**，并确认 `window-size` 禁用 `-g` 作用域，详见 `tmux-compat-matrix.md`。
- ~~`%output` 在超大突发输出下是否会被分片或丢弃~~ **已收口**：104MB / 260 万行场景下本地还原的 md5 与远端原文件**逐字节一致**，`%output` 行 76789 个、格式异常 0；4 万帧 TUI 全屏重绘场景帧序号连续无跳变。**无丢字节、无行截断**。分片边界行为见 D3。
- control 连接的空闲回收超时取值，需结合实际使用节奏确定；过短会频繁重建，过长会占用远端资源。
- 是否需要在 tmux 模式下继续维护本地 `output_buffers`（作为双保险），还是完全依赖 `capture-pane`，取决于 `capture-pane` 在弱网下的往返延迟表现。
