## 1. 前置验证（阻塞性假设收口）

- [x] 1.1 多版本验证已完成，矩阵见 `tmux-compat-matrix.md`（3.0a / 3.2a / 3.4 编译于 `/opt`，3.6 为系统包）。两项结论已回写 design.md：**（a）下限由 3.0 上调至 3.2**——3.0a 的 `resize-window` 只改元数据、pane 内 `stty size` 不变；**（b）`window-size` 禁止 `-g` 作用域**——global manual 期间执行 `new-window` 会使 3.4/3.6 服务端崩溃并丢失全部会话，须改用 `set-option -w -t @N`。按该方案 3.2a/3.4/3.6 全链路（建会话 → `%output` → 逐 window 独立 resize → 新建 window → 尺寸互不影响）通过。
- [x] 1.2 验证 `TERM` 被置为 `screen-256color` / `tmux-256color` 后，`crates/omnipanel-core/resources/shell-integration/` 下集成脚本的注入与 OSC 133 发射行为是否受影响。**已完成**：以 `bash --init-file` 真实注入方式实测，tmux 与直连两条路径 OSC 命中数逐项一致（133;A 各 2、133;C 各 3、1337;CurrentDir 各 2），脚本 OSC 为无条件 `printf`、不走 `TERM` 分支，无需改脚本或设 `default-terminal`。同时暴露出两项既有缺陷，收敛为第 2 组任务。
- [x] 1.3 高压验证通过。**纯文本**：104.1MB / 260 万行带序号文本经 `cat` 输出，control 侧接收 122.5MB（转义膨胀 1.18x，约 9.2MB/s），序号 0..N-1 全覆盖无缺失/重复/乱序，**本地还原 md5 与远端原文件完全一致**（`909e42aec9a82bb6e3bde1c1b18b4095`），`%output` 行 76789 个、格式异常 0。**TUI 重绘**：4 万帧全屏刷新（含光标定位/清屏/SGR），16.1MB，帧序号连续无跳变、格式异常 0。**附带收口一条实现约束**：八进制转义序列不跨 `%output` 行（0 次），但 ESC 控制序列会跨行拆分（3099 次），故反转义后的字节流必须跨行连续拼接，禁止按行边界重置 VT/OSC 状态，否则 OSC 133 会被漏检。已写入 design.md D3。

## 2. shell 集成正确性修复（前置验证产出，独立于 tmux）

- [x] 2.1 修正 `crates/omnipanel-core/resources/shell-integration/bash.sh` 的退出码传递：`__omnipanel_prompt_callback` 首行 `local __ec=$?` 捕获后传参给 `__omnipanel_cmd_end`，消除 `__omnipanel_in_prompt=1` 赋值与 `__omnipanel_is_history_sync && return` 两处污染。**另修正 zsh 分支**：原先 `precmd` 注册了 `prompt_start` 与 `cmd_end` 两个 hook，既顺序颠倒（先 A 后 D）又被 `prompt_start` 的 printf 覆盖 `$?`，已合并为单个 `__omnipanel_zsh_precmd`（首行捕获、先 D 后 A）。
- [x] 2.2 同步修正 `frontend/src/hooks/useTerminal.ts` 中 `injectRemoteShellIntegration` 的退出码传递（`__omnipanel_pc` 首行捕获并传参），zsh 分支同样合并为单个 precmd，保持单行拼接格式与既有转义。
- [x] 2.3 核对 `fish.fish` 与 `powershell.ps1`：**均无同类污染，不做改动**。fish 以 `pty.fork()` 正确设置控制终端后实测 `true`/`sh -c 'exit 7'`/`false`/`sh -c 'exit 42'` 四组退出码全对（`--on-event fish_postexec` 中 printf 为首条语句，`$status` 未被污染）。PowerShell 实测 `OmniPanel-EmitOsc` 调用不改变 `$LASTEXITCODE`，原生程序退出码 0/7/1/42 全对；已知语义局限：cmdlet 失败时 `LASTEXITCODE=0` 而 `$?=False`，属 PowerShell 固有行为，不在本次范围。
- [x] 2.4 将 `bash.sh` / `fish.fish` / `powershell.ps1` 换行符规范化为 LF。验证方式：`git ls-files --eol` 三个文件均为 `i/lf w/lf`，与属性声明一致。
- [x] 2.5 回归验证通过：bash（本地 bash.sh）、zsh（ZDOTDIR 注入，模拟 `write_zsh_init`）、远程注入脚本、tmux -CC 传输四条路径下 `true`/`(exit 7)`/`false`/`(exit 42)` 均上报真实退出码；fish 单独验证亦全对。

## 3. 后端协议层（crates/omnipanel-ssh/src/tmux/）

- [x] 3.1 `tmux/parser.rs` 实现 `ControlEvent` 与 `parse_line`，覆盖 `%output`/`%extended-output`、`%begin`/`%end`/`%error`、`%window-add`/`%window-close`/`%window-renamed`/`%layout-change`、`%session-*`、`%pause`/`%continue`、`%exit`；未识别通知返回 `Ignored`，非 `%` 开头行返回 `Raw` 交由命令队列归集。`PaneId`/`WindowId`/`SessionId` 用 newtype 承载并按 `%0`/`@0`/`$0` 显示。
- [x] 3.2 `unescape_octal` 单遍扫描实现，绝不对产物二次解析（`\134033` 正确还原为字面量 `\033` 而非 ESC）。含伪随机字节序列往返测试（LCG 生成，避免引入 proptest 依赖）与全 256 单字节往返测试。
- [x] 3.3 OSC 回归单测以真实抓包行为固定用例：OSC 133 的 A/B/C/D（BEL 与 ST 两种结尾）、OSC 7/0/1337/633、真实 shell 提示符行与彩色输出行。另加一条**跨行拼接**用例，锁定「ESC 序列被拆到多个 `%output` 行后拼接可完整还原」这一实测行为。
- [x] 3.4 `tmux/probe.rs` 实现版本解析与三态判定（`Supported`/`TooOld`/`Unavailable`）。阈值 3.2，`Option<char>` 后缀使 `3.2 < 3.2a` 天然成立；覆盖 `3.0a`/`3.2`/`3.2a`/`3.4`/`3.6`/`2.8`/`next-3.7`/`3.2.1`/`master`/空串/命令不存在等分支。无法识别的版本一律降级直连而非冒险。

## 4. 后端控制器（crates/omnipanel-ssh/）

- [x] 4.1 `TmuxController` 采用「不做 I/O」的设计：入站行经 `dispatch_line` 喂入，出站命令经 `cmd_tx` 交给外部循环，使协议状态机可脱离 SSH 完整测试。输出经 `ControllerEvent`（`Output`/`SessionClosed`/`Terminated`）推给上层。
- [x] 4.2 `CommandQueue` 实现 FIFO 配对与 `%error` → `OmniError{ code: Ssh }` 封装。另补两处健壮性：命令写出失败时 `cancel_last` 撤回占位（否则此后每条响应都错配到前一条命令）；`fire_command` 虽不等待响应但仍入队占位，因为 tmux 对每条命令都回 `%begin`/`%end`，少占一格会让整个队列错位。断连时 `fail_all` 唤醒全部等待者。
- [x] 4.3 `PaneRegistry` 维护 session ↔ pane ↔ window 三向索引。重连场景下同名会话重复登记会先清理旧 pane/window 索引，避免把新输出投递到已销毁的 pane。
- [x] 4.4 会话操作 API 完成：`create_window`（新建 → 逐 window 设 manual → resize，顺序不可颠倒）、`close_window`（只 kill 对应 window，其他 Tab 不受影响）、`capture_pane`（`-e -J` 保留 SGR 并合并折行）、`list_sessions`（按 `omnipanel-` 前缀标记 `managed`）、`kill_session`、`list_panes`（重连重建映射）、`set_history_limit`。单测断言生成命令串**不含 `-g window-size`**。
- [x] 4.5 输入与尺寸转译完成：`send-keys -t %N -H <hex>` 按 1024 字节分批，十六进制编码可完整传递任意字节（含 NUL、引号、反斜杠、非 UTF-8 高位字节）而无需关心 tmux 引号规则；`resize-window -t @N -x -y` 按 window 独立控尺。会话名做 tmux 保留字符（`.`/`:`）与 shell 元字符双重净化，防注入。

## 5. 后端集成与降级（crates/omnipanel-ssh/src/lib.rs）

- [x] 5.1 `tmux/session.rs` 以扩展 `impl SshSession` 的方式新增 `open_tmux_control`：独占一个 channel，request_pty 后 exec `tmux -CC`（tmux 客户端要求控制终端，无 PTY 会以 "open terminal failed" 退出）。`connect` 与 `connect_no_shell` 保持不变。入站字节经 `LineAssembler` 装配成行（处理跨块切分与 PTY 的 `ONLCR`），再喂给控制器。
- [x] 5.2 `probe_tmux` 经既有 `exec_capture` 执行 `tmux -V`；任何失败都归为 `Unavailable` 而非让连接流程失败。版本不达标时 `open_tmux_control` 返回明确错误，供桥接层回落到既有 `request_shell` 路径。**按主机身份缓存探测结果与 `mode` 元信息由第 6 组的 `state.rs` 承担**（crate 层无主机身份概念）。
- [x] 5.3 control 通道断开时复用既有 `closed: AtomicBool` 语义：置位后由 `mark_disconnected` 唤醒全部在途命令、通知每个关联会话 `SessionClosed`、再发一次 `Terminated`，控制器随即拒绝后续请求，供下次请求重建。

## 6. Tauri 桥接层（src-tauri/src/）

- [x] 6.1 新增 `src-tauri/src/ssh_tmux.rs` 承载 `TmuxManager`，由 `state.rs` 以 `Arc<TmuxManager>` 持有。**键只用 `user@host:port`，未含 workspace_id**：同主机跨工作区共用一条连接才是「连接复用」的目标，按工作区分桶会退化成每工作区一条连接。空闲回收为「最后一个 Tab 关闭后延迟 5 分钟」，回收只断本地连接，远端 tmux 会话与其中进程不受影响。另含每主机建连串行锁（避免同时开多个 Tab 时重复建连）与不可用主机缓存（避免每次开 Tab 重复探测）。
- [x] 6.2 `ssh_connect` 先尝试 `TmuxManager::attach`，`Unsupported` 或任何错误都静默降级到抽出的 `connect_direct`（原直连逻辑原样保留）。命令签名与 `terminal-output` / `terminal-event` 载荷格式均未变，前端无感。
- [x] 6.3 `ssh_write` / `ssh_resize` 先转发给 `TmuxManager`，返回 `None` 表示该会话不归 tmux 管则回落原路径；`ssh_disconnect` 在 tmux 模式下只 `kill-window`，远端会话与同主机其他 Tab 不受影响。
- [x] 6.4 新增 `ssh_terminal_info`、`ssh_terminal_set_direct_mode`、`ssh_tmux_capture_pane`、`ssh_tmux_list_sessions`、`ssh_tmux_kill_session`，全部 `Result<T, OmniError>` + `#[specta::specta]`。**列表与终止走 exec 通道而非 control mode**：治理僵尸会话恰恰发生在没打开终端的时候，依赖活跃 control 连接会让功能在最需要时不可用；为此把 `TmuxSessionInfo` 与 `parse_session_line` 下沉到 `tmux/commands.rs` 供两条路径共用。
- [x] 6.5 双清单已同步登记，`cargo check -p omnipanel-app` 通过。根因已定位：`resource_get_profile` 等命令把裸 `serde_json::Value` 交给 specta，PhasesFormat 递归展开会把堆撑爆；已用 `JsonValue`（`specta(type = Any)`）包一层，`npm run gen:bindings` 可在数秒内完成。顺带修了若干既有的 specta 标注问题（`ChatLatestIndex.user_id`、若干 64 位字段/参数）。
- [x] 6.6 `ssh_tmux_kill_session` 无论成败都写 `AuditEntry`（`action=ssh.tmux.kill_session`，prod 记 `high`、其余 `medium`），env_tag 由后端查 connection 得到而非前端传入；前端在 prod 主机的确认框追加不可撤销与影响他人的强提醒。

## 7. 前端会话管理（frontend/src/modules/server/）

- [x] 7.1 主机详情新增「远端会话」页签（`TmuxSessionsDetailTab`），展示会话名、窗口数、创建时间、是否 attached，并按 `omnipanel-` 前缀标注来源。经 `commands.*` + `unwrapCommand` 调用，无裸 `invoke`。
- [x] 7.2 列表头部「打开终端」走 `lib/terminalSession.ts` 的 `openSshTerminalSession`，不跨 module import terminal 内部实现。**不做「attach 到任意指定会话」**：当前模型是一主机一会话（`omnipanel-<host>`），按名 attach 需要 TmuxManager 改成 host+session 双键复用，收益（接管外部手工建的会话）远小于复杂度，列表对这类会话只提供查看与清理。
- [x] 7.3 终止操作接 `appConfirm(kind: danger)`，prod 主机追加「不可撤销 + 影响其他连着该会话的人」提醒，后端同步写审计。
- [x] 7.4 zh-CN / en-US 文案齐全（`ssh.detailTabs.tmuxSessions`、`ssh.tmuxSessions.*`），全部经 `useI18n`。

## 8. 前端终端侧（frontend/src/modules/terminal/）

- [x] 8.1 `TerminalTransportBadge` 挂在会话头右侧，仅远程会话显示；直连为静态标签，tmux 为可点按钮。模式由 `terminalTransportStore` 承载，`useTerminal` 在建连/复用后经 `ssh_terminal_info` 刷新。
- [x] 8.2 逃生阀经 `ssh_terminal_set_direct_mode`：后端 detach 但**不 kill 远端 window**（进程继续跑），会话 id 不变故前端无需重建 Tab；切换后清除注入标记以便新 shell 重新注入 OSC 133。同主机其余 Tab 不受影响。
- [x] 8.3 `useTerminal` 的恢复路径按模式分流：tmux 走 `ssh_tmux_capture_pane`（本地 scrollback 在应用重启后已空，只有 pane 现场才有真实屏幕），失败回退本地快照；本地终端路径未改动。
- [x] 8.4 `terminal.transport.*` 文案齐全（zh-CN + en-US），tooltip 明确说明「同主机共用连接 + 关闭应用后远端继续运行」与直连的差异。

## 9. 验收与联调

- [ ] 9.1 连接复用验收：同主机开 10 个远程 Tab，在服务端用 `ss` / `who` 确认仅 1 条 SSH 连接；记录首个 Tab 与后续 Tab 的开启耗时差异。
- [ ] 9.2 持久化验收：远程 Tab 内启动长任务 → 强杀应用进程 → 重启 → 重开该 Tab，确认任务仍在运行、输出连续、屏幕内容恢复。
- [ ] 9.3 Blocks 零退化验收：同一组命令分别在 tmux 模式与直连模式执行，逐项比对命令分块、退出码、cwd 追踪、shell history 同步结果一致，且退出码为真实值（依赖第 2 组修复）。
- [ ] 9.4 降级验收：在无 tmux 与 tmux 2.x 的目标机上连接，确认自动走直连、无报错弹窗、模式标识正确。
- [ ] 9.5 性能对照：记录 tmux 模式与直连模式在大输出场景的吞吐差异，确认与实测基线（约 1/7）一致；确认交互输入延迟无可感退化；本地终端吞吐与变更前持平。
- [ ] 9.6 僵尸会话治理验收：长时间使用后在 `/server` 列出并清理 `omnipanel-` 前缀会话，确认远端无孤儿累积。
- [ ] 9.7 全量回归：`cargo test`、`cargo fmt --check`、前端 lint 与既有测试通过；确认本地终端、Docker exec、数据库 CLI 终端行为未受影响。
