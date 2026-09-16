从软件工程视角看，OmniPanel 的**领域拆分方向是对的**（crates + modules + IPC 生成），真正伤人的是：**约定写得很漂亮，但规模膨胀后边界没有跟着硬化**。下面按影响排序。

---

## 1. 前端缺少“可维护的模块架构”，只有目录

`modules/database` 里单文件已经失控：`DatabasePanel` ~6000 行、`DatabaseToolbox` ~3800、`TableDataGrid` ~3700、`SchemaBrowser` ~2700。这不是“文件大一点”，而是**一个模块吞掉了编排、状态、IPC、菜单、工作区、同步**——评审、回归、并行改动都会撞车。

约定说「前端只负责展现」，实际是**厚 UI 编排层**：业务规则大量落在 Panel / hooks（如 `useTerminal` 2000+ 行）里，Rust crate 边界再清晰也挡不住前端成为第二套“领域层”。

**进展（方案 A · DatabasePanel 首刀已落地）**：组装壳 `DatabasePanel.tsx` ~263 行（≤1200 已达成）。编排拆到 `panel/`：`useDatabasePanelModel` ~2977、`useDatabasePanelSql` ~680、`useDatabasePanelTablePreview` ~993、`useDatabasePanelDockTabs` ~892、`useDatabasePanelConnections` ~394、`useDatabasePanelMysqlTransfer` ~335、`buildDatabaseSchemaContextMenu` ~273。行为不变，`tsc -b` 通过。model 仍可按切面继续手拆（勿用正则脚本）。`Toolbox` / `TableDataGrid` / `SchemaBrowser` 尚未动。

---

## 2. Store 分层被自己写的规则击穿

文档明确：`stores` 是唯一可写状态处，且**禁止 store ↔ modules 循环依赖**。现实是约 **125 个 store**，其中约 **30% 反向 import modules**；`aiStore` / `terminalStore` / `settingsStore` 动辄 800–1000 行，已经不是“状态容器”，而是**带副作用的应用服务**。

后果很具体：ESM 求值顺序问题（你们已经用 bridge 修过一次）、类型与生命周期纠缠、测试只能 mock 半个应用。这是架构债里最贵的一类——**原则在，执行口子开了，就会持续扩大**。

---

## 3. `src-tauri` “薄编排”名存实亡

`panel/`（宝塔/1Panel，~1900 行）、`protocol/`（~1500 行）仍在壳里；同时还有约 **100 个 command 文件**、`bindings.ts` ~6000 行。IPC 面过大 + 壳层有业务，会导致：

- 桌面 / Web（`omnipanel-server`）**重复或分叉**实现风险上升  
- crate 边界形同虚设（“该进 crate 的还在壳里”）  
- `Result<T, String>` 与 `OmniError` 并存（database/protocol 等仍大量 String），错误模型未收敛

---

## 4. AI 能力是“产品三条线”，不是清晰子系统

Rust：`omnipanel-ai` / `mcp` / `gateway`（再加前端 `lib/ai` 近 90 文件 + assistant / ai-gateway 模块）。路由、编排、工具、会话状态分散在 **crate + store + lib + UI**。对用户是“一个 AI”，对工程是**多入口、多生命周期、多端口**——认知成本与回归面都被放大。

---

## 5. 平台层在复制，而不是收敛

`ContextMenu`、`IconDropdownButton` 各有两套实现且**已分叉**（hint portal、`group` 字段等）。这和刚才菜单图标统一是同一类问题：**没有单一事实源时，一致性只能靠人肉扫**。UI 原语双轨 = 设计系统尚未真正建立。

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