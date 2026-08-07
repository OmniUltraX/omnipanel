## 1. Editor Find+Replace

- [x] 1.1 确认/添加 `@codemirror/search` 依赖（`frontend/package.json`），封装共用 search extensions（如 `frontend/src/components/ui/content/editorSearch.ts`）
- [x] 1.2 为 `CodeEditor` 接入 search + searchKeymap；只读时禁用替换（`frontend/src/components/ui/content/CodeEditor.tsx`）
- [x] 1.3 为 `SqlEditor` extensions 接入同一套 Find+Replace（`frontend/src/modules/database/sqlEditor/editor/`）
- [x] 1.4 调整 `scopedSearchRegistry`：焦点在 `.cm-editor` 时不拦截查找快捷键（`frontend/src/components/ui/search/scopedSearchRegistry.ts`）
- [x] 1.5 文件预览可编辑表面验证 Find/Replace 可用；补充 vitest 或手工验收清单（Ctrl+F / 替换 / dirty）

## 2. 统一预览壳与 IO 工厂

- [x] 2.1 新增 `previewIo.ts`：按 local / file_manager / sftp 构建标准 `FilePreviewIO`（`frontend/src/modules/files/`）
- [x] 2.2 `FilePreviewSubWindow` 默认 `showFileTree=true`；树根=当前文件 parent；折叠/宽度持久化（`FilePreviewSubWindow.tsx`、`FilePreviewTreeSidebar.tsx`、settings 或 session store）
- [x] 2.3 改造终端入口改用 IO 工厂，去掉重复 customIO 拼装（`TerminalFilePreviewSubWindow.tsx`）
- [x] 2.4 改造 `SftpPanel` / `FileConnectionPanel`：统一传 session + 工厂 IO，补齐 archive 方法（`components/sftp/`、`modules/files/`）
- [ ] 2.5 手工验收：四入口打开预览均有当前目录树；SFTP 压缩包可列目录

## 3. 本地大日志后端

- [x] 3.1 实现本地 log 会话能力（open/读行/tail/search/follow），优先放合适 crate 或 `src-tauri` 内聚模块；命令薄桥接 `Result<_, OmniError>`
- [x] 3.2 注册 specta 双清单并更新 bindings（`src-tauri/src/lib.rs`、`frontend/src/ipc/bindings.ts`；完整 gen 需释放锁定的 app exe）
- [x] 3.3 前端 `LogBackend` 抽象；SSH 包装现有 `logApi.ts`，Local 走新 bindings（`modules/files/`）
- [x] 3.4 `LargeLogViewer` / `FilePreviewContent` 分流支持本地（无 sshResourceId 也可进大日志）（`LargeLogViewer.tsx`、`FilePreviewContent.tsx`）
- [ ] 3.5 验收：本地与 SSH >10MB 文本可打开、可搜索；大日志无替换；必要时 `cargo test` / 手工

## 4. LogSurface 预留（可后置）

- [ ] 4.1 抽出与 LargeLog 一致的搜索/跟踪 UI 契约文档或薄组件边界（不强制迁完 Docker）
- [ ] 4.2 （可选）Docker 容器日志迁入共享表面（`modules/docker/subwindows/DockerContainerLogsView.tsx`）
- [ ] 4.3 （可选）站点面板日志迁入（`modules/server/panel/WebsiteActionSubWindows.tsx`）

## 5. 收尾

- [ ] 5.1 i18n 文案（zh-CN/en-US）覆盖查找/替换、大日志本地错误提示
- [ ] 5.2 对照 specs 做一次端到端手工验收并勾选 tasks
