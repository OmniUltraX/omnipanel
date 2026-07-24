## Why

侧栏切换模块时，首次进入常因「JS chunk + Overlay 壳 + dockview + 激活 Tab 内容」同步冷启动而顿挫；现有预热只覆盖终端/数据库壳与 chunk 队列，其余模块仍是点击才挂载。同时终端/数据库用粗粒度 `defaultRenderer="always"` 换「切 Tab 不闪」，却让壳一挂就灌满未访问 Tab，与「只准备激活 Tab」的目标冲突。首页进工作区全屏的优化已证明：ShellReady 与 ContentReady 拆开、未访问内容挂起，是正确方向——现在要把同一套就绪模型推广到全部叠层模块。

## 背景与动机

- **Phase**：Phase 1 体验基座（Shell / 路由叠层 / 各模块 `/module/*`），不改变业务功能语义。
- **现状能力**：`preloadModuleChunks`、侧栏 hover 挂壳、`scheduleIdleTerminalWarm` / `scheduleIdleDatabaseWarm`、`moduleLive = isActiveRoute && !moduleSuspended`。
- **结构缝隙**：历史注释禁止「启动全量挂载」针对的是同步堵首帧；今日已有 suspended / moduleLive 门闩，idle 错峰全挂壳可行。`ModuleSegmentDock.enabled=false` 并不阻止 panel 挂载；数据库 `always` 在预热路径仍会挂未访问 Tab。
- **用户取舍**：可为丝滑切换牺牲「未激活 Tab 延后加载」；接受 idle 预热略增内存。

## 目标

1. 应用空闲后，全部叠层模块达到 **ShellReady**（chunk + Overlay 已 mount + dock 布局可恢复），侧栏二次切换接近显隐。
2. 每模块预热/首挂时 **只准备当前激活 Tab**；未访问 Tab 点击或异步再挂。
3. 访问过的重型 Tab（终端 xterm、数据库 SQL 面）**粘住不卸**，避免切回闪一下。
4. Live 重活（Schema 远端全量刷新、多 xterm、Docker stats 轮询）继续跟 `moduleLive`；允许 idle 做本地只读预取（连接列表/侧栏磁盘缓存）。

## 非目标（Non-goals）

- 不在启动第一帧同步 `createOverlayMountedAll()` 阻塞首页 LCP。
- 不改变各模块业务 API、IPC、生产环境确认策略。
- 不本次重做 GPU 终端 / 虚拟列表算法；不强制侧栏「就绪」UI 指示（可作为后续增强）。
- 不把工程工作区（`/workspace/:id`）与模块预热混成同一套调度器（工作区已有独立 warmup；仅对齐 Tab sticky 策略思想）。

## What Changes

- **扩展空闲 Shell 预热**：在现有 terminal/database 之外，对全部 `OVERLAY_MODULE_KEYS` 做错峰 `requestModuleShellWarm`（chunk → shell），一律 `startTransition`，不堵首帧。
- **统一三档就绪模型**：ChunkReady → ShellReady → ContentReady（激活 Tab）；文档化并替换过时的「禁止全量挂载」注释。
- **Tab 策略改为 sticky-visited**：默认未访问不挂内容；首次激活后加入 visited 并粘住；终端/数据库去掉「一挂载就 always 灌全部 Tab」。
- **收紧 `enabled`/挂载语义（按需）**：保证 `moduleLive=false` 时未访问/非激活重内容不挂；必要时增强 `ModuleSegmentDock` / `DockableWorkspace` 对「内容挂起」的支持。
- **可选本地预取**：idle 下允许 Docker/DB 等读取本地连接或 sidebar 缓存（仍不启轮询/远端 Schema 全量刷新）。

## Capabilities

### New Capabilities

- `module-shell-ready`: 叠层模块分阶段就绪调度——idle/hover 错峰 Chunk+Shell 预热、首帧不阻塞、与 `moduleLive`/`suspended` 协同。
- `dock-tab-sticky-visit`: Dock Tab 懒创建与访问后粘住——未访问不挂内容、激活后 sticky、覆盖模块 dock 与（策略对齐的）工作区 dock。

### Modified Capabilities

<!-- openspec/specs/ 目前为空，无既有能力被修改。 -->

## 成功标准

- 冷启动后停留首页数秒，侧栏依次点开已预热模块：无明显「白屏 + 长任务」；Performance 上切换主成本接近样式/可见性，而非整模块 mount。
- 数据库/终端：预热挂壳后，DevTools 中未访问 Tab 对应的重型子树（Monaco/xterm）未创建；首次点开某 Tab 后切走再切回不闪、不重建（sticky）。
- 首页 LCP / 首交互：相对现状不退化（全挂壳仅 idle/`startTransition`）。
- Docker：模块未 live 时无 stats/容器列表轮询；live 后行为与今一致。

## Impact

- **frontend/src/lib/moduleWarmup.ts**、`routePanels.ts`、`routes/lazyModules.tsx`、`App.tsx`：全模块 idle shell 调度。
- **frontend/src/components/dock/**：`ModuleSegmentDock` / `DockableWorkspace` 的 sticky-visited 或 contentSuspended 能力。
- **modules/terminal、database**（必改 always）；docker/files/server/protocol/workflow/knowledge/tasks（默认 onlyWhenVisible，核对预热安全）。
- **不影响**：Rust crates、IPC 契约、生产确认、环境标签策略。
- **Phase / 路由**：Phase 1；`/module/terminal|database|docker|files|server|protocol|workflow|knowledge|tasks` 与 Dashboard overlay。
