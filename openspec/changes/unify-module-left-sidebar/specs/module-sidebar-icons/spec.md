## ADDED Requirements

### Requirement: 图标集命名与尺寸

系统 SHALL 提供 `SidebarIcon` 统一图标集，`kind` 至少覆盖 folder / document / connection / host / container / database / key / tunnel；所有 kind SHALL 固定 14×14 / stroke 1.8，模块 SHALL NOT 自绘同语义图标（不得新增 `function FolderIcon/DocIcon` 私有实现）。

#### Scenario: 重复图标删除

- **WHEN** 全仓搜索 `function FolderIcon`
- **THEN** 仅命中 `components/ui/module-sidebar/` 一处，知识库/终端等模块私有实现已删除

#### Scenario: SSH 主机图标收敛

- **WHEN** 用户查看 SSH 连接列表（含宝塔/1Panel 面板主机）
- **THEN** 所有行图标同尺寸同对齐，面板类型差异通过文字标签与 1px 色条表达，而非大小不一的图片图标

### Requirement: 状态点语义

连接/会话/容器状态 SHALL 统一用 `SidebarStatusDot`（online / connecting / offline / idle 四态），知识库"已向量化"圆点 SHALL 收敛为 afterLabel 徽标而非第四种圆点实现。

#### Scenario: 状态一致性

- **WHEN** 同一主机在 SSH 列表、终端会话树、Docker 主机树中同时出现
- **THEN** 三处在线态颜色与形状一致（online 实心绿、connecting 脉冲黄、offline 灰）

### Requirement: 徽标与计数

来源徽标（如"思源"）、类型 tag（如面板类型）SHALL 使用统一 tag 芯片样式；数量计数 SHALL 使用 `SidebarCountBadge`（幽灵灰底、 tabular-nums），全模块同字号同圆角。

#### Scenario: 徽标可读性

- **WHEN** 知识库树同时显示思源来源徽标与向量化徽标
- **THEN** 两徽标左右排列、同高、同字号，title 悬停显示全称
