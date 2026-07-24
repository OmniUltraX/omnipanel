## Context

叠层模块（`OVERLAY_MODULE_KEYS`）经 `App.tsx` 的 `overlayMounted` + `OverlayModuleRoutePanel` 按需挂载；隐藏时 `ModuleVisibility.suspended=true`，业务侧用 `moduleLive = isActiveRoute && !moduleSuspended` 门闩控制轮询/建 PTY/pool。

已有预热：

- `preloadModuleChunks`：idle 逐个拉 JS
- `scheduleNavHoverWarm`：侧栏 hover 140ms 挂壳
- `scheduleIdleTerminalWarm` / `scheduleIdleDatabaseWarm`：仅终/库 idle 挂壳

缺口：其余模块首次点击仍冷挂；终/库 `defaultRenderer="always"` 使壳一挂就灌未访问 Tab；`ModuleSegmentDock.enabled=false` 不阻止 panel 挂载。

**边界**：本变更纯前端调度与 dock 挂载策略；无新 IPC、无 crate/commands 改动；UI 仍用现有 Shell / dock 组件与 `tokens.css`，不新增视觉组件（侧栏就绪指示为非目标）。

**联动**：工作区底部 dock 已有 `contentSuspended` / 渐进 renderer，思想对齐但不合并调度器；SSH→Docker、DB→AI 等业务联动不改语义，仅可能因模块更早 ShellReady 而首次切换更快。

## Goals / Non-Goals

**Goals:**

- 空闲后全部叠层模块达到 ShellReady（错峰、不堵首帧）。
- Tab：未访问不挂内容；访问后 sticky；终/库去掉「一挂就 always 全量」。
- Live 重活继续跟 `moduleLive`；允许 idle 本地只读预取。
- 修正过时注释与调度 API，形成可复用的就绪模型。

**Non-Goals:**

- 启动同步全挂阻塞 LCP。
- 改业务 API / 生产确认 / 环境标签。
- 侧栏就绪 UI、工作区与模块共用同一 warmup store。

## Decisions

### 决策 1：三档就绪模型（Chunk → Shell → Content）

```
Boot（只保 Dashboard / 当前路由）
        │
        ▼
 idle / hover
        │
   ┌────┴────┐
   │ ChunkReady │  preloadOverlayModuleChunk
   └────┬────┘
        ▼
   ┌────┴────┐
   │ ShellReady │  requestModuleShellWarm → overlayMounted
   │            │  dockview 布局可恢复；suspended=true
   └────┬────┘
        │  navigate / 模块变 active
        ▼
   ┌────┴────┐
   │ ContentReady │  仅激活 Tab（+ visited sticky）
   │              │  moduleLive=true → 轮询/xterm/pool
   └─────────────┘
```

- 备选：启动同步全挂。否决——仍会抢首帧，与物理规律冲突。
- 备选：只预热 chunk、不挂壳。否决——切换时仍付 dockview mount 成本，达不到「丝滑」。

### 决策 2：用统一 idle 队列扩展 Shell 预热，替代终/库特例

在 `moduleWarmup.ts` 新增 `scheduleIdleOverlayShellWarm(keys, options)`：

- 顺序与 `IDLE_CHUNK_KEYS` 对齐（terminal 优先，其余随后）。
- 每步：`preload chunk` → `requestIdleCallback` → `requestModuleShellWarm`（App 内已有 `startTransition` 订阅）。
- 保留 hover 140ms 捷径；idle 与 hover 去重（已 mounted 则跳过）。
- 废弃/内联 `scheduleIdleTerminalWarm` / `scheduleIdleDatabaseWarm` 为该队列的特化调用或删除重复。

- 备选：一帧 `createOverlayMountedAll()` + transition。否决——仍可能同帧调度过多 dock 初始化；错峰更稳。

### 决策 3：Tab sticky-visited（替代粗粒度 always）

在 dock 层引入可复用策略（优先放 `components/dock`，供 `ModuleSegmentDock` / 工作区对齐）：

- 状态：`visitedTabIds: Set<string>`（可 per-dockScope 存 memory，不强制 persist）。
- `renderPanel(tabId)`：若 `tabId !== active && !visited` → 返回 `null`（或轻量占位）；激活时加入 visited。
- `defaultRenderer`：模块默认 `onlyWhenVisible`；对 **已 visited** 的面板，通过「内容已挂则不卸」保证 sticky（仅靠 onlyWhenVisible 会卸——故对终/库必须配合 visited 内容常驻：`always` **仅表示 dockview 保留 panel 宿主**，或自管「visited 则继续渲染内容」）。

推荐实现（与现有 dockview API 最贴）：

1. `defaultRenderer="onlyWhenVisible"` 作为基线；
2. 额外在业务 `renderPanel` 外包一层：`shouldMountContent = isActive || visited`；首次 active 时 `markVisited`；
3. 对已 visited 且需要防闪的模块，将 renderer 升为 `always` **仅在该 dock 至少有一个 visited 之后**，或对 visited 集合使用 always、未访问仍不渲染内容（`render null`），避免预热灌满。

终/库：删除「挂载即 always」；改为上述 sticky。xterm 仍靠 `suspended` + 既有 IntersectionObserver，不在 ShellReady 阶段创建。

- 备选：继续全局 always。否决——与预热目标冲突。
- 备选：纯 onlyWhenVisible 无 sticky。否决——终/库切 Tab 会闪/拆 xterm。

### 决策 4：收紧「非 live 不挂重内容」

核对并必要时修补：

- `DatabasePanel` / `DockerPanel`：`enabled={moduleLive}` 之外，确保 `renderPanel` 在 `!moduleLive` 时不创建 Monaco/表格/stats 订阅（可 `contentSuspended={!moduleLive}` 传入 dock）。
- Docker `useDockerContainerGrid` / stats：继续 `enabled: moduleLive`（或等价）；shell 预热只允许 `hydrateSidebarCache` 类本地读（可选，放在 idle 且 `moduleLive` 仍为 false 时显式调用只读 hydrate——若与现门闩冲突则新增 `prefetchLocalOnly` 路径）。
- 修正 `routePanels.ts` 注释：禁止的是「同步阻塞式全量挂载」。

### 决策 5：前后端边界

| 层 | 职责 |
|----|------|
| frontend `lib/moduleWarmup` + `App` | 调度 Chunk/Shell |
| frontend `components/dock` | sticky-visited / contentSuspended |
| frontend `modules/*` | 遵守 moduleLive；去掉粗 always |
| commands / crates | **不改**；无新 IPC |

### 决策 6：与工程工作区预热的关系

工作区 `workspaceDockWarmupStore` + `contentSuspended` 已落地。本变更不合并 store；仅在 Tab 策略上复用同一套「挂起内容 / sticky」思想，避免两套语义漂移（可抽小 util：`shouldMountDockTabContent({ active, visited, suspended })`）。

## Risks / Trade-offs

- **[Risk] idle 挂满 9 个 dockview 仍可能在低配机造成短卡顿** → Mitigation：严格串行 + idle timeout；可配置「仅预热 PRIORITY 列表」；首版默认全量但错峰间隔可调。
- **[Risk] sticky 后内存随打开 Tab 上涨** → Mitigation：接受为取舍；后续可加 LRU 卸载（非本变更）。
- **[Risk] onlyWhenVisible + null content 与 dockview 布局恢复边界情况** → Mitigation：先在终/库做 spik；布局 fromJSON 仍执行，仅 panel React 内容延后。
- **[Risk] 预热时本地 hydrate 误触发网络** → Mitigation：只读 API 白名单；默认不自动远端 refresh。
- **[Trade-off] 首次点未访问 Tab 仍可能有一帧加载** → 明确接受，换取预热轻量。

## Migration Plan

1. 落地 warmup 队列与注释修正（行为对用户透明，仅更快）。
2. 终/库切 sticky-visited；观察切 Tab 是否闪、xterm 是否保活。
3. 其余模块核对 `moduleLive` 门闩；按需加 `contentSuspended`。
4. 回滚：恢复终/库 `always` + 去掉全模块 idle shell 即可；无数据迁移。

## Open Questions

1. idle 全量 Shell 的默认间隔 / timeout 是否按机器档位区分（首版固定即可）。
2. Docker sidebar 本地 hydrate 是否在 ShellReady 后立即做，还是等首次 live（首版建议：ShellReady 后 idle 再做只读 hydrate）。
3. visited Set 是否跨模块会话 persist（首版 memory-only）。
