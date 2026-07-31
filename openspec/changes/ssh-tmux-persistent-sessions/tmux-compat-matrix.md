# tmux 版本兼容矩阵（任务 1.1 产出）

验证环境：WSL2 Ubuntu，`pty.fork()` 提供控制终端，每个场景独立 tmux server（`-L` 独立 socket、`-f /dev/null` 屏蔽用户配置）。
被测版本：3.0a / 3.2a / 3.4 手工编译于 `/opt`，3.6 为系统包。

## 基础能力

| 能力 | 3.0a | 3.2a | 3.4 | 3.6 |
|---|---|---|---|---|
| control mode 行协议（`%begin`/`%end`/`%output`/`%window-add`） | OK | OK | OK | OK |
| `%output` 八进制转义（ESC→`\033`、`\`→`\134`）与反转义还原 | OK | OK | OK | OK |
| `window-size manual` 选项可设置 | OK | OK | OK | OK |
| `resize-window` 真实改变 pane 尺寸（pane 内 `stty size` 反映） | **FAIL** | OK | OK | OK |
| 多 window 创建与 `%output` 按 pane 路由 | OK | OK | OK | OK |
| `capture-pane` 历史抓取 | OK | OK | OK | OK |

## 阻塞性发现：global `window-size manual` 会崩溃 3.4+ 服务端

在 `set-option -g window-size manual` 生效期间执行 `new-window`，tmux 3.4 与 3.6 的服务端直接退出，control 连接收到 `%exit server exited unexpectedly`，全部 pane 一并丢失。

| 场景 | 3.0a | 3.2a | 3.4 | 3.6 |
|---|---|---|---|---|
| A `set -g window-size manual` 后 `new-window` | OK | OK | **崩溃** | **崩溃** |
| B 先 `set -g default-size 80x24` 再同 A | OK | OK | **崩溃** | **崩溃** |
| C `set -g window-size manual` + `new-window -d` | OK | OK | **崩溃** | **崩溃** |
| D 先建 window，之后才设 global manual | OK | OK | OK | OK |
| E 仅 window 级 `set-option -w window-size manual` | OK | OK | OK | OK |

`default-size` 与 `-d` 均无法规避，唯一可靠绕法是**不使用 global 作用域**。

## 采纳方案与收口验证

对每个 window 单独设置 `set-option -w -t @N window-size manual`，绝不使用 `-g`。按此方案跑完整链路（建会话 → 收到 `%output` → 逐 window 独立 resize → 新建 window → 两 window 尺寸互不影响）：

| 版本 | 建会话 | 首个 resize | 新建 window | 第二 window resize | 尺寸互不影响 |
|---|---|---|---|---|---|
| 3.0a | OK | **FAIL** | OK | **FAIL** | OK |
| 3.2a | OK | OK | OK | OK | OK |
| 3.4 | OK | OK | OK | OK | OK |
| 3.6 | OK | OK | OK | OK | OK |

3.0a 的失败模式为：`resize-window` 后 `list-windows` 报告的 `window_width/height` 已更新，但 pane 内进程通过 `stty size` 看到的仍是旧尺寸，即只改了元数据、未真正 resize，TUI 程序会渲染错位。

## 高压完整性（任务 1.3，tmux 3.6）

| 场景 | 规模 | 结果 |
|---|---|---|
| 纯文本 `cat` | 104.1 MB / 2,600,000 行带序号 | 序号 0..N-1 全覆盖，**还原 md5 与原文件逐字节一致** |
| TUI 全屏重绘 | 40,000 帧（光标定位 / 清屏 / SGR） | 帧序号连续无跳变 |

- control 侧接收 122.5 MB，转义膨胀 1.18x，吞吐约 9.2 MB/s；`%output` 行 76789 个，格式异常 0。
- **未观察到任何丢字节或行截断**，tmux 在 control client 读取跟不上时采取阻塞而非丢弃。
- **分片边界**：八进制转义序列不跨 `%output` 行（0 次），但 ESC 控制序列跨行拆分 3099 次。故逐行 `unescape_octal` 安全，而反转义后的字节流必须跨行连续拼接，禁止按行边界重置 VT/OSC 状态机。

## 结论

1. **支持下限定为 tmux 3.2**，而非 design.md 原先推断的 3.0。低于 3.2 的目标机走直连降级。
2. **禁止对 `window-size` 使用 `-g` 作用域**，一律 `set-option -w -t @N window-size manual`，在每次 `new_window` 之后立即执行。这是硬性约束，违反会导致 3.4+ 上整个 tmux server 崩溃、所有会话丢失。
3. 探测逻辑需解析 `tmux -V` 并按 3.2 为界判定，版本号形如 `tmux 3.0a` / `tmux 3.6`，需处理尾随字母。
