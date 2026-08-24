## ADDED Requirements

### Requirement: 贡献点单源

系统 SHALL 以后端 Registry 的 manifest 为贡献点唯一事实源。前端 MUST 经 IPC 获取清单（`plugin_manifests`）并缓存于统一 Catalog；宿主各消费方 MUST 从 Catalog 泛化读取，MUST NOT 直接 import `plugins/*` 源码，MUST NOT 为单个插件 ID 维护手写消费数组或特判分支。

#### Scenario: 清单变更驱动 UI

- **WHEN** 某插件 manifest 声明的 panelTabs / 云产品 Tab 发生变化
- **THEN** 宿主对应界面 MUST 随之变化
- **AND** 前端 MUST NOT 需要修改任何消费方代码

#### Scenario: 禁用即消失

- **WHEN** 插件被禁用
- **THEN** 其全部贡献点（侧栏/Tab/表单/启动器前缀/菜单/AI 工具/导入入口/probe）MUST 从宿主消失
- **AND** 该插件写入的连接与标签数据 MUST 保留

### Requirement: 启动器 provider 注册表

快捷启动前缀 SHALL 由 provider 注册表提供：内核仅登记 `ssh` / `db`；其余前缀由 activated 插件的 `contributes.launcher` 或其 activate 登记产生。前缀列表 MUST 随插件启用状态实时增减。

#### Scenario: 插件前缀随开关增减

- **WHEN** 声明 launcher 前缀的 addon 被禁用再启用
- **THEN** 该前缀 MUST 先从可用前缀中移除、后恢复
- **AND** 内核 ssh/db 前缀 MUST 不受影响

### Requirement: 导入入口注册

导入器入口（命令面板/设置向导）SHALL 从 manifest `contributes.importers[].entry` 泛化渲染；禁用对应 importer 插件后入口 MUST 消失。

#### Scenario: Warpgate 入口受控于清单

- **WHEN** importer-warpgate 插件被禁用
- **THEN** 命令面板 MUST 不再出现 Warpgate 导入项
- **AND** 已导入的连接数据 MUST 保留

### Requirement: 发现 probe 归属声明

发现总线 probe SHALL 支持插件归属声明：内核保留 `ssh-docker` / `ssh-panel` 基础 probe，面板/module 插件经 `contributes.discovery` 追加。prod 主机过滤、任务取消联动行为 MUST 不因泛化回退。

#### Scenario: prod 过滤不回退

- **WHEN** 发现任务包含 env_tag=prod 主机且 scope 过滤生效
- **THEN** 系统 MUST NOT 对 prod 主机发起任何探测请求
