## ADDED Requirements

### Requirement: 第一方清单单一事实源

第一方插件的清单 SHALL 以仓库 `plugins/<dir>/plugin.json` 为唯一权威来源。Rust 侧 Plugin Registry MUST 在构建期从同一批 JSON 文件解析清单（编译期嵌入），MUST NOT 维护手写副本；前端继续经 `plugins/*/src/index.ts` 解析同一 JSON。任何清单字段（id、version、kind、permissions、platforms、contributes）在双端 MUST 一致。

#### Scenario: 修改 JSON 双端同时生效

- **WHEN** 开发者修改某 `plugins/*/plugin.json` 的 permissions 或 contributes
- **THEN** Rust 注册表与前端贡献点消费方读取到的是同一份内容
- **AND** 无需同步修改任何手写副本

#### Scenario: 漂移字段修正

- **WHEN** 清单单源化落地
- **THEN** 此前已漂移的字段（如 db-clickhouse 连接表单的 `database.optional`）以 plugin.json 为准收敛
- **AND** 连接对话框渲染行为与清单声明一致

### Requirement: CI 清单一致性门禁

`check-plugin-manifests` 脚本 SHALL 在校验 JSON schema 之外，交叉校验 Rust 注册表实际装载的插件集合（id/kind/permissions/platforms）与 `plugins/*/plugin.json` 完全一致；不一致时 CI MUST 失败。脚本内的枚举（kind/permission/platform）SHALL 与 `@omnipanel/plugin-sdk` 的 zod schema 同源或由其生成，MUST NOT 各自漂移。

#### Scenario: 手写副本回归即失败

- **WHEN** 有人重新在 Rust 中引入与 JSON 不一致的清单字段，或删除某个 JSON 但注册表仍引用
- **THEN** `npm run check:plugin-manifests` 以非零码失败并指出差异项

#### Scenario: 新增第一方插件只改一处

- **WHEN** 开发者新增一个第一方插件目录（plugin.json + src）
- **THEN** 在 Rust 注册表按目录登记后，CI 校验通过
- **AND** 不需要再在任何第二处抄写清单内容
