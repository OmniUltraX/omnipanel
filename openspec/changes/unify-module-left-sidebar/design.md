## Context

当前左侧栏分三层，但每一层都有两套实现并存：

- L0 模块顶栏：`ModuleWorkspaceLayout` → `ModuleLeftColumn`（`frontend/src/components/workspace/`）骨架已统一，各模块传入的 `leftColumnTitle` / `leftIconRail` / `leftHeaderActions` / `tagModuleKey` 组合不一。
- L1 分段：`VerticalSplitSidebar` + `VerticalSplitSidebarSection`（`frontend/src/components/ui/sidebar/VerticalSplitSidebar.tsx`，另有一份旧路径 `components/ui/VerticalSplitSidebar.tsx` 待收敛）是事实标准（SSH/数据库/文件/服务器面板在用）；知识库（`KnowledgeSidebar.tsx:1080` 自绘 `+`/`⇄` 文本按钮）与终端（`TerminalSessionSidebar.tsx:639` 每行 `+` 文本按钮）是裸实现。
- L2 树行：`SidebarTreeNode`（`frontend/src/components/ui/sidebar-tree/SidebarTreeNode.tsx`，缩进 step 16 / base 8，箭头 10px `›`，叶子圆点）是事实标准，但各模块的 `icon` / `prefix` / `afterLabel` / `trailing` 槽位填法各异，且 `FolderIcon` 在知识库（14px）与终端（13px）重复定义。

约束：纯前端变更，不动 Rust crate 与 Tauri commands；视觉收敛到现有 workbench 幽灵风格（`.cursor/rules/workbench-actions.mdc` + `tokens.css`），不引入新依赖与新主题。

## Goals / Non-Goals

**Goals:**

- 所有模块左侧栏按同一三层顺序组装，段头与树行 props 用法一致，新模块照抄一个示例即可。**单分组原则：L1 分段是强制层，哪怕模块只有一个分组（如知识库整棵树、终端会话树），也必须包一层 `ModuleSidebarSection`（标题 + 计数 + 操作，可折叠），裸 `SidebarTreeRoot` / 自绘 treehead 不允许直挂。**
- 图标 / 状态 / 徽标 / 按钮四类视觉单点定义，删除模块私有重复实现。
- 树通用功能单点定义：一键折叠 / 一键展开 / 刷新进段头 toolbar，展开持久化收成一个 Hook，右键菜单走段落模板，多选统一传 `orderedKeys`。
- 试点三模块（知识库 / 终端 / SSH）先对齐，其余模块只换图标与段头 actions（不动树逻辑），灰度可回滚。

**Non-Goals:**

- 不改 Dock / Tab / 面板；不做主题升级；不强制重写插件自定义侧栏；不引入新 DnD / 虚拟化库（见 proposal）。

## Decisions

### 决策 1：新增 `components/ui/module-sidebar/` 薄封装层，而非直接改 `VerticalSplitSidebar` / `SidebarTreeNode`

- 内容：`ModuleSidebarSection`（透传 `VerticalSplitSidebarSection`，只统一 `actions` 槽位放 `WorkbenchActionButton(icon)` + 计数 `SidebarCountBadge`）、`SidebarIcon`（folder / document / connection / host / container / database 等，统一 14×14 / stroke 1.8，复用现有各模块 path 中最完整的版本）、`SidebarStatusDot`（`StatusDot` 的语义别名：online/connecting/offline/idle）、`SidebarRowActions`（hover 才显的 22px 幽灵按钮容器，替代各模块 `tree-node-actions` + 裸 `+`/`×` 文本按钮）。
- 理由：`VerticalSplitSidebar` 承担高度持久化与拖拽测量（~480 行），`SidebarTreeNode` 承担选择/右键/多选（~360 行），直接改动会同时影响数据库大表树与文件树的高风险路径；薄封装只收敛"填什么"，不动"怎么工作"，可逐模块灰度。
- 备选（放弃）：合并两份 `VerticalSplitSidebar.tsx`（新旧路径）后再统一——合并本身是破坏性重构，应作为本变更的最后一步而非第一步。

### 决策 2：图标以"命名 + 尺寸锁死"治理，而非 CSS 覆盖

- `SidebarIcon` 用 `kind` 枚举 + 固定 `width/height=14`，不接受 `size` prop（呼应 AGENTS.md"不要再传 size"）；SSH 的 `host.svg` / 面板品牌图标降级为 `kind="host"` 的变体（品牌色只保留 1px 色条，不保留整图 большим小不一）。
- 备选（放弃）：纯 CSS 统一 `svg { width:14px }`——会被内联 `width` 属性打败，且管不住 img 图标。

### 决策 3：交互语义向"数据库 / 知识库"对齐（单击选中+预览，双击常驻）

- 终端当前单击即切换会话、文件用 `useTreeClickDelay`，统一为 `SidebarTreeNode` 的 `onSelect`（单击）/ `onActivate`（双击）两通道；单击修饰键（Ctrl/Shift）只改选区不抢开预览（知识库已有正确实现，直接推广）。
- 拖拽保留两种机制但分工明确：跨父子移动用 HTML5 DnD（知识库/SSH/文件），同级排序用 pointer 拖拽（终端连接组）；新模块默认用 HTML5 DnD，视觉提示统一 `drop-before/inside/after` 三类名。
- 备选（放弃）：全量迁到 dnd-kit——引入重型依赖，违背"优先扩展现有"原则。

### 决策 4：`ScopedSearch` 永远包在 L1 外层，搜索行为二分

- `query.trim().length >= 2` 走全文检索视图（知识库 FTS 模式为范本），否则走本地过滤 + 自动展开命中祖先；无搜索能力的模块（当前终端）补本地过滤而非保持无搜索。
- 备选（放弃）：每个分段各放一个搜索框——SSH 截图中三段共用顶栏标签筛选已证明全局筛选更省空间。

### 决策 5：单分组也强制套 L1 段头

- 知识库整棵树、终端会话树这类"只有一个逻辑分组"的侧栏，同样包一层 `ModuleSidebarSection`：标题取模块名（如"知识库"/"会话"），计数取叶子总数，actions 放该树的通用操作（新建 / 一键折叠 / 一键展开 / 刷新）。理由：没有这层，通用功能（折叠/刷新/计数）就没有挂载位，下次加功能又会自绘一个裸工具条——这正是知识库 `treehead` 的由来。代价是多占一行 28px 高的段头，但换来所有侧栏"第一眼结构"一致。
- L1 与 L2 分组各司其职：L1 是模块级分段（SSH 的连接/隧道/密钥、数据库的连接/查询/同步任务）；L2 是树内分组（终端的连接组、Docker 的连接节点、SSH 的 `~/.ssh/config` 分组）。终端连接组属于 L2，不因单分组原则再包一层 L1——终端整树包一层 L1"会话"即可。
- 备选（放弃）：单分组模块豁免——短期省一行高度，长期每个模块都会长出自己的裸工具条，重蹈覆辙。

### 决策 6：树通用功能收成 `ModuleSidebarTreeToolbar` + `usePersistedTreeExpanded` + 右键模板

- Toolbar 按钮固定顺序：新建（`+`，无新建能力的树不渲染）→ 刷新（`DockerTreeRefreshButton` 语义：12px、busy 旋转、stopPropagation，无能力置灰占位）→ 展开/折叠（二选一：有可收节点只显示折叠，全收起或空树只显示展开，两者永不同时出现）。折叠 path 复用数据库 `SchemaBrowser.tsx:192` 双上箭头，展开为其垂直翻转。
- 持久化：SSH（teamLocalStorage）、Docker/终端（localStorage）、数据库（zustand+快照）、知识库（store 数组）五处实现逻辑同为 `isExpanded/toggle/ensureExpanded`，收成 `usePersistedTreeExpanded(storageKey, { scope })` 一个；各模块只传 key，默认折叠态由调用方传入（终端连接组默认展开，其余默认折叠的现状不变）。
- 右键：`buildSidebarTreeContextMenuItems` 从"重命名+删除"扩展为段落模板（打开预览/常驻 → 新建类 → 标签 → 重命名/复制 → 删除 danger），各模块只填 extraItems；终端"移到工作区"子菜单、知识库"向量化/分享"段作为 extraItems 原样保留。
- 多选：所有 `SidebarTreeSelectionProvider` 强制传 `orderedKeys`（虚拟树传扁平 key 数组，普通树传 `collectAll*SidebarTreeKeys` 现有函数返回值）；批量删除统一走 `resolveSidebarTreeDeleteTargets` + 一次确认。终端/知识库/SSH 现缺 `orderedKeys` 导致 Shift 范围选失效，本次补齐。
- 置顶/排序二期：数据库行内置顶图钉（叶子>50 的树）与文件式收藏段（连接类）各保留一种语义，不再发明第三种；拖拽沿用 HTML5 DnD（跨父）+ pointer（同级排序）分工。本期只定规范不迁移，见 spec 二期小节。

```
┌ ModuleWorkspaceLayout ─────────────────────┐
│ ┌ ModuleLeftColumn (L0) ─────────────────┐ │
│ │ title + ModuleTagHeader + actions/rail │ │
│ │ ┌ ScopedSearch ──────────────────────┐ │ │
│ │ │ ┌ ModuleSidebarSection (L1) ─────┐ │ │ │
│ │ │ │ header: arrow+title+badge+acts │ │ │ │
│ │ │ │ body:                         │ │ │ │
│ │ │ │  SidebarTreeNode (L2) × N     │ │ │ │
│ │ │ │   arrow/icon/label/meta/acts  │ │ │ │
│ │ │ └───────────────────────────────┘ │ │ │
│ │ └───────────────────────────────────┘ │ │
│ └────────────────────────────────────────┘ │
└────────────────────────────────────────────┘
数据流：zustand store → useModuleTagFilter →
 ScopedSearch query → filter/FTS → SidebarTreeSelection →
 onSelect(preview)/onActivate(permanent) → Dock tabs
```

前后端边界：本变更 100% 前端（`frontend/src/components/ui/module-sidebar/` 新增 + `frontend/src/modules/*` 侧栏改造 + `frontend/src/styles/` 样式收敛 + `frontend/src/i18n/` 文案复用）。不新增 IPC 命令，无需 `gen:bindings`；不碰 `crates/` 与 `src-tauri/commands/`。

UI 复用：`VerticalSplitSidebarSection`、`SidebarTreeNode` + `SidebarTreeSelectionProvider`、`ScopedSearch`、`WorkbenchPanelHeader/WorkbenchActionButton`、`FormDialog/ContextMenu` 保持不变，新层只做"填槽位规范"。

联动点：SSH→终端（`sshHostQuickJumps` 的"在终端打开"菜单依赖主机树 key，迁移保留 `data-connection-id` 与 `ssh:host:<id>` key 格式）；数据库→AI（NL2SQL 入口在 iconRail，不在侧栏树内，不受影响）；标签筛选（`useModuleTagFilter` 的 moduleKey：knowledge/terminal/ssh/database 保持不变）。

## Risks / Trade-offs

- [Risk] 树行 class 名被 CSS/测试硬编码（`knowledge-tree-row`、`term-session-tree__connection-node`、`server-tree-badge`）→ Mitigation：迁移期保留旧 class 作兼容别名，新样式只加 `sidebar-*` 前缀类；按 知识库→终端→SSH→其余 顺序灰度，每步跑 `tsc -b` + 相关 vitest。
- [Risk] 两份 `VerticalSplitSidebar.tsx`（`components/ui/sidebar/` vs `components/ui/`）import 分裂，改一处漏一处 → Mitigation：新 `ModuleSidebarSection` 只从 `components/ui/sidebar/VerticalSplitSidebar` 导入，旧路径文件加 `@deprecated` 注释指向新路径，本变更末尾统一改 import（纯改路径，不改逻辑）。
- [Risk] 终端 pointer 排序与 `SidebarTreeNode` 内建拖拽冲突 → Mitigation：连接组头保留 pointer 排序实现，会话行用标准 onSelect/onActivate；`skipNextToggleRef` 逻辑原样保留。
- [Risk] SSH 品牌图标收敛引发"认不出面板类型"抱怨 → Mitigation：保留文字标签（`panelServiceTypeLabel`）与 1px 色条，只收图标尺寸。
- Trade-off：短期新增一层薄封装（+4 个小组件）换长期删除 N 处重复 FolderIcon/状态点实现，首版代码行数微增，试点完成后净减少。

## Migration Plan

1. 新增 `components/ui/module-sidebar/`（Section/Icon/StatusDot/RowActions/CountBadge）+ 样式 + 单测（不接任何模块，可独立合入）。
1b. 新增树通用功能（`ModuleSidebarTreeToolbar` + `usePersistedTreeExpanded` + 右键段落模板扩展 + `orderedKeys` 补齐），先只接数据库段头验证（数据库已有折叠按钮与 orderedKeys 语义，最接近目标态）。
2. 知识库试点：整树包一层 L1"知识库"段头（单分组原则）→ 换图标→换段头按钮→思源徽标标准化，每步可单独回滚（`git revert` 单 commit）。
3. 终端试点：整树包一层 L1"会话"段头（单分组原则，连接组保留为 L2），会话行状态点与关闭按钮标准化，保留排序与 AI 重命名逻辑。
4. SSH 试点：图标与 badge 统一，段头 actions 换 `WorkbenchActionButton(icon)`。
5. 数据库/Docker/文件/服务器面板：纯替换图标与 actions，不动树逻辑；旧 `VerticalSplitSidebar` 路径改 import + 标 deprecated。
6. CLAUDE.md 追加"左侧栏三层标准"小节；跑 `tsc -b` + `vitest run` + 手动三模块回归（预览/常驻/右键/F2/Del/拖拽/搜索/标签筛选）。
7. 回滚：任一步失败只 revert 对应模块 commit，共享层保留（未被引用无影响）。

## Open Questions

- 终端无搜索框：补本地过滤搜索是否会与顶栏全局命令面板（Ctrl+K）重复？倾向于补（侧栏过滤是树内定位，命令面板是跨模块跳转），评审时确认。
- 文件模块 `useTreeClickDelay`（单击延迟区分单/双击）是否向全模块推广？倾向不推广（增加 200ms 感知延迟），只保留文件模块现状，评审时确认。
