## ADDED Requirements

### Requirement: Host 分类

系统 SHALL 将扩展点分为领域工作台 Host 与横切总线 Host。领域工作台包括 Database、Panel（Server）、Cloud、Module Shell、Files、Protocol、Importer 预览壳。横切总线包括连接台（Vault/标签/externalSource）、发现、菜单/命令/选区/Overlay、Quick Launcher、Theme、OmniMCP、工作区组件。

#### Scenario: 翻译不是独立 Host

- **WHEN** 需要全局右键翻译选中文本
- **THEN** 系统 MUST 将其实现为 `addon` 对菜单、选区与 Overlay 总线的贡献
- **AND** MUST NOT 新增「翻译 Host」或翻译 kind

#### Scenario: 快捷启动窗是 Host

- **WHEN** 用户按下全局热键打开快捷启动
- **THEN** 窗口、排序、最近项 MUST 由内核 Quick Launcher Host 提供
- **AND** 匹配源 MUST 来自 provider 注册表而非硬编码前缀闭集

### Requirement: 公共贡献点

系统 SHALL 提供公共贡献点，任何 kind 只要清单声明即可登记（受权限约束）：`ui.sidebar`、`ui.connectionForm`、`ui.panelTabs`、`ui.commands`、`menus`、`overlays`、`launcher`、`discovery`、`importers`、`themes`、`ai.tools`、`workspace.widgets`。kind MUST NOT 独占这些插槽。

#### Scenario: module 也可贡献启动器前缀

- **WHEN** 某 `module` 插件声明 `contributes.launcher.prefix = "nacos"`
- **THEN** 快捷启动输入 `nacos` MUST 由该 provider 提供结果
- **AND** 该插件仍使用 `kind: module` 而非 `addon`

#### Scenario: 侧栏来自注册表

- **WHEN** 渲染主侧栏导航
- **THEN** 可见项 MUST 来自 `AppModule` 状态为 `open` 的注册表
- **AND** MUST NOT 仅依赖 `Sidebar.tsx` 内写死的 `navPaths` 作为唯一来源

### Requirement: Host API 禁止项

系统 SHALL 禁止插件：直接打开新的 Tauri `WebviewWindow`、直接执行任意 specta 命令、在主题包中执行 JavaScript。插件 UI MUST 使用 `@omnipanel/plugin-ui` 或 Overlay 壳。

#### Scenario: 插件不得自建轻量窗

- **WHEN** addon 需要展示翻译结果
- **THEN** 系统 MUST 在 Overlay 或快捷启动结果区展示
- **AND** MUST NOT 允许插件调用窗口构建 API 创建第二扇全局轻量窗

### Requirement: AI 工具并入 OmniMCP

系统 SHALL 将插件声明的 AI 工具并入现有 OmniMCP / builtin 工具开关与模块过滤。系统 MUST NOT 为插件另建一套工具协议。

#### Scenario: 引擎工具可开关

- **WHEN** 某 engine 插件贡献 `omni_database_*` 同类工具
- **THEN** 设置中的内置工具开关 MUST 能隐藏或关闭它们
- **AND** 模块 closed 时 MUST 不注入到模型

### Requirement: 插件 Native 工具登记

系统 SHALL 允许第一方插件在 activate 时向 `ToolRegistry` 登记 `exec_kind=Native` 的工具（含 name、input_schema、plugin_id）。执行 MUST 按 `plugin_id` 分发，MUST NOT 依赖在 `ai_chat.rs` 为每个插件工具写死 match。插件禁用后 MUST 从模型可调用清单中移除。插件登记工具的 `external_exposed` MUST 默认为 false。

#### Scenario: 禁用 Everything 后模型看不到工具

- **WHEN** 用户禁用 `omni.addon.everything`
- **THEN** 随后一轮 AI 装配 MUST NOT 再注入 `omni_everything_search`
- **AND** 快捷启动 `es` 前缀 MUST 不再由该 provider 提供结果
