## ADDED Requirements

### Requirement: Function 沙箱形状校验

第三方 `ui/main.js` SHALL 继续经受限 `Function` 求值。返回值 MUST 为 `{activate, deactivate}`，否则 MUST 标记 `unsupported_reason` 且 MUST NOT 崩溃宿主。单文件 MUST 遵守现有体积上限。

#### Scenario: 非法入口隔离

- **WHEN** `ui/main.js` 不返回 activate/deactivate
- **THEN** 该插件 UI 不注册，其它插件不受影响

### Requirement: 不升级装载模型

系统 MUST NOT 改为 blob 动态 `import()` 或通用 iframe 应用框架（Overlay iframe 除外，已存在）。

#### Scenario: 文档写清边界

- **WHEN** 开发者阅读 `docs/plugins/README.md` 中 UI 入口说明
- **THEN** 能看到 Function 沙箱限制与 Overlay iframe 的区别
