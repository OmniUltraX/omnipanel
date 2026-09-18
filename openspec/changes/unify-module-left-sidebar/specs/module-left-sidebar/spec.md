## ADDED Requirements

### Requirement: 三层结构组装顺序

系统 SHALL 要求所有模块左侧栏按 L0 模块顶栏 → L1 分段 → L2 树行的顺序组装：L0 使用 `ModuleLeftColumn`（标题 + 标签筛选 + 操作区），L1 使用 `ModuleSidebarSection`（箭头 + 标题 + 计数 + 操作），L2 使用 `SidebarTreeNode`，`ScopedSearch` 包在 L1 外层。

#### Scenario: 新模块照抄组装

- **WHEN** 开发者新建一个带左侧栏的模块
- **THEN** 其左侧栏从外到内依次为 `ModuleWorkspaceLayout` / `ModuleLeftColumn` / `ScopedSearch` / `ModuleSidebarSection` / `SidebarTreeNode`，且无自绘段头容器（如 `*-treehead`）与裸文本 `+`/`×` 按钮

#### Scenario: 存量裸段头迁移

- **WHEN** 打开知识库或终端左侧栏
- **THEN** 连接组/操作区呈现为标准 L1 段头（含折叠箭头、标题、计数徽标、幽灵操作按钮），而非裸工具条

### Requirement: 段头行为一致

`ModuleSidebarSection` SHALL 支持展开/折叠状态持久化（localStorage 按模块独立 key）、次要段自动高度（autoSize + 高度持久化 + 拖拽手柄），最后一个展开的 autoSize 段撑满剩余空间；段头操作 SHALL 使用 `WorkbenchActionButton`，计数 SHALL 使用 `SidebarCountBadge` 单一样式。

#### Scenario: 折叠状态持久化

- **WHEN** 用户折叠 SSH「隧道」段后重启应用
- **THEN** 「隧道」段保持折叠，且其子树 keepMounted 以便继续上报操作按钮

#### Scenario: 段头操作外观

- **WHEN** 用户查看任意模块段头的新建/刷新/导入按钮
- **THEN** 按钮为 22px 幽灵按钮（悬停白底细描边），无实心蓝底与浅红块，无 `size` prop 定制

### Requirement: 树行槽位与视觉

树行 SHALL 使用 `SidebarTreeNode` 并按固定槽位填充：arrow（10px `›`，叶子为圆点）→ icon（14px `SidebarIcon`）→ prefix（状态点，仅连接/会话类行）→ label → afterLabel（徽标/tag）→ trailing（meta + hover 操作）；缩进 SHALL 为 step 16px / base 8px；选中态与工作区打开态（active）SHALL 同时支持且视觉可区分。

#### Scenario: 行槽位顺序

- **WHEN** 用户查看 SSH 连接行、终端会话行、知识库文档行
- **THEN** 每行的图标尺寸一致（14px）、状态点位于标签左侧、计数/时间等 meta 位于标签右侧、hover 操作（新建/关闭/刷新）仅在悬停时出现

#### Scenario: 选中与打开区分

- **WHEN** 用户单击某行（选中+预览）后再双击（常驻打开）
- **THEN** 单击行高亮为选中态，双击后行同时呈现工作区打开态，两者样式可区分且互不覆盖

### Requirement: 点击与键盘语义

系统 SHALL 统一：单击 = 选中 + 打开预览 Tab（文件夹/连接组只选中不打开）；双击 = 打开常驻 Tab（文件夹同时展开）；右键 = 上下文菜单；F2 重命名、Del 删除（多选走 `resolveSidebarTreeDeleteTargets`）、Ctrl+D 复制（支持的模块）；修饰键单击（Ctrl/Shift）SHALL 只改选区不抢开预览。

#### Scenario: 修饰键多选不抢焦点

- **WHEN** 用户按住 Ctrl 连续单击三行
- **THEN** 三行进入选区，右侧工作区不切换预览，右键删除可批量删除三行并一次确认

#### Scenario: 文件夹单击与双击

- **WHEN** 用户单击文件夹/连接组
- **THEN** 仅选中不断开右侧内容；双击后展开并打开该组概览

### Requirement: 搜索与筛选

`ScopedSearch` SHALL 包裹 L1 分段；输入 ≥2 字符时进入全文检索视图（可复用模块 FTS），否则为本地树过滤并自动展开命中祖先；全局标签筛选（`useModuleTagFilter`）SHALL 作用于树数据源（文件夹/分组不过滤，只过滤叶子），搜索框占位文案走 i18n `*.searchPlaceholder`。

#### Scenario: 搜索自动展开

- **WHEN** 用户在服务器面板搜索框输入面板类型名
- **THEN** 命中的服务器自动展开并只显示命中分类，无命中显示统一空态

#### Scenario: 标签与搜索叠加

- **WHEN** 用户同时启用标签筛选与搜索输入
- **THEN** 树先按标签过滤再按搜索过滤，两者为空时均回落完整树

### Requirement: 拖拽视觉与约束

拖拽 SHALL 提供 before/inside/after 三态提示线；拖拽镜像锁定条目（如知识库思源镜像）或落点位于镜像子树内时 SHALL 拒绝并 toast 提示；连接组同级排序可用 pointer 拖拽，但提示样式 SHALL 与 HTML5 DnD 一致。

#### Scenario: 镜像拖拽拒绝

- **WHEN** 用户把思源镜像文档拖入自建文件夹
- **THEN** 系统拒绝移动并提示"镜像内容下次同步会还原"，树结构不变

### Requirement: 空态与无结果

空树、搜索无结果、标签过滤全空 SHALL 使用统一空态组件（`SidebarTreeEmpty`）与 i18n 文案（`*.empty` / `*.noResults`），不得自绘裸 `div` 空提示。

#### Scenario: 空态展示

- **WHEN** 终端无会话或数据库无连接
- **THEN** 段体内显示统一空态文案，而非空白段
