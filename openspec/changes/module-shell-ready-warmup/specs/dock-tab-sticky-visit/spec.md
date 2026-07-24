## ADDED Requirements

### Requirement: 未访问 Tab 不挂载业务内容

对于使用模块 Dock（`ModuleSegmentDock` / 等价 `DockableWorkspace`）的叠层模块，系统 SHALL 在 Tab 首次激活之前不挂载该 Tab 的重型业务内容（如 Monaco 编辑器、数据网格、xterm 视图）。Dock 布局结构（tab 条、序列化 layout）仍可恢复。

#### Scenario: 预热或首挂仅准备激活 Tab

- **WHEN** 某模块 Overlay 首次挂载或处于 ShellReady 且变为 live
- **THEN** 系统 SHALL 挂载当前激活 Tab 的业务内容
- **AND** 其余未访问 Tab 的业务内容 MUST NOT 被创建

#### Scenario: 点击未访问 Tab 时再挂载

- **WHEN** 用户首次激活一个此前未访问的 Tab
- **THEN** 系统 SHALL 在该次激活时挂载其业务内容
- **AND** 将该 Tab 标记为已访问

### Requirement: 访问后粘住（sticky-visited）

系统 SHALL 将用户已激活过的 Tab 标记为已访问；在同一模块 Dock 会话内，已访问 Tab 切走后再切回时 MUST NOT 卸载并重建其业务内容（避免闪烁；终端 MUST NOT 因此销毁已创建的 xterm）。

#### Scenario: 已访问 Tab 切回不闪

- **GIVEN** 用户已打开过数据库模块中的 Tab A 与 Tab B
- **WHEN** 用户从 Tab B 切回 Tab A
- **THEN** Tab A 的业务内容 MUST 仍保持已挂载状态
- **AND** 用户可见切换 MUST NOT 出现整页重载式闪白

#### Scenario: 终端已访问 session 保活

- **GIVEN** 终端模块中某 session Tab 已创建 xterm 且被标记为已访问
- **WHEN** 用户切换到另一 session Tab 后再切回
- **THEN** 该 session 的 xterm 实例 MUST 保持可用（不因 Tab 隐藏而被销毁）

### Requirement: 禁止预热路径粗粒度全量 always

终端与数据库模块 MUST NOT 在 Overlay 一挂载时即以「所有 Tab 常驻渲染业务内容」的方式灌满未访问 Tab。防闪诉求 MUST 通过 sticky-visited（或等价「仅已访问常驻」）满足，而非预热阶段全局 always 灌内容。

#### Scenario: 数据库壳预热不创建全部 SQL 面

- **WHEN** 数据库模块因空闲预热达到 ShellReady，且存在多个已持久化的工作区 Tab
- **THEN** 未激活且未访问的 Tab MUST NOT 创建其 SQL 编辑器/结果面实例

#### Scenario: 终端壳预热不创建全部 session 视图

- **WHEN** 终端模块因空闲预热达到 ShellReady，且存在多个 session Tab
- **THEN** 系统 MUST NOT 为全部 session Tab 创建 xterm
- **AND** 仅在模块 live 且 Tab 激活（或已 sticky 访问）时按既有门闩创建

### Requirement: 非 live 时挂起 Dock 内容

当模块 `moduleLive` 为 false（路由未激活或 suspended）时，系统 SHALL 挂起 Dock 内重型业务内容的创建与订阅，即使 Overlay 壳已挂载。轻量 chrome（标题、Tab 标签）可以保留。

#### Scenario: 非 live 不挂重内容

- **GIVEN** 某叠层模块 Overlay 已挂载但模块非 live
- **WHEN** Dock 恢复布局并渲染 Tab 宿主
- **THEN** 系统 MUST NOT 为未满足 live+激活/已访问条件的 Tab 启动重型业务订阅或编辑器实例
