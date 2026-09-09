## ADDED Requirements

### Requirement: 更新区与一键全更

插件中心 SHALL 有更新区（可更新数 badge、逐项 changelog、单项更新、一键全更）；单包失败 SHALL 回滚且不影响其它包；更新检查默认开启、可关，复用静默刷新节流。

#### Scenario: 一键全更部分失败

- **WHEN** 三个更新中一个失败
- **THEN** 失败项回滚，其余成功，UI 分别提示

### Requirement: 源管理与依赖确认 UI

源管理对话框 SHALL 支持增/删/禁用/测连通；依赖安装前 SHALL 展示计划（含版本与来源）并经确认；文案走 i18n，按钮用 `WorkbenchPanelHeader/WorkbenchActionButton`。

#### Scenario: 依赖计划确认

- **WHEN** 安装带依赖插件
- **THEN** 先展示"将同时安装 A x.y.z、B x.y.z"，确认后执行
