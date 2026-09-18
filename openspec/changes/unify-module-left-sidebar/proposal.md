## Why

各模块左侧栏（知识库 / 终端 / SSH / 数据库 / Docker / 文件 / 服务器面板等）由不同时期不同人实现，形成至少三种分段形态、四套图标与状态点实现、两种搜索位置、三种点击语义。用户在截图中直观感受到"像三个产品拼在一起"。统一是 All in One 工作台可信度的前提（PRD 第一章：统一的工程驾驶舱），现在做是因为共享件已齐（`SidebarTreeNode` / `VerticalSplitSidebar` / `ScopedSearch` / `WorkbenchActionButton`），只差收敛。

## 目标

- 定义全模块通用的左侧栏三层标准：L0 模块顶栏（`ModuleLeftColumn`）→ L1 分段头（`VerticalSplitSidebarSection`）→ L2 树行（`SidebarTreeNode`），所有模块按同一顺序组装。**单分组原则：哪怕模块只有一个分组，也必须套 L1 段头（标题 + 计数 + 操作，可折叠），不允许裸树直挂。**
- 收敛图标 / 状态 / 徽标 / 操作按钮四类视觉：单一 `SidebarIcon` 集、单一 `StatusDot`、单一徽标与计数样式、行内与段头操作统一用幽灵按钮。
- 统一交互语义：单击选中 + 预览、双击常驻打开、右键菜单、F2 / Del 快捷键、拖拽三态提示，多选走同一 `SidebarTreeSelectionProvider`。
- 统一树通用功能：每棵树段头标配一键折叠 / 一键展开 / 刷新，展开态持久化走同一 Hook，右键菜单走同一段落模板，多选统一传 `orderedKeys`（Shift 范围选可用）。

## 非目标（Non-goals）

- 不改右侧工作区（Dock / 面板 / Tab）布局与逻辑。
- 不做主题 / 配色体系升级，只收敛到现有 workbench 幽灵风格（`.cursor/rules/workbench-actions.mdc`）。
- 不迁移插件自定义侧栏（`plugin-module/ModuleTreeSidebar` 除外只做适配层，不强制重写）。
- 不引入新的拖拽库与虚拟化方案，沿用现有 HTML5 DnD + pointer 排序 + tanstack virtual。

## What Changes

- 新增 `components/ui/module-sidebar/` 共享层：`ModuleSidebarSection`（L1 薄封装，统一 badge + actions 槽位，**单个分组也必须使用**）、`SidebarIcon`（folder / doc / connection / host / container 等，统一 14px / stroke 1.8）、`SidebarStatusDot`（`StatusDot` 别名收口）、`SidebarRowActions`（hover 操作容器，22px 幽灵按钮）。
- 新增树通用功能共享层：`ModuleSidebarTreeToolbar`（一键折叠 / 一键展开 / 刷新三个幽灵图标按钮，复用数据库双上箭头 path 与 `DockerTreeRefreshButton` 旋转语义）、`usePersistedTreeExpanded`（收敛 SSH / Docker / 终端 / 数据库 / 知识库五处同逻辑实现）、右键菜单段落模板（打开 → 新建类 → 标签 → 重命名/复制 → 删除，扩展 `buildSidebarTreeContextMenuItems`）。
- 知识库侧栏：`knowledge-tree-row` 自绘行迁到标准 `SidebarTreeNode` 用法，去掉本地 `FolderIcon/DocIcon`，段头 `+` / `⇄` 文本按钮换 `WorkbenchActionButton`，思源徽标收敛为标准 tag。
- 终端会话树：连接组迁入 `VerticalSplitSidebarSection`（标题 + 计数 + `+`），会话行状态点由 `topbar-tab-dot` 换 `StatusDot`，关闭 `×` 进 `SidebarRowActions`。
- SSH 主机列表：行图标 `host.svg` + `BrandIconImg` 收敛到 `SidebarIcon` 体系，计数 `badge badge-muted` 与终端 `server-tree-badge` 统一为一种，段头 download/box/plus 图标按钮换 `WorkbenchActionButton(icon)`。
- 数据库 / Docker / 文件 / 服务器面板：只做图标与徽标替换 + 段头 actions 对齐，不动树逻辑；删除各模块私有的 FolderIcon 重复定义。
- 文档：CLAUDE.md「Workbench UI」追加"左侧栏三层标准"小节。

## Capabilities

### New Capabilities

- `module-left-sidebar`：左侧栏三层结构、图标、状态、徽标、操作、搜索、点击/右键/快捷键/拖拽的完整行为规约（本提案的核心交付，含单分组原则）。
- `module-sidebar-icons`：统一图标集（folder / document / connection / host / status）的命名、尺寸与禁用自绘规则。
- `module-sidebar-tree-actions`：树通用功能（一键折叠 / 一键展开 / 刷新 / 展开持久化 / 右键段落模板 / 多选 orderedKeys）的行为规约。

### Modified Capabilities

- 无（`openspec/specs/` 现无侧栏相关规约；本次为新增，不涉及既有 REQUIREMENTS 变更）。

## Impact

- 影响路由与模块：`/knowledge`、`/terminal`、`/server`（SSH）、`/database`、`/docker`、`/files`，以及 `frontend/src/components/ui/sidebar-tree/`、`frontend/src/components/ui/sidebar/`、`frontend/src/components/workspace/ModuleLeftColumn.tsx`。
- 影响 Phase：Phase 1（终端/SSH）与 Phase 2（数据库）的工作区入口外观；行为保持兼容（点击语义统一为"单击预览、双击常驻"，属于体验收敛，已在数据库/知识库先行）。
- 风险：树行 class 名（`knowledge-tree-row`、`term-session-tree__connection-node` 等）被 CSS 与测试引用，迁移时保留 class 做兼容别名，分模块灰度。
- 成功标准见下。

## 背景与动机

- 现状证据（2026-09-18 调研）：
  - L0 顶栏：`ModuleWorkspaceLayout` + `ModuleLeftColumn` 已统一骨架，但各模块 `leftIconRail` / `leftHeaderActions` / `tagModuleKey` 组合不一（知识库带模式轨、SSH 带问 AI、终端只有标签）。
  - L1 分段：SSH/数据库/文件/服务器面板用 `VerticalSplitSidebarSection`（箭头 + 标题 + badge + actions，可折叠可调高）；知识库用裸 `knowledge-sidebar-treehead` + `+`/`⇄` 文本 `Button(variant=icon size=sm)`；终端用裸 `SidebarTreeRoot` + 每行 `+` 文本按钮（`frontend/src/modules/knowledge/KnowledgeSidebar.tsx:1080`、`frontend/src/modules/terminal/TerminalSessionSidebar.tsx:639`）。
  - L2 行：共享 `SidebarTreeNode`（`frontend/src/components/ui/sidebar-tree/SidebarTreeNode.tsx`）已存在，但 icon/status/trailing 各自为政：FolderIcon 在知识库（14px）与终端（13px）重复定义且路径相同；状态有 `StatusDot` / `topbar-tab-dot` / `HostStatusIndicator` / `knowledge-tree-vector-dot` 四种；徽标有 `knowledge-import-badge`（思源）/ `server-tree-badge` / `badge badge-muted` 三种。
- 不统一的代价：每新增一个模块就复制一套侧栏样式，修一个 hover / 对齐 bug 要改六处；用户学习成本高（"+ 在哪"、"点一下是预览还是打开"每个模块不一样）。

## 成功标准

1. 截图三模块（知识库 / 终端 / SSH）按新标准渲染：段头同高同字号同 badge 样式；树行同缩进（16px 步进 / 8px 基准）、同箭头（10px `›`）、同图标尺寸（14px）、同 hover 操作显隐。
2. `rg "function FolderIcon" frontend/src/modules` 只剩共享层一处定义；`rg "topbar-tab-dot" frontend/src/modules/terminal` 在侧栏树中清零（topbar 自身除外）。
3. `cd frontend && npx tsc -b` 零 error；现有 `sidebar-tree` / `sidebar` 相关 vitest 全过；手动验证单击预览 / 双击常驻 / F2 / Del / 拖拽在三模块一致。
4. CLAUDE.md 有"左侧栏三层标准"可引用小节，后续新模块照抄即可。
5. 每棵树段头都有一键折叠 / 一键展开 / 刷新三个按钮（无对应能力的树，按钮置灰而非缺失）；重启后树展开态不变；所有 `SidebarTreeSelectionProvider` 均传入 `orderedKeys`（Shift 范围选可用）。
