## Why

文件预览在文件管理、SFTP、终端、本地面板等多入口各自拼装：左侧目录树、大文件日志模式、压缩包/媒体 IO、搜索能力参差不齐。普通文本预览与 SQL 编辑器甚至没有可用的查找/替换。现在统一壳、IO 与搜索，才能把「打开文件」做成一致、可预期的工作台体验。

## 目标

- 所有文件预览入口共用同一套 **UnifiedPreviewShell**：默认左侧文件树（根为当前文件所在目录）、统一工具栏与能力开关。
- **本地 + SSH** 大文本/日志均可走流式日志模式（切片读、搜索、跟踪），不再仅限远端 `sftp_log_*`。
- CodeMirror 系编辑器（文件预览、CodeEditor、SqlEditor 等）提供统一的 **查找 + 替换**；与侧栏 ScopedSearch、大日志 Log Find 分层，不抢快捷键。
- Docker / 站点等运行时日志可迁入同一 LogSurface（可分期）。

## 非目标（Non-goals）

- **不**重做整个文件管理器或替换侧栏 ScopedSearch 的列表过滤语义。
- **不**首期实现 PDF/Office 等二进制文档解码预览（仍可 unsupported + 下载提示）。
- **不**把 AI 对话内容预览纳入本次范围。
- **不**强制一次 PR 迁完所有 Docker/站点日志 UI；LogSurface 可后置，但接口预留。

## 背景与动机

- 现状分层已有雏形：`FilePreviewSubWindow` → `FilePreviewContent` → `ContentPreviewView` / `LargeLogViewer` / `ArchivePreviewView`，但入口开关不一致（仅终端开树、SFTP 缺 archive IO、本地大文件直接 blocked）。
- 搜索三套割裂：ScopedSearch（侧栏）、LargeLogViewer 自带 grep、编辑器仅有被动 `highlightQuery`、无 Find/Replace。
- 影响 Phase：Phase 1–3 交叉表面——`/terminal`、文件、SSH/SFTP、`/database` SQL 编辑器、`/docker` 与 Server 面板日志。

## What Changes

- 抽出标准 `PreviewSession` + `FilePreviewIO` 工厂（local / file_manager / sftp），消灭终端与 SFTP 重复拼装。
- `FilePreviewSubWindow` 默认开启文件树；树根 = 当前文件 parent 目录；宽度/折叠可记忆。
- 后端：本地日志会话 API（与现有 SSH `sftp_log_*` 对齐能力），前端 `LogBackend` 抽象接入 `LargeLogViewer`。
- CodeEditor / SqlEditor / 文件预览编辑面：接入统一 Editor Find+Replace（含 Ctrl/Cmd+F、F3、替换；编辑器焦点时优先于 ScopedSearch）。
- （分期）Docker/站点 `LogViewer` 迁向 LogSurface，共享搜索/follow/虚拟列表交互语言。

## Capabilities

### New Capabilities

- `unified-file-preview`: 统一预览壳、文件树、入口 IO、能力矩阵（媒体/压缩包/下载/保存）
- `editor-find-replace`: CodeMirror 编辑器统一查找与替换，快捷键与 ScopedSearch 优先级
- `large-log-surface`: 本地+SSH 大文件/流式日志查看（切片、搜索、跟踪）；预留运行时日志迁入

### Modified Capabilities

- （无主库 `openspec/specs/` 既有能力；本变更全部以新 capability 规格为准）

## 成功标准

- 从文件管理 / SFTP / 终端 / 本地面板打开同一类文本文件，预览窗均有左侧当前目录树，工具栏行为一致。
- 本地与 SSH 上 >10MB 文本/日志均可打开，可搜索、可加载更多/跟踪（权限与环境标签策略不变）。
- 文件预览与 SQL 编辑器：Ctrl/Cmd+F 打开查找，可上下跳转与替换；焦点在编辑器时不误触侧栏 ScopedSearch。
- SFTP 预览具备与终端一致的压缩包列目录（在远端工具可用时）。

## Impact

- 前端：`modules/files/*`、`modules/terminal/TerminalFilePreview*`、`components/sftp/SftpPanel`、`components/files/LocalFilePanel`、`components/ui/content/CodeEditor`、`modules/database/sqlEditor`、`components/ui/search/scopedSearchRegistry`；可选 Docker/Server 日志面板。
- 后端：新增本地 log session 命令（或扩展现有 files/SSH log 命令），保持 `Result<T, OmniError>` + specta bindings。
- 依赖：可能引入/正式使用 `@codemirror/search`。
- 模块路由：`/terminal`、文件、SSH、`/database`、后续 `/docker` 与 Server。
- 生产环境：日志跟踪与远端 grep 只读；替换/保存仍走既有 dirty 确认与写权限路径，不绕过确认策略。
