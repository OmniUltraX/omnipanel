# Module Runtime：Shell 编排 + Session/View 分离

状态：设计稿（P0–P4 已落地）  
日期：2026-09-04  
范围：`frontend`（主窗叠层路由、模块 Panel、Dock、插件 ModuleHost）  
相关现状：`overlayKeepAlive`、`OverlayModuleRoutePanel`、`ModuleVisibility`、`FrozenLocationWhenSuspended`、`DockableWorkspace`

## 1. 背景与目标

### 1.1 问题

模块切换卡顿与实现分叉同源：职责缠在同一棵 React 树上。

```
路由叠层 (App 手写 Overlay + LRU)
    ↕ 同时决定「是否挂载 / 是否可见 / 谁该重渲」
模块 Panel (Terminal / SSH / DB / …)
    ↕ 会话状态 + Dock Widget + IPC 订阅绑在一起
DockableWorkspace
    ↕ layout 同步、Tab 激活与业务强耦合
```

已做止血（应保留，并收进 Runtime）：

- `useModuleRouteActive` 改读 `ModuleVisibility`，不再 `useLocation`
- suspend 时 `FrozenLocationWhenSuspended` 不订阅 Router
- `OverlayModuleRoutePanel` / `SuspendedModulePanel` memo + 稳定 children
- LRU 保活「当前 + 最近 1」+ 工作区镜像 pin
- 悬停/空闲只预热 JS chunk，不再全量挂壳

这些仍是**散落策略**，不是统一运行时。插件 `PluginModuleHost` 曾直接 `useLocation`，证明契约未统一（P3 已改走 ModuleVisibility）。

### 1.2 目标

1. **性能**：侧栏切换时，React commit 范围收敛为「变为 active 的模块 + 进出保活集合的模块」；后台 Session 可继续收事件入缓冲，但不驱动重型 View。
2. **统一**：内建模块与插件模块共用同一套注册、保活、可见性、Session/View 契约；禁止再在 `App.tsx` 复制 Overlay 样板。
3. **可演进**：先 Runtime 骨架对齐现有行为，再按模块试点拆 Session，避免一口吃成 VS Code 全量 Workbench。

### 1.3 非目标

- 不做完整 VS Code Contribution Point / Extension Host。
- 不重写 dockview；继续以 `DockableWorkspace` 为 Dock 事实源。
- 不在本设计中改后端 PTY/IPC 协议（SessionService 封装现有 store + lifecycle）。
- 不强制所有轻量模块（如 plugins 列表页）实现 Session；无会话模块只注册 View。

## 2. 方案选型

| 方案 | 摘要 | 结论 |
|------|------|------|
| ① 仿 VS Code 全量 Workbench | Contribution + EditorModel/Pane + 扩展宿主 | 上限高、周期过长，否 |
| ② **Module Runtime** | 单一注册表 + SessionService / View 契约 + ModuleHost | **采用** |
| ③ 双轨渐进 | 先各模块拆 Session，Shell 后统一 | 易分叉，否 |

选定 **②**，覆盖此前讨论的 **C（Shell 编排 + 模块内核一起做）**，但以可控迁移实现，而非重写。

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│ ModuleRuntime（单例）                                          │
│  · registry: Map<id, ModuleDescriptor>                       │
│  · keepAlive state（current / recent / pinned）              │
│  · visibility: active | kept(suspended) | disposed           │
│  · warmChunk / pin 策略                                       │
└────────────┬───────────────────────────────┬─────────────────┘
             │                               │
   ┌─────────▼──────────┐          ┌─────────▼────────────┐
   │ ModuleHost (Shell) │          │ SessionService(s)    │
   │ 按 registry 渲染    │          │ 与 React 树解耦存活   │
   │ Overlay + LRU      │          │ IPC / 缓冲 / 连接     │
   └─────────┬──────────┘          └─────────▲────────────┘
             │                               │
             ▼                               │
   ┌───────────────────┐                     │
   │ ModuleView        │── bind(sessionId) ──┘
   │ Dock + 重型 Widget│  （仅 mounted 且策略允许时挂载）
   └───────────────────┘
```

**原则**：

- **声明在 Descriptor，编排在 Runtime，渲染在 Host，业务真相在 Session，像素在 View。**
- 路由只表达「用户想看哪个模块」；不表达「Session 是否存活」。

## 4. ModuleDescriptor 契约

每个内建 / 插件模块只注册一次。

```ts
/** 与现有 KeepAliveModuleId 对齐：OverlayModuleKey | `plugin:${string}` */
type ModuleId = string;

type ModuleDescriptor = {
  id: ModuleId;
  /** 主路径，如 /module/terminal */
  path: string;
  /** 含 dockview 等依赖尺寸测量的模块为 true */
  keepLayout: boolean;
  keepAlive: {
    /** 是否进入「当前 + 最近 N」窗口 */
    recentEligible: boolean;
    /** 工作区底部仍挂镜像 Tab 时 pin，不被 LRU 踢掉 */
    pinWhen?: "workspace-mirror";
  };
  /** 懒加载 View（React 组件） */
  loadView: () => Promise<{ default: ModuleViewComponent }>;
  /** 悬停 / 空闲只拉 chunk，不挂载 */
  warmChunk?: () => Promise<unknown>;
  /**
   * 可选。无会话的纯 UI 模块可省略。
   * Runtime 在首次需要时惰性 create，并按模块生命周期持有单例。
   */
  createSessionService?: () => ModuleSessionService;
};
```

### 4.1 注册位置

- 内建：`frontend/src/modules/registry/*.ts`（或等价目录），启动时 `registerBuiltinModules()`。
- 插件：插件激活时 `registerModule(descriptor)`，停用时 `unregisterModule(id)` 并 dispose 其 Session（若有）。
- **禁止**：在 `App.tsx` 再增加逐模块 `OverlayModuleRoutePanel` 手写分支。

### 4.2 与现有文件的映射

| 现状 | Runtime 后 |
|------|------------|
| `App.tsx` 一长串 Overlay | `ModuleHost` 遍历 `resolveMountedIds()` |
| `overlayKeepAlive.ts` | Runtime 内部策略（可保留纯函数实现） |
| `lazyModules.tsx` / `moduleWarmup.ts` | Descriptor.`loadView` / `warmChunk` |
| `routePanels.ts` Overlay 键表 | 由 registry 派生，或 registry 为唯一源 |
| `PluginModuleHost` 内 `useLocation` | 统一走 `ModuleVisibility` / `useModuleRouteActive` |

## 5. Session vs View

### 5.1 职责表

| | SessionService | ModuleView |
|--|----------------|------------|
| 存活 | 可脱离 React；由 Runtime / 业务显式 dispose | 随 Host 挂载；LRU 可卸载 |
| 职责 | 连接、PTY、查询会话、缓冲、重连、业务 store 真相源 | Dock 布局、Tab chrome、xterm/表格/监控等重型 Widget |
| 模块切换 | **默认不销毁** | 可卸载；再进入 `bind` 接回 |
| 禁止 | `useLocation` / 订阅 Router；在 Service 内渲染 DOM | 在 View `useEffect` 里「首次挂载才创建后端会话」当作唯一创建路径 |

### 5.2 Session API（最小集）

```ts
interface ViewSink {
  /** 会话输出 / 状态推到当前可见 Widget；unbind 后 Service 改写入环形缓冲 */
  push(event: unknown): void;
}

interface SessionHandle {
  id: string;
  /** 模块自定义元数据（resourceId、title 等）由各实现扩展，不进核心接口 */
}

interface ModuleSessionService {
  list(): SessionHandle[];
  get(id: string): SessionHandle | null;
  /** View 可见时绑定；返回 unbind。unbind 后 Session 仍可收事件入缓冲 */
  bindView(id: string, sink: ViewSink): () => void;
  /** 真正结束：关连接、清历史 */
  dispose(id: string): Promise<void>;
  /**
   * 模块整页被 LRU 踢出时回调。
   * 默认：保留 Session。
   * 仅当实现声明「无引用可回收」且策略允许时才批量 dispose。
   */
  onModuleEvicted?(): void;
}
```

终端现状对照（迁移目标，非一日完成）：

- `terminalStore` + backend lifecycle ≈ SessionService  
- `TerminalPanel` + xterm pane ≈ ModuleView  
- 「关 Tab ≠ 杀 Session、卸模块 ≠ 杀 Session」成为**所有模块同一语义**，不再是终端特例文档。

### 5.3 可见性与缓冲

| View 状态 | Session 行为 |
|-----------|--------------|
| active（路由当前） | `bindView`；实时推送到 Widget |
| kept / suspended（LRU 保活但非当前） | 已 unbind 或 soft-suspend；事件入有界缓冲 |
| disposed（被踢出挂载） | View 卸载；Session 默认仍活；缓冲策略由模块配置（上限、丢弃旧数据） |

## 6. ModuleHost 与状态机

### 6.1 模块实例状态

```
              navigate / pin
     ┌──────────────────────────────────┐
     │                                  │
     ▼                                  │
 [disposed] ──首次进入/预热策略──▶ [kept] ──activate──▶ [active]
     ▲                                  │                 │
     │                                  │                 │
     └──── LRU 踢出 / unregister ───────┴──── deactivate ─┘
                                              （仍在 recent/pin → kept）
```

- **active**：`active=true`，不 freeze Location，View 可布局测量。  
- **kept**：`mounted=true`，`suspended=true`，FrozenLocation，memo 跳过无关重渲。  
- **disposed**：不挂载 View；Session 按 §5 处理。

### 6.2 切换数据流（主路径）

1. 侧栏 / 命令 → `navigate(path)`（现有 `workspaceNavigation` 等）。  
2. Runtime 根据 `pathname` → `touchKeepAlive(nextId)`。  
3. Host 计算 `mountedIds = current ∪ recent ∪ pinned`。  
4. 对每个 mounted id 渲染统一壳：

   `OverlayModuleRoutePanel(active, mounted, keepLayout, panelId)`  
   → `SuspendedModulePanel` → `ModuleVisibility` → `FrozenLocation` → `Suspense(View)`。

5. 仅 `active` 变化或 `mounted` 进出的实例参与 commit；其余靠 memo 跳过。  
6. 侧栏「刚激活」同步仍放到 rAF（paint 后），避免堵首帧（保留现行为）。

### 6.3 Pin 规则

- `pinWhen: "workspace-mirror"`：当工作区底部 Dock 仍存在该模块镜像 Tab 时，id 进入 pinned 集合。  
- Pin 逻辑集中在 Runtime（可复用现有 `collectPinnedKeepAliveIds`），**禁止**在 App 与各 Panel 重复特判。

### 6.4 Dashboard

Dashboard 继续常驻（`mounted` 恒真或独立策略），避免每次回首页重建 dockview；在 registry 中显式标记，而不是 App 特例注释。

## 7. 与 DockableWorkspace 的接法

### 7.1 分层

```
ModuleView
  └─ ModuleWorkspaceLayout / 侧栏（可选）
       └─ DockableWorkspace
            └─ renderPanel(tabId) → Session-bound Widget
```

约定：

- Dock **只拥有布局与 Tab chrome**；不拥有 Session 生命周期。  
- `onActiveTabChange` 继续「paint 后再通知业务」（现有 `deferActiveTabNotify`），避免指针按下同步重活卡住高亮。  
- `contentSuspended` / `enabled` 一律来自 `useModuleRouteActive` / `ModuleVisibility`，禁止 View 内再订 `useLocation`（插件宿主必须改掉）。

### 7.2 Widget 绑定

```
Tab 激活 → sessionId = resolve(tabId)
         → sessionService.bindView(sessionId, sink)
         → Widget 挂载 / 恢复滚动与选择
Tab 失活或模块 suspend → unbind；缓冲继续
Tab 关闭（仅关视图）→ closeTabOnly；Session 可仍活
结束会话 → sessionService.dispose(id)
```

「关 Tab」与「结束会话」必须是两个显式 API；UI 文案与菜单与之一一对应。

## 8. 错误处理与边界

- **Descriptor 重复注册**：开发期 throw；生产期后注册覆盖并 `console.error`。  
- **loadView 失败**：Host 显示统一错误壳 + 重试；不影响其他 mounted 模块。  
- **Session.bind 时 id 不存在**：View 显示空态，不创建隐式会话（避免「打开 Tab 副作用建连」失控）。  
- **独立窗**：继续 `useModuleRouteActive` 的 standalone 语义（独立窗恒 live）；Runtime 不改变多窗模型，只保证 Visibility 注入一致。  
- **卸载插件模块**：unregister → 踢出 keepAlive → dispose 该插件 SessionService 拥有的会话。

## 9. 迁移计划

按阶段交付，每阶段可独立合入且行为可回归。

| 阶段 | 内容 | 验收 |
|------|------|------|
| **P0 Runtime 骨架** | registry + ModuleHost 替换 App 手写 Overlay；策略对齐现有 LRU/pin/warm | 切换手感不回退；`tsc -b` 通过 |
| **P1 终端试点** | Terminal SessionService / View 边界文档化并落到代码；关模块不杀 PTY | 切走终端再切回，会话与输出连续 |
| **P2 SSH → DB → Docker** | 同一 Dock + Session 模式批迁 | 三模块无 `useLocation` 判活；切换 commit 范围可测 |
| **P3 插件宿主** | `PluginModuleHost` 改 Descriptor + Visibility | 去掉 Host 内 `useLocation` |
| **P4 轻量模块** | tasks / plugins / knowledge 等按需只注册 View；残余 `useLocation` 清理；`contentSuspended` 对齐 `moduleLive` | registry 覆盖全部叠层侧栏入口；`modules/` 无业务判活用 `useLocation` |

**建议落地顺序原则**：先 Shell 统一（P0），再最重的终端 Session（P1），再批迁，避免「每个模块一种 Host」。

## 10. 测试与成功标准

### 10.1 自动化

- 保留并扩展 `overlayKeepAlive` 纯函数单测（touch / pin / recent limit）。  
- Runtime：`touch` + `resolveMounted` + pin 场景表驱动测试。  
- 契约：禁止模块 View 直接 import `useLocation` 做「是否 live」——可用 lint 规则或简单 grep CI（插件与内建同一条）。

### 10.2 手动 / 性能

- 侧栏连续切换 10 次：交互帧不出现整页长时间冻住；DevTools 中无关模块无大面积 commit。  
- 终端：输出中切换到其他模块再返回，缓冲不丢（或按模块声明的有界策略可解释）。  
- 工作区底部挂数据库镜像时，切走数据库模块不应 dispose 其 Session，且 pin 仍挂载。

### 10.3 成功标准（产品语言）

1. 新模块 = **一条 Descriptor +（可选）SessionService + View**，不再改 `App.tsx` 样板。  
2. 切换模块的成本与「当前保活集合大小」成正比，不与「已打开过的模块总数」成正比。  
3. 内建与插件在可见性、保活、Dock 悬停行为上无特例分叉。

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 终端 Session/View 边界历史包袱重 | P1 只抽接口与绑定点，不一次重写 xterm 管线 |
| keepLayout 模块仍贵 | LRU 严格限制 recent；禁止空闲全量挂壳（已做） |
| 双轨期 App 与 Host 并存 | P0 一次切到 Host；旧手写路径删除，避免长期两套 |
| 文档与实现漂移 | 本文件为契约源；实现计划另见 `docs/superpowers/plans/`（待写） |

## 12. 开放决策（实现前可微调，不阻塞 P0）

1. **recent 窗口**：默认保持 `OVERLAY_KEEP_ALIVE_RECENT_LIMIT = 1`；是否按机器内存升到 2 作为设置项，P0 不做。  
2. **Session 缓冲上限**：按模块配置（终端按字节/行，DB 按结果页）；P1 终端先定一条默认。  
3. **是否把 Zustand store 物理拆文件**：不强制；SessionService 可以是对现有 store 的门面，只要生命周期语义清晰。

## 13. 参考现状路径

- `frontend/src/App.tsx` — keepAlive / pin 编排；叠层渲染由 ModuleHost 接管  
- `frontend/src/modules/runtime/` — registry / ModuleHost / SessionService  
- `frontend/src/lib/overlayKeepAlive.ts` — 保活纯函数  
- `frontend/src/lib/moduleVisibility.tsx` / `useModuleRouteActive.ts`  
- `frontend/src/lib/historyLocationState.ts` — 深链读 history.state（不订 Router）  
- `frontend/src/components/ui/feedback/OverlayModuleRoutePanel.tsx`  
- `frontend/src/components/ui/feedback/FrozenLocationWhenSuspended.tsx`  
- `frontend/src/components/dock/DockableWorkspace.tsx`  
- `frontend/src/modules/terminal/TerminalPanel.tsx` — P1 试点  
- `frontend/src/modules/plugin-module/PluginModuleHost.tsx` — P3 去 `useLocation`

---

**状态**：P0–P4 已落地；后续按模块加深 Session/View 拆分即可，不必再改 Shell 样板。
