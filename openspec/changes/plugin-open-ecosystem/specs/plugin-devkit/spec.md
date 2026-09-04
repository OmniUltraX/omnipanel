## ADDED Requirements

### Requirement: SDK 可构建可引用

`@omnipanel/plugin-sdk` SHALL 可构建（`tsc` + `package.json exports` 含 `definePlugin/PluginHost/PluginModule` 与 manifest zod schema），外部工程按 README 引用类型 SHALL 可编译；`@omnipanel/plugin-ui` SHALL 仅导出通用组件（Button/TextInput/FormDialog/ModuleEmptyState/ImportPreview），禁止引用 `frontend/src/modules/*`。

#### Scenario: 外部引用编译

- **WHEN** 外部工程 `import { definePlugin } from "@omnipanel/plugin-sdk"`
- **THEN** `tsc` 通过

### Requirement: 脚手架全模板

`scripts/create-plugin.mjs` SHALL 支持 `engine/module/cloud/panel/importer/addon-theme/js-logic/wasm-stub/l3-overlay` 模板，产出到 `plugins-custom/`（gitignore），生成物 SHALL 通过 `validate-plugin` 与 dev 打包验签。

#### Scenario: 从零生成 L1 包

- **WHEN** 运行脚手架生成 engine 模板并打包
- **THEN** dev 验签通过，可走安装链路装载

### Requirement: 开发者文档

`docs/plugins/` SHALL 含清单参考、权限模型、三级梯度、调试指南四篇；按文档从零做出的 L1 包 SHALL 可安装启用。

#### Scenario: 照文档做出包

- **WHEN** 第三方按调试指南用 dev 未签名包联调
- **THEN** 可在 dev 装载，release 被拒语义明确，失败可经 `[plugin-runtime]` 日志与 audit 定位
