从软件工程视角看，OmniPanel 的**领域拆分方向是对的**（crates + modules + IPC 生成），真正伤人的是：**约定写得很漂亮，但规模膨胀后边界没有跟着硬化**。下面按影响排序。

---

## 1. 前端缺少“可维护的模块架构”，只有目录

`modules/database` 里单文件曾经失控：`DatabasePanel` / `DatabaseToolbox` / `TableDataGrid` / `SchemaBrowser` 各数千行——一个模块吞掉编排、状态、IPC、菜单、工作区、同步。约定说「前端只负责展现」，实际是**厚 UI 编排层**。

**进展（方案 A · Q1 点名四文件已收口）**：组装壳一律 ≤1200，行为不变，`tsc -b` 通过。编排进显式 deps hooks；model 仍可继续手拆（勿用正则脚本），但不阻塞本条关闭。

| 壳 | 约行数 | 编排中枢（约行） | 已外提切面（摘要） |
|----|--------|------------------|-------------------|
| `DatabasePanel.tsx` | ~263 | `useDatabasePanelModel` ~2805 | Sql / TablePreview / DockTabs / Connections / MysqlTransfer / CsvExport / SchemaContextMenu |
| `DatabaseToolbox.tsx` | ~399 | `useDatabaseToolboxModel` ~698 | Connections / BgAnalysis / TaskLifecycle / Execute；常量模块级 `claimExecuteTaskCompletion` |
| `SchemaBrowser.tsx` | ~378 | `useSchemaBrowserModel` ~1578 | Types / Helpers / TreeNode / Hotkeys / SelectionSync / ContextMenu / FlatRow |
| `TableDataGrid.tsx` | ~790 | `useTableDataGridModel` ~2620 | Types / PointerInteraction / ColumnDefs（Selection·CellEdit·Canvas 等仍可续拆） |

旁注：`useTerminal` 等其它厚编排不在本条点名四文件范围内，属后续同范式扩展。

## 2. Store 分层被自己写的规则击穿

文档明确：`stores` 是唯一可写状态处，且**禁止 store ↔ modules 循环依赖**。现实是约 **125 个 store**，其中约 **30% 反向 import modules**；`aiStore` / `terminalStore` / `settingsStore` 动辄 800–1000 行，已经不是“状态容器”，而是**带副作用的应用服务**。

后果很具体：ESM 求值顺序问题（你们已经用 bridge 修过一次）、类型与生命周期纠缠、测试只能 mock 半个应用。这是架构债里最贵的一类——**原则在，执行口子开了，就会持续扩大**。

**进展（Q2 第一刀 · assistant / clientSync 硬环已切断）**：
- 扩展 / 新建 `lib/*Bridge`：`assistantSnapshotSync`（含 options + cancel）、`clientModuleSync`、`clientConversationSync`、`assistantInbox`（Chat + TerminalCmd）
- tombstones 下沉 `stores/clientSyncTombstoneStore`；`SqlKeywordCase` / `TerminalApprovalMode` / knowledgeTree·Tags / `sshAuthHold` 纯逻辑下沉 `lib/`，modules 侧 re-export
- `authStore` / `aiStore` / `aiModelsStore` / `connectionStore` / `workspaceStore` / `knowledgeStore` / 若干 layout·sidebar store 不再 import `modules/assistant|clientSync`
- eslint：`src/stores/**` 增加 `no-restricted-imports` 禁止 `**/modules/**`（存量其它域边未清，后续分批）
- 约定写入 CLAUDE.md / AGENTS.md：**新 store 禁止 import modules；反向通知用 lib/*Bridge**

---

## 3. `src-tauri` “薄编排”名存实亡

`panel/`（宝塔/1Panel，~1900 行）、`protocol/`（~1500 行）仍在壳里；同时还有约 **100 个 command 文件**、`bindings.ts` ~6000 行。IPC 面过大 + 壳层有业务，会导致：

- 桌面 / Web（`omnipanel-server`）**重复或分叉**实现风险上升  
- crate 边界形同虚设（“该进 crate 的还在壳里”）  
- `Result<T, String>` 与 `OmniError` 并存（database/protocol 等仍大量 String），错误模型未收敛

**进展（Q3 第一刀 · panel 已下沉；第二刀 · protocol grpc/modbus 已下沉）**：
- 新建 `crates/omnipanel-panel`（`btpanel` + `onepanel`），以原 `src-tauri/src/panel/` 为权威源迁入；`omnipanel-app` 与 `omnipanel-server` 改为依赖该 crate，删除两边本地 `panel/` 源文件。命令层（`commands/panel.rs` / `panel_cmds.rs`）仅改 import，IPC 语义不变。
- 新建 `crates/omnipanel-protocol`（`grpc` + `modbus`），以桌面 `src-tauri/src/protocol/{grpc,modbus}.rs` 为权威源合并；会话表仍在命令层 / `AppState`·`ServerState`。桌面删除本地副本，server 删除整个仅含这两文件的 `protocol/` 模块。**其余协议（http/ws/mqtt/sse/serial/redis/sniffer）仍在壳里，待后续下沉。**

---

## 4. AI 能力是“产品三条线”，不是清晰子系统

Rust：`omnipanel-ai` / `mcp` / `gateway`（再加前端 `lib/ai` 近 90 文件 + assistant / ai-gateway 模块）。路由、编排、工具、会话状态分散在 **crate + store + lib + UI**。对用户是“一个 AI”，对工程是**多入口、多生命周期、多端口**——认知成本与回归面都被放大。

**进展（Q4 第一刀 · 产品切面保留、工程入口收敛）**：
- 三条线作为**产品切面**保留，**不合并** crate（受众不同：in-app / OpenAI 网关 / MCP）
- `CLAUDE.md` 增加「AI 能力矩阵」：职责 / 端口 / 前端该怎么用；旁系（assistant 同步、遗留 SSE）标明
- `lib/ai/index.ts` 公开 barrel：仅 `runInternalAiChat` / `requestAiCompletionOnce` / `submitAiPrompt` / gateway·ports；不导出 `runSimpleChat` / `streamOpenAI`
- oneshot：有 IPC 时**即使有 API key**也走 `runInternalAiChat`（`pureText`）；禁止新开前端 `/chat/completions` fetch
- 设置页文案对齐：App 内对话不在此页；Trace 标注 `internal` / `gateway` / `mcp_external`
- 白名单：快捷启动页内流式仍用 `streamModelChat`（须与 Dock 会话隔离）
- 后置：抽出共享 `build_http_provider`、对齐 Desktop/Web 编排差、Traces 按 source 分栏

---

## 5. 平台层在复制，而不是收敛

`ContextMenu`、`IconDropdownButton` 曾各有两套实现且**已分叉**（hint portal、`group` 字段等）。这和刚才菜单图标统一是同一类问题：**没有单一事实源时，一致性只能靠人肉扫**。UI 原语双轨 = 设计系统尚未真正建立。

**进展（Q5 · menu 单轨）**：
- 事实源：`frontend/src/components/ui/menu/`（保留 placement / hidden 测量 / portal hint）
- 根目录 `ui/ContextMenu.tsx`、`ui/IconDropdownButton.tsx` 改为 thin re-export；`ui/contextMenuItems.ts` 仍 re-export `menu/`
- 根目录 `group` 组头渲染并入 `menu/IconDropdownButton`；补齐 `.context-menu-item__hint-tooltip` / `__hint-slot` / `row--with-hint`（portal hint + `title` 兜底）
- 调用方改为 `@/components/ui/menu`（或相对 `.../ui/menu`）；eslint `no-restricted-imports` 禁止直接引用根路径双轨文件

---

## 6. 产品面过宽，缺少“核心 + 卫星”切割

23 个前端模块 + 30+ crates，覆盖终端/SSH/DB/Docker/云/协议/知识库/插件/同步……这更像 **IDE 平台**，但工程上仍偏 **单体应用**（一个前端、一个桌面壳、一套巨型 IPC）。

合理演进通常是：

- 核心工作台（终端 / SSH / 文件）硬边界  
- 数据库、Docker、云等可插拔子系统（包边界 + 懒加载 + 独立发布节奏）  

现在更像**功能加法**，缺少“什么可以不进主进程/主包”的架构决策。

---

## 7. Desktop / Web 双形态：契约集中，分支散落

IPC transport 有收敛意识，但 `isTauriRuntime` 散落约 **68** 个文件，`canUseIpcBackend` 却很少用。结果是：能力矩阵靠人记，Web 缺能力时表现为运行时分支丛林，而不是清晰的 **Platform Capability** 表。

---

## 8. 过程架构与文档漂移

- 版本事实源是 git tag，工作区 `Cargo.toml` / `tauri.conf` 长期陈旧——新人极易误判版本  
- `ARCHITECTURE.md` 里 CI 描述自相矛盾；openspec 高完成度变更未归档，进行中数量与文档不一致  
- `lint` 空实现——类型靠 `tsc`，风格/导入边界没有自动化护栏  

这不是“文档写错了”这么简单，而是**缺少单一权威的架构治理面**。

---

## 怎么理解优先级（若只改三件事）

| 优先级 | 问题 | 为何先动 |
|--------|------|----------|
| P0 | 拆 `DatabasePanel` 级上帝文件 + 硬化 store 边界 | 日常改动与回归成本最高 |
| P0 | 把 `panel`/`protocol` 下沉 crate，IPC 只做桥 | 否则 Web/桌面与错误模型永远撕扯 |
| P1 | UI 原语单轨 + Platform capability 表 | 一致性与双形态才能可持续 |

---

**一句话结论**：领域 crate 拆分是加分项；真正不合理的是——**前端与壳层长成了第二套领域层，而约束（store 单向、薄壳、单一 UI 源、能力矩阵）没有随产品面一起硬化**。这是典型的“早期正确结构 + 后期规模失控”，不是方向选错。

若你愿意下一步落地，我可以按 P0 给一版**可执行的拆分路线图**（先拆 DatabasePanel 编排面，还是先下沉 panel/protocol），不写空文档。