## ADDED Requirements

### Requirement: 单分组强制套 L1 段头

系统 SHALL 要求每个模块的左侧栏至少包含一个 L1 分段（`ModuleSidebarSection`，含折叠箭头、标题、计数徽标、操作区）；只有一个逻辑分组的模块（知识库整棵树、终端会话树）SHALL 将整树包入一个 L1 段头，不得以裸 `SidebarTreeRoot` 或自绘工具条直挂。L2 树内分组（终端连接组、Docker 连接节点、SSH config 分组）SHALL 保留为树内层级，不得与 L1 混淆。

#### Scenario: 单分组模块有段头

- **WHEN** 用户打开知识库或终端左侧栏
- **THEN** 树上方有一行标准 L1 段头（标题 + 叶子总数 + 新建/折叠/展开/刷新操作，可折叠），而非裸工具条

#### Scenario: 新模块默认有段头

- **WHEN** 开发者新建带左侧栏的模块且只有一个分组
- **THEN** 其侧栏仍包含一个 L1 段头（标题取模块名或分组名），评审时裸树直挂视为不合规

### Requirement: 段头树工具条

每棵树所在 L1 段头的 actions 区 SHALL 按固定顺序提供：计数徽标（紧跟标题）→ 新建（`+`，无新建能力的树不渲染）→ 刷新 → 展开/折叠（二选一，见下）；按钮 SHALL 为 22px 幽灵图标按钮；刷新无对应能力时 SHALL 置灰而非缺失（保证各模块段头按钮位对齐）；折叠/展开 SHALL 只作用于本段树节点，不折叠 L1 分段本身。

展开与折叠 SHALL 不同时显示：只要还有已展开节点就只显示折叠，全收起（或空树）才显示展开。

#### Scenario: 一键折叠与切换显示

- **WHEN** 用户点击数据库段头的折叠按钮
- **THEN** 本段树所有节点收起，段头按钮由折叠切换为展开；点击展开后恢复为折叠，两者永不同时出现

#### Scenario: 按钮位对齐

- **WHEN** 用户对比知识库段头（无全局刷新能力）与 Docker 段头
- **THEN** 两段头的展开/折叠按钮横向位置一致（知识库刷新位为置灰态，而非缺位导致错位）

### Requirement: 行内刷新语义

行内刷新按钮 SHALL 使用统一语义：12px 刷新图标、刷新中旋转（busy）、点击阻止冒泡（不触发选中）、禁用态与 busy 二选一；`SidebarTreeNode` 的 `onRefresh` 槽位 SHALL 为行内刷新的唯一标准位。

#### Scenario: 行刷新不抢选中

- **WHEN** 用户点击 Docker 容器分类行的刷新按钮
- **THEN** 仅触发该分类刷新（按钮转圈），树选中态与右侧面板不变

### Requirement: 展开持久化同一 Hook

所有树 SHALL 通过 `usePersistedTreeExpanded(storageKey, { scope })` 管理展开态（scope：local | team | store），对外暴露 `isExpanded/toggle/ensureExpanded`；各模块 SHALL 只传 storageKey 与默认展开规则（终端连接组默认展开，其余默认折叠的现状不变），不得自写读写 localStorage 的展开实现。

#### Scenario: 重启恢复展开态

- **WHEN** 用户展开 SSH 某分组与 Docker 某连接后重启应用
- **THEN** 两处展开态均恢复；切换团队作用域时 SSH 展开态按作用域隔离

### Requirement: 右键段落模板

树节点右键菜单 SHALL 按固定段落排序：打开（预览/常驻）→ 新建类 → 标签 → 重命名/复制 → 删除（danger 段）；各模块 SHALL 通过 extraItems 填充自有项（终端"移到工作区"、知识库"向量化/分享"、SSH"跳转终端/SFTP"），不得自排分隔线顺序。

#### Scenario: 菜单顺序一致

- **WHEN** 用户分别右键终端会话、知识库文档、SSH 主机
- **THEN** 三处菜单的"重命名/删除"永远在末段，删除项为红色 danger 样式，分隔线位置一致

### Requirement: 多选统一传 orderedKeys

所有 `SidebarTreeSelectionProvider` SHALL 传入 `orderedKeys`（虚拟树传扁平 key 数组，普通树传 `collectAll*SidebarTreeKeys` 返回值）；批量删除 SHALL 走 `resolveSidebarTreeDeleteTargets` + 一次确认。

#### Scenario: Shift 范围选可用

- **WHEN** 用户在终端/知识库/SSH 树中单击一行后 Shift+单击另一行
- **THEN** 两行之间的连续节点全部进入选区，右键删除一次确认后批量删除

### Requirement: 置顶与排序规范（二期）

叶子节点>50 的树 SHALL 使用行内置顶图钉（数据库语义），连接类树 SHALL 使用收藏段（文件语义），不得发明第三种置顶；跨父移动 SHALL 用 HTML5 DnD，同级排序 SHALL 用 pointer 拖拽，提示样式统一 `drop-before/inside/after`。本期只定规范，迁移为二期工作。

#### Scenario: 规范可引用

- **WHEN** 开发者为新模块选择置顶方案
- **THEN** 可依据本条直接选定（叶子多→图钉，连接类→收藏），无需重新评审
