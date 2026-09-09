## ADDED Requirements

### Requirement: SDK npm 发版与版本策略

`@omnipanel/plugin-sdk` SHALL 可构建、可 `npm publish`（流程文档化进 `docs/plugins/sdk-release.md`）；版本号与 `HOST_API_VERSION` 对齐记录；`minHostApi` 即兼容闸。

#### Scenario: 外部引用编译

- **WHEN** 外部工程按文档引用已发版 SDK
- **THEN** `definePlugin` 等类型可编译通过

### Requirement: HOST_API 演进规则

`HOST_API_VERSION` SHALL 只增不改既有语义；破坏性变更 SHALL 递增并附迁移说明。

#### Scenario: 老插件在新宿主可用

- **WHEN** 宿主升级且 HOST_API 递增但保持加法兼容
- **THEN** 低 minHostApi 插件无需改动直接装载
