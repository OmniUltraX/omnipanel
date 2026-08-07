## Context

文件预览已有分层雏形，但入口拼装不一致：

- 壳：`FilePreviewSubWindow`（可选 `showFileTree`，仅终端默认开启）
- 内容：`FilePreviewContent`（kind 路由 + 大文件分流）
- 渲染：`ContentPreviewView` / `ArchivePreviewView` / 媒体流
- 大日志：`LargeLogViewer` + 后端仅 `sftp_log_*`（SSH）
- 运行时日志：独立 `LogViewer`（xterm 全文，Docker/站点）
- 搜索：ScopedSearch（侧栏）vs 编辑器被动 `highlightQuery` vs LargeLog 自带 grep

约束：IPC 走 tauri-specta；业务前端禁止新裸 `invoke`；模块间不互引（跨模块走 store）；UI 对齐 tokens 与既有 SubWindow / FilePreviewTreeSidebar。

## Goals / Non-Goals

**Goals:**

- 统一预览壳与 IO 工厂；默认文件树（根=当前文件 parent）
- 本地+SSH 大日志同一 `LargeLogViewer` UI
- CodeMirror 统一 Find+Replace；编辑器焦点优先于 ScopedSearch
- 预留 LogSurface，供 Docker/站点日志分期迁入

**Non-Goals:**

- 重写文件管理器 / 替换 ScopedSearch 列表语义
- PDF/Office 解码
- 一次迁完所有运行时日志 UI

## Decisions

### D1. 预览壳默认开树，根为当前文件所在目录

- **选择**：`FilePreviewSubWindow` 默认 `showFileTree=true`；`FilePreviewTreeSidebar` 以 `parent(entry.path)` 为初始根/焦点目录。
- **备选**：仅「无浏览器上下文」的入口开树 → 否决，产品要求全部统一。
- **UI**：复用现有 `FilePreviewTreeSidebar` + 可拖拽宽度；折叠/宽度写入 settings 或 session store（与现有 treeWidth 状态对齐并持久化）。

### D2. 标准 PreviewSession + FilePreviewIO 工厂

```
  入口(文件管理/SFTP/终端/本地)
           │
           ▼
   buildPreviewIO(session)  ──► FilePreviewIO
           │
           ▼
   FilePreviewSubWindow ──► FilePreviewContent
           │                     │
           │                     ├─ <10MB text → TextEditor/ContentPreview + Editor Find
           │                     ├─ large text → LargeLogViewer(LogBackend)
           │                     ├─ media / archive
           │                     └─ unsupported
           └─ FilePreviewTreeSidebar(session, root=parent)
```

- **工厂位置**：`frontend/src/modules/files/previewIo.ts`（files 模块内；终端/SFTP 只传 session，不复制 IO 拼装）。
- **跨模块**：终端仍通过 `terminalFilePreviewStore` 打开，不 import SFTP 面板。

### D3. Editor Find+Replace 基于 @codemirror/search

- **选择**：在 `CodeEditor` 与 `SqlEditor` extensions 中统一加入 `search({ top: true })` + `searchKeymap` + `highlightSelectionMatches`；替换面板一并开启。
- **备选**：自研 ScopedSearch 包编辑器 → 否决（替换/正则/大小写 CM 已成熟）。
- **快捷键优先级**：`scopedSearchRegistry` 在 `activeElement` 位于 CodeMirror `.cm-editor`（或显式 `data-editor-find="1"`）时 **不** 拦截 Find；交由 CM。文件预览只读 markdown/plain 视图可用 ScopedSearch 或只读 CM 同一 Find。

### D4. LogBackend 抽象 + 本地 log IPC

- **前端**：`LogBackend` 接口（open / readLines / tailInitial / search / startTail / stopTail），SSH 实现包装现有 `logApi.ts`；Local 实现调新 bindings。
- **后端边界**：
  - 业务：优先放 `crates/`（若已有文件读能力可扩展 `omnipanel-exec` 或 files 相关 crate）；无合适 crate 时先在 `src-tauri` 内聚本地 log 模块，命令层仍薄。
  - `commands/*`：仅注册 `local_log_open` / `read_lines` / `search` / `tail_*` 等，`Result<T, OmniError>`，specta 双清单一致后 `npm run gen:bindings`。
- **分流条件**：保持现有 >10MB / size unknown 的 text|json → LargeLog；本地不再因缺 `sshResourceId` 而 blocked。

### D5. LogSurface 分期

- Phase A（本变更必做）：文件大日志 local+ssh。
- Phase B（可后置任务）：Docker/站点从 xterm `LogViewer` 迁到共享虚拟列表+搜索 UI；运行时流用 push 适配同一表面。

### D6. 替换与保存

- 内存文档替换直接改 CM doc → 走既有 dirty/save。
- 大日志模式：**只读**，不提供替换（避免对 GB 级文件原地写）；UI 明确禁用替换或隐藏。

## Risks / Trade-offs

- [本地大文件 grep 性能] → 限制结果页大小、超时与取消；超大文件默认末尾窗口模式（对齐现有 WINDOW 阈值）。
- [Ctrl+F 双注册冲突] → 明确焦点规则 + 单测/手工清单；必要时 ScopedSearch 检查 `closest('.cm-editor')`。
- [SFTP archive IO 补齐] → 依赖远端工具；失败路径保持现有安装提示。
- [模块边界] → IO 工厂留在 files；终端只依赖 files 公开 API（已有依赖方向）。

## Migration Plan

1. 落地 Editor Find（低风险，可先合）。
2. 默认开树 + IO 工厂，改各入口传参（行为增强，无 BREAKING API）。
3. 本地 log IPC + LargeLog 接 Local backend。
4. （可选）Docker/站点迁 LogSurface。
5. 回滚：各步可独立 revert；bindings 需同步回滚。

## Open Questions

- 本地 follow：用轮询 stat+tail 还是 OS file watch？（实现时选平台稳妥方案，Windows 优先轮询或 notify）。
- 只读 ContentPreview（markdown/web）是否也挂轻量 Find，还是统一切到 CM code 模式再搜？（默认：有 CM 的模式用 CM Find；纯 markdown 渲染可用 ScopedSearch 高亮。）
