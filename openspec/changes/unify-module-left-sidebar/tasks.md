## 1. 共享层搭建（frontend/src/components/ui/module-sidebar/）

- [ ] 1.1 新增 `SidebarIcon`（folder/document/connection/host/container/database/key/tunnel，固定 14px/stroke 1.8）+ 单测快照（目标：`frontend/src/components/ui/module-sidebar/`，验证：vitest 快照全 kind 渲染）
- [ ] 1.2 新增 `SidebarStatusDot`（`StatusDot` 别名收口 online/connecting/offline/idle）+ `SidebarCountBadge`（tabular-nums 灰底计数），替换散落的 `topbar-tab-dot`/`server-tree-badge`/`badge badge-muted` 样式定义（目标：同上 + `frontend/src/styles/`，验证：`npx tsc -b`）
- [ ] 1.3 新增 `ModuleSidebarSection`（透传 `VerticalSplitSidebarSection`，actions 槽位只收 `WorkbenchActionButton(icon)` + `SidebarCountBadge`）+ `SidebarRowActions`（hover 显隐 22px 幽灵容器）（目标：同上，验证：Storybook/手动挂载数据库段头对比无回归）
- [ ] 1.4 新增 `ModuleSidebarTreeToolbar`（新建/刷新/一键展开/一键折叠，顺序固定，无能力者置灰；折叠 path 复用 `SchemaBrowser.tsx:192` 双上箭头，展开为其垂直翻转）+ `usePersistedTreeExpanded(storageKey, { scope })`（收敛 `usePersistedSshTreeExpanded` / `usePersistedDockerTreeExpanded` / 终端 localStorage map / `dbSchemaTreeExpandedStore` / `knowledgeStore.expandedIds` 五处同逻辑）+ 右键段落模板（扩展 `buildSidebarTreeContextMenuItems` 为 打开→新建→标签→重命名/复制→删除）（目标：`frontend/src/components/ui/module-sidebar/`，验证：vitest 覆盖 toolbar 渲染顺序 + hook 三方法）
- [ ] 1.5 旧路径 `frontend/src/components/ui/VerticalSplitSidebar.tsx` 标 `@deprecated` 并改全部 import 到 `components/ui/sidebar/VerticalSplitSidebar`（目标：`frontend/src/modules/files/` 等 6 处，验证：`rg "from \"@/components/ui/VerticalSplitSidebar\""` 清零 + `npx tsc -b`）

## 2. 知识库试点（frontend/src/modules/knowledge/）

- [ ] 2.1 整树包一层 L1 段头（单分组原则：标题取模块名、计数取叶子总数，actions 放新建/折叠/展开/刷新；`knowledge-sidebar-treehead` 裸工具条删除）（目标：`KnowledgeSidebar.tsx`，验证：截图对比段头同高）
- [ ] 2.2 `KnowledgeSidebar.tsx` 删除本地 `FolderIcon/DocIcon`，换 `SidebarIcon(kind=folder/document)`，保留 `knowledge-tree-row` class 做兼容别名（验证：`rg "function FolderIcon" frontend/src/modules/knowledge` 清零 + 手动展开/选中无错位）
- [ ] 2.2 段头 `knowledge-sidebar-treehead` 的 `+`/`⇄` 文本 `Button(variant=icon size=sm)` 换 `WorkbenchActionButton(icon)`，思源徽标 `knowledge-import-badge` 换统一 tag 芯片（文案走 i18n，验证：截图对比段头同高）
- [ ] 2.3 `SidebarTreeSelectionProvider` 补 `orderedKeys`（扁平 key 数组，修 Shift 范围选），`usePersistedTreeExpanded` 替换本地展开读写（验证：Shift 选段可用 + 重启展开态不变）
- [ ] 2.4 回归：单击预览/双击常驻/右键菜单/F2/Del/Ctrl+D/拖拽三态/FTS≥2字符/标签筛选（验证：手动 checklist + `knowledgeTree` 相关 vitest 全过）

## 3. 终端试点（frontend/src/modules/terminal/）

- [ ] 3.1 整树包一层 L1"会话"段头（单分组原则；连接组保留为 L2，`ModuleSidebarSection` 只包最外层；actions 放新建会话/折叠/展开）（目标：`TerminalSessionSidebar.tsx`，验证：`tsc -b`）
- [ ] 3.2 删除本地 `FolderIcon`（13px）换 `SidebarIcon(kind=connection)`，计数用 `SidebarCountBadge`（验证：截图对比）
- [ ] 3.3 会话行 `topbar-tab-dot` 换 `SidebarStatusDot`，关闭 `×` 文本按钮进 `SidebarRowActions`，相对时间 `1d/10d` 保留但统一样式 tabular-nums（验证：`rg "topbar-tab-dot" frontend/src/modules/terminal` 侧栏清零）
- [ ] 3.4 右键单组展开/折叠保留并补全局一键折叠/展开（toolbar），`orderedKeys` 补齐 + `usePersistedTreeExpanded` 替换本地 localStorage 读写（key 名不变，避免丢用户现状）（验证：Shift 选段 + 重启展开态不变）
- [ ] 3.5 回归：pointer 排序不断（`skipNextToggleRef` 保留）、AI 重命名 spinner 不丢、连接右键菜单（新建/展开/折叠/标签/结束全部）可用（验证：手动 + terminal 相关 vitest）

## 4. SSH 试点（frontend/src/modules/server/ssh/ + components/workspace/HostListPanel.tsx）

- [ ] 4.1 连接行 `host.svg` + `BrandIconImg` 换 `SidebarIcon(kind=host)`（品牌差异保留文字标签+1px 色条），`badge badge-muted` 计数换 `SidebarCountBadge`（验证：长主机名截断+状态点对齐无回归）
- [ ] 4.2 三段头（连接/隧道/密钥）的 download/box/plus/refresh 图标按钮换 `WorkbenchActionButton(icon)` 并补一键折叠/展开（toolbar，无能力者置灰），计数对齐终端样式（目标：`SshHostSidebar.tsx` + `HostListPanel.tsx` header meta，验证：截图对比）
- [ ] 4.3 `orderedKeys` 补齐（`collectAllSshSidebarTreeKeys` 已有，直接传入）+ `usePersistedTreeExpanded` 替换 `usePersistedSshTreeExpanded`（storageKey 不变）（验证：Shift 选段 + 重启展开态不变）
- [ ] 4.4 回归：`ssh:host:<id>` key 与 `data-connection-id` 不变（终端快速跳转依赖）、隧道/密钥 keepMounted 上报不断、OpenSSH 导入对话框正常（验证：手动 + ssh 相关 vitest）

## 5. 其余模块收敛（不动树逻辑）

- [ ] 5.1 数据库（`frontend/src/modules/database/schema/`）：段头 toolbar 换 `ModuleSidebarTreeToolbar`（已有折叠按钮对齐顺序），`SchemaBrowser` 行图标对齐新规范，查询/同步段头 actions 对齐（验证：`tsc -b` + schema vitest）
- [ ] 5.2 Docker（`frontend/src/modules/docker/DockerPanelTreeSidebar.tsx`）：`DockerTreeIcon` 尺寸锁 14px，连接状态换 `SidebarStatusDot`，`usePersistedDockerTreeExpanded` 换统一 Hook（key 不变），`orderedKeys={allTreeKeys}` 已有则保留（验证：docker vitest）
- [ ] 5.3 文件（`frontend/src/modules/files/FilesSidebar.tsx`）：`ConnProtocolIcon` 尺寸对齐 14px，段头 actions 换幽灵按钮（保留 `useTreeClickDelay` 不动，验证：files vitest）
- [ ] 5.4 服务器面板（`frontend/src/modules/server/panel/ServerPanelTreeSidebar.tsx`）：`ServerTreeIcon` + 发现导入流程回归（验证：手动发现导入一次）

## 6. 文档与总体验收

- [ ] 6.1 CLAUDE.md「Workbench UI」追加"左侧栏三层标准"小节（L0/L1/L2 + 单分组原则 + 图标/状态/badge + 单击预览双击常驻一句话规约，不复述全文）（验证：`rg "左侧栏三层" CLAUDE.md` 命中）
- [ ] 6.2 全量验证：`cd frontend && npx tsc -b` 零 error + `npx vitest run frontend/src/components/ui/sidebar-tree frontend/src/components/ui/sidebar` 全过 + 三模块手动回归表（预览/常驻/右键/F2/Del/拖拽/搜索/折叠持久化/标签筛选/一键折叠展开/Shift选段）逐项打勾
- [ ] 6.3 单分组审计：`rg "SidebarTreeRoot" frontend/src/modules` 逐个确认每个裸树已有 L1 段头包裹，无遗漏（验证：裸树直挂清零）
