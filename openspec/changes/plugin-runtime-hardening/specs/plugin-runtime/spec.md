## ADDED Requirements

### Requirement: 插件启用状态持久化

系统 SHALL 将每个插件的 enabled 状态持久化到 `omnipanel-store`（`plugin_settings` 表，以 plugin_id 为主键）。应用启动装配 Plugin Registry 时 MUST 读回已持久化的状态并覆盖编译期默认值；`plugin_set_enabled` MUST 在修改内存 registry 的同一命令内写穿存储。未持久化过的插件 MUST 保持编译期默认（enabled）。

#### Scenario: 禁用后重启保持禁用

- **WHEN** 用户禁用某插件后重启应用
- **THEN** `plugin_list` 中该插件 `enabled=false` 且 `activated=false`
- **AND** 其 AI 工具、启动器前缀、侧栏入口均不出现

#### Scenario: 存储失败不阻断列表

- **WHEN** `plugin_settings` 读写发生 SQLite 错误
- **THEN** 命令 MUST 返回统一 `OmniError`
- **AND** 内存 registry 状态 MUST NOT 与存储产生静默分叉（写失败时内存回滚或返回错误）

### Requirement: 跨窗口插件状态同步

系统 SHALL 在 `plugin_set_enabled` 成功后向所有窗口广播插件变更事件。每个窗口的插件运行时 store MUST 订阅该事件并重新拉取 `plugin_list`；贡献点消费方（引擎注册表、面板 Tab 插槽、模块壳、快捷启动器）MUST 随 store 更新收敛，无需重启窗口。

#### Scenario: 子窗秒级收敛

- **WHEN** 用户在设置窗口禁用某 module 插件
- **THEN** 已打开的其他窗口在 2 秒内隐藏其侧栏入口与模块路由内容
- **AND** 重新启用后入口恢复，无需重启

#### Scenario: 事件载荷可追溯

- **WHEN** 插件变更事件被广播
- **THEN** payload MUST 包含 plugin_id 与变更后的 enabled/activated 摘要
- **AND** 各窗口以重新拉取 `plugin_list` 为准，不依赖 payload 做最终状态

### Requirement: 平台不支持原因错误码化

Runtime 对平台不匹配等不可激活原因 SHALL 返回稳定错误码（而非自然语言句子）；用户可见文案由前端按当前语言映射。设置页 MUST NOT 直接展示后端硬编码中文串。

#### Scenario: 非 Windows 文案随语言切换

- **WHEN** 非 Windows 平台列出声明 `platforms:["windows"]` 的插件
- **THEN** `unsupported_reason` 为稳定码（如 `platform.unsupported`）
- **AND** 设置页按 zh-CN / en-US 显示对应文案，checkbox 保持禁用
