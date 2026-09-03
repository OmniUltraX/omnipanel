## ADDED Requirements

### Requirement: 可安装包形状

`kind=module` 的可分发单元 MUST 为 `.omni-plugin`，内含 `plugin.json` 与可选 `entry.logic`（`.js` 或 `.wasm`）。主工作台 MUST NOT 依赖包内 React/主 WebView 脚本。系统 MUST 能用现有 `omnipanel-plugin-pkg` 打包、验签、安装到 `app_data/plugins/<id>/`。

#### Scenario: 打包后可安装启用

- **WHEN** 用户将符合合同的 module 目录打包并在插件中心安装、启用
- **THEN** 侧栏 MUST 出现该 `moduleKey`
- **AND** `/module/{key}` MUST 按清单能力渲染

#### Scenario: 包内无自定义 UI 也能用

- **GIVEN** 包中没有 `ui/index.html` 且没有前端源码
- **WHEN** 用户打开该模块并测试连接
- **THEN** 系统 MUST 通过 L2 `testConnection` 完成测连
- **AND** MUST NOT 要求 L3 iframe

### Requirement: 卸载与内置冲突

磁盘安装的模块包 MUST 可卸载（删目录 + 清启用）。`first_party` / 内置 id MUST 拒绝被第三方包覆盖安装。卸载或禁用后贡献点 MUST 消失，已写入的 `kind=service` 连接 MUST 保留。

#### Scenario: 卸载后入口消失连接还在

- **WHEN** 用户卸载一只磁盘安装的 module 插件
- **THEN** 侧栏与启动器/AI 贡献 MUST 消失
- **AND** 该 pluginId 的 service 连接 MUST 仍可被存储读出

#### Scenario: 内置 id 冲突拒绝安装

- **WHEN** 用户安装 id 为 `omni.module.nacos` 的第三方包而宿主已内置同 id
- **THEN** 安装 MUST 失败并提示冲突
- **AND** 内置插件状态 MUST 不变

### Requirement: 模块脚手架

系统 SHALL 提供 `node scripts/create-plugin.mjs <name> module`，在 `plugins-custom/` 生成清单（`kind=module`、`connectionForm`、至少一种 capability、methods 桩）、`logic.js` 桩与 README。生成物 MUST 能直接 pack 并安装。

#### Scenario: 空模板走通安装

- **WHEN** 开发者用脚手架生成 `foo` 模块并打包安装启用
- **THEN** 设置中 MUST 出现该插件
- **AND** 用户 MUST 能新建 service 连接并看到已声明能力的空插槽

### Requirement: L2 为实现面

模块插件的业务 methods MUST 由 L2 `call(method, argsJson)` 实现，网络 MUST 走 `host.netFetch`，秘密 MUST 走 `host.vaultGet`。缺权 MUST 失败。系统 MUST NOT 要求第三方提供 Rust crate 才能接入 module Host。

#### Scenario: 无 crate 的包可以列资源

- **WHEN** 一只仅含 `logic.js` 的模块包实现 `listConfigs` 并已启用
- **THEN** Host 配置插槽 MUST 能展示其返回的列表
- **AND** 仓库 MUST NOT 把对应原生 crate 当作该包的装载前提
