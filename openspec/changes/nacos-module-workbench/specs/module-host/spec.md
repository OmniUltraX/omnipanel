## ADDED Requirements

### Requirement: 通用模块工作台壳

系统 SHALL 为每个已激活且 `AppModule` 为 open 的 `kind=module` 插件在 `/module/{moduleKey}` 提供标准工作台：左侧 `kind=service` 实例列表、标签/环境过滤、发现入口、右侧主区。插件 MUST 通过 workbench 注册表填充主区，MUST NOT 要求 Host 按插件 id 写死布局。插件 MUST NOT 自建第二套标签或连接存储。

#### Scenario: 打开模块看到实例树

- **GIVEN** `omni.module.nacos` 已启用且模块状态为 open
- **WHEN** 用户进入 `/module/nacos`
- **THEN** Host MUST 渲染左树右主区
- **AND** 树中 MUST 只出现 `kind=service` 且 `config.pluginId` 为该插件的连接

#### Scenario: 未知 module 插件仍能用壳

- **WHEN** 另一只 `kind=module` 插件声明 `ui.moduleKey` 并启用
- **THEN** Host MUST 用同一套树与对话框渲染其实例
- **AND** MUST NOT 为该 `moduleKey` 新增 Host 分支才能列出连接

### Requirement: 声明式 service 连接

系统 SHALL 根据模块插件 `contributes.ui.connectionForm` 渲染创建/编辑对话框，保存为 `kind=service`，`config` MUST 包含 `pluginId`。凭据字段 MUST 写入 Vault 并以 `credential_ref` 关联，MUST NOT 把密码写入 config JSON。

#### Scenario: 按表单新建 Nacos 实例

- **WHEN** 用户在 Nacos 模块点击新建并填写 host/port 与密码后保存
- **THEN** 系统 MUST 写入一条 `kind=service` 连接且 `pluginId=omni.module.nacos`
- **AND** config MUST 不含密码明文
- **AND** 左树 MUST 立即出现该实例

#### Scenario: 测试连接走插件方法

- **WHEN** 用户在对话框点击测试连接
- **THEN** 系统 MUST 调用该插件 `testConnection`
- **AND** 失败时 MUST 展示插件返回的可理解错误，不得静默成功

### Requirement: 标签与环境过滤

系统 SHALL 复用现有 `TaggableKind::Connection` 与模块标签筛选。`env_tag=prod` 的实例 MUST 在树与对话框上可见生产标记。

#### Scenario: 按标签筛实例

- **WHEN** 用户为一条 Nacos service 连接打用户标签并启用该标签过滤
- **THEN** 模块树 MUST 只显示命中标签的实例

### Requirement: 插件停用卸除界面保留数据

系统 SHALL 在模块插件禁用或 AppModule 关闭后撤掉侧栏入口、工作台、该插件登记的 workbench。已写入的 `kind=service` 连接 MUST 仍可在存储中查询。

#### Scenario: 禁用后入口消失连接还在

- **WHEN** 用户在设置中禁用 `omni.module.nacos`
- **THEN** 主侧栏与 `/module/nacos` 工作台 MUST 在 2 秒内不可用
- **AND** 既有 service 连接 MUST 仍能被 `conn_*` 读出

### Requirement: 能力驱动工作台

系统 SHALL 按插件 `contributes.module.capabilities[]` 的 id 渲染树节点与 Dock 插槽。已冻结 id：`namespace`、`config`、`discovery`、`cluster`。未声明的 id MUST NOT 出现。未知 id MUST 显示空态，MUST NOT 要求改 Host 源码才能安装该包。Host MUST 用宿主组件画列表/编辑器/表格，MUST NOT 按 `moduleKey === "nacos"` 分支渲染。

#### Scenario: 只声明 config 则无服务树

- **WHEN** 已安装模块插件仅声明 `capability.id=config`
- **THEN** 实例树 MUST 有配置节点
- **AND** MUST NOT 出现服务或节点节点

#### Scenario: Host 零产品名分支

- **WHEN** 用户打开任意已启用 module 插件的实例
- **THEN** 配置列表/编辑器 MUST 来自通用 `config` 插槽
- **AND** 源码主路径 MUST NOT 出现以 nacos 为条件的工作台渲染

### Requirement: 插槽空态

未声明任何能力、或某能力 method 未实现时，右侧 MUST 显示空态，MUST NOT 崩溃。禁用或卸载插件后 MUST 卸除对应插槽。

#### Scenario: 桩包可打开

- **GIVEN** 脚手架生成的模块包已安装并启用，methods 返回空列表
- **WHEN** 用户选中新建的 service 连接
- **THEN** Host MUST 打开已声明能力的空列表
- **AND** MUST NOT 因缺少 React 插件组件而失败
