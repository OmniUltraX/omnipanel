## Context

命令栏把 `ls` 解析成 `LsListingView` HTML：目录点一下发 `cd`，文件点一下走 `tryOpenTerminalFilePreview`。直连只有 xterm 字符缓冲。

已有半成品：

- `useTerminalFileLinkProvider`：xterm `ILinkProvider`，hover 才算链接
- `terminalFileLinks.ts`：只认带 `/` 或盘符的 token
- `useTerminal.ts` 写死 `enabled: false`，且 ILink 的 `y` 写成 `1`

约束：不新造预览协议；不新增 IPC；不把 HTML 盖到格子上；第一版不做右键。命令栏行为保持不变。

联动：Terminal 直连 ↔ 文件预览窗（`terminalFilePreviewStore`）↔ SSH SFTP 列举（既有 `sftp_list` / 本地 files list）↔ cwd 面包屑用的 `terminalCdCommand`。

## Goals / Non-Goals

**Goals:**

- 直连 / live-native xterm 左键：目录 `cd`，文件预览
- `ls` 裸文件名可点（靠 cwd 目录缓存 + 颜色 / `-F` 后缀），不仅是 `/path`
- 鼠标协议应用让路；空闲提示符才往 PTY 打 `cd`

**Non-Goals:**

- 右键菜单
- OSC 8 / 改远端 `ls` 别名
- 改造命令栏 `EnrichedLsListingView`

## Decisions

### 1. 表面：ILink 只画下划线，点击走 pointer 命中

- **选择**：ILinkProvider 仍用于 hover 下划线；**左键动作不走 Linkifier `activate`**。关预览后 Linkifier 会丢掉 `_currentLink` 且不重探，依赖它第二次就点不了。
- **点击**：`document` 捕获阶段 `pointerdown`/`pointerup`，用 xterm MouseService（否则按格子尺寸）换算 buffer 格，再 `classifyLinePathLinks`。预览 overlay 上的点击忽略。
- **替代**：把 `LsListingView` 浮在 xterm 上 → 折行、滚动、选区全对不齐
- **实现**：`useTerminal.ts` 把 `enabled` 跟 `fileLink` + interactive 绑定

### 2. 分类：cwd 目录缓存为主，正则 / 颜色为辅

点击时必须知道「这是目录还是文件」。命令栏靠解析 `ls` + SFTP enrich。直连没有 block，但 cwd 已知，可以复用路径补全已经在用的列举缓存（`suggestPaths` / `sftpList` / 本地 list）。

优先级（高 → 低）：

1. **cwd 列举缓存命中**：名字 → kind（dir / file / symlink）。命中才给裸文件名做链接。
2. **`ls -F` 后缀**：`/` 当目录，`*` `@` 当文件/链接后剥后缀再解析。
3. **格子颜色**：token 整段是典型目录色（蓝 / 加粗蓝）→ 当目录。仅作缓存未命中时的弱信号。
4. **路径正则**（现有 `FILE_PATH_RE`）：`./foo`、`/etc/hosts`、`C:\...`。以 `/` 结尾当目录，否则当文件（预览门禁会拦不支持类型）。
5. **提示符 cwd 面包屑**：从 PS1 / PowerShell 提示符抽出展示路径，按分隔符切开，每段 `kind = dir`。`~` 用 `remoteHome`，没有则用当前 cwd 反推。不要把整段 `~/a/b` 当成文件。

缓存未就绪时：**只挂路径正则链接**，不把普通英文词做成链接。

cwd 变化时预取列举（debounce，与补全同一套 IPC，不新命令）。

### 3. 动作：文件预览随时可点；`cd` 仅在空闲 prompt

| 点击 | 动作 |
|------|------|
| 文件 | `tryOpenTerminalFilePreview`（与命令栏同一门禁） |
| 目录 | `sendCommand(maybeAppendAutoLsToPtyCommand(terminalCdCommand(absPath)))` 写入 PTY（与命令栏同一套 `buildCdWithAutoLs`，直连不受 warp 限制） |
| 目录但命令正在跑 / 不像 prompt | 不写 PTY，toast 提示 |

文件预览不碰 PTY，在 `cat` / 分页器里点日志路径仍然合理。`cd` 会打乱前台进程，必须守门。空闲判定复用直通已有的 prompt / `isCommandLive` 线索，不新造协议。

### 4. 鼠标协议让路

vim / less / htop 会开 DEC 鼠标跟踪。此时 `provideLinks` MUST 返回空，避免抢走点击。

检测：优先 `term.modes`（xterm 的 mouse tracking）；拿不到就看 parser 的 mouse mode。链接装饰也不画。

### 5. 修正 ILink 坐标

`range.start.y` / `end.y` MUST 使用 `provideLinks` 传入的 `bufferLineNumber`，禁止写死 `1`。`x` 为 1-based 列。

### 6. 前后端边界

| 层 | 职责 |
|----|------|
| crates / commands | **无新命令**；列举继续 `sftp_list` / 现有本地 files list |
| frontend `modules/terminal` | 识别、分类、ILink 注册、cd / 预览分流 |
| `commandBar/providers/pathProvider` | 尽量复用列举缓存，不复制 IPC |
| `terminalFilePreviewStore` | 预览门禁与开窗，不改协议 |
| IPC / specta | **无新 bindings** |

### 7. UI / tokens

- 沿用 xterm 默认链接下划线 / hover 指针，不新造卡片
- toast 走现有 `showToast` + i18n（zh-CN / en-US）
- 不新增 `components/ui` 控件

## 数据流

```
  xterm hover 行
       │
       ├─ 鼠标跟踪开？ ──yes──► 无链接
       │
       ▼
  扫描 token（路径正则 + 空白分词的裸名）
       │
       ├─ cwd 列举缓存命中 ──► kind = dir | file
       ├─ ls -F / 颜色 ────────► kind 弱推断
       └─ 都不像 ─────────────► 不挂链接
       │
       ▼ click
       ├─ file ──► tryOpenTerminalFilePreview
       └─ dir  ──► 空闲 prompt？
                     yes → PTY: cd 'abs'
                     no  → toast，不写 PTY
```

```
┌─ 直连 pane ─────────────────────────────────┐
│  xterm (ILinkProvider)                       │
│    ls 输出: src/  README.md  /etc/hosts      │
│              │        │           │          │
│              cd     预览窗      预览窗        │
│                                              │
│  cwd 列举缓存 ◄── sftp_list / 本地 list      │
└──────────────────────────────────────────────┘
```

## Risks / Trade-offs

- **[误点普通词]** → 裸名必须缓存命中；缓存未就绪只认路径正则
- **[cwd 过时]** → 相对路径点错目录。缓解：用 pane 最新 cwd；OSC 7 / prompt 已有同步路径，本变更不另造 cwd 协议
- **[symlink]** → 命令栏 `navigable` 会 cd。直连缓存若标成 dir/symlink 且 navigable，按目录 cd；否则当文件预览
- **[中文 / 空格文件名]** → `ls` 无引号时分词会断。MVP 不保证带空格裸名；带引号或路径正则的仍可点
- **[高吞吐 hover 算链接]** → ILinkProvider 本就是按行懒算；列举缓存 O(1) 查名字，禁止在 `provideLinks` 里打 IPC
- **[与 WebLinksAddon 抢 URL]** → URL 仍由 web-links 处理；路径正则已排除 `://`

## Migration Plan

- 纯前端开关：打开 interactive 的 provider。出问题把 `enabled` 改回 `false` 即可回滚。
- 无数据迁移、无配置项（第一版不设用户开关）。

## Open Questions

- 本地 Windows `dir` 输出是否第一版就要点（建议：路径正则先覆盖 `C:\...`；`dir` 列格式跟 Unix `ls` 不同，裸名等缓存命中再点）。
- 符号链接默认 cd 还是预览：跟命令栏 `navigable` 对齐（目录/可进入则 cd）。
