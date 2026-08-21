## ADDED Requirements

### Requirement: SDK 包

系统 SHALL 提供 TypeScript 包 `@omnipanel/plugin`（清单类型、Host API、生命周期）与 `@omnipanel/plugin-ui`（稳定 UI 再导出）。第一方插件 MUST 依赖这些包，MUST NOT import `frontend/src/modules/*` 作为 SDK。

#### Scenario: 插件使用稳定按钮

- **WHEN** 第一方插件渲染连接表单或向导
- **THEN** 其 MUST 从 `@omnipanel/plugin-ui` 引用按钮与输入框
- **AND** 外观 MUST 跟随宿主 `tokens.css` 合同变量

### Requirement: 官方样板进仓库

系统 SHALL 在仓库 `plugins/` 中包含至少：`theme-default`、一个 engine 样板（Qdrant 迁入）、`panel-1panel` 或等价面板样板、`cloud-aliyun`、`importer-warpgate`、`addon-everything`。CI MUST 编译这些样板并校验清单 schema。

#### Scenario: Warpgate 样板可构建

- **WHEN** 执行工作区构建或针对插件的 CI 校验
- **THEN** `plugins/importer-warpgate` MUST 通过类型检查与清单校验
- **AND** 其 kind MUST 为 `importer`

#### Scenario: Everything 样板可构建

- **WHEN** 执行工作区构建或针对插件的 CI 校验
- **THEN** `plugins/addon-everything` MUST 通过清单校验
- **AND** 其 kind MUST 为 `addon`
- **AND** 清单 MUST 声明 `platforms` 含 `windows`

### Requirement: Host API 类型化

系统 SHALL 为插件提供版本化 Host API 类型（connections、vault、importers.showPreview、discovery、ui.toast/overlay、commands、ai.registerTools）。前端宿主实现 MUST 与该类型对齐。插件后端第一方逻辑若经网关调用，MUST 使用 specta 注册的 `plugin_list` / `plugin_set_enabled` 等命令，禁止手写 invoke 字符串。

#### Scenario: 列表插件走 bindings

- **WHEN** 设置页加载已安装插件
- **THEN** 前端 MUST 调用生成的 `commands.pluginList`（或等价 specta 名）
- **AND** 返回项 MUST 含 id、kind、enabled、权限摘要
