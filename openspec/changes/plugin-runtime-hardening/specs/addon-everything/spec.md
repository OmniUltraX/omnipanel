## ADDED Requirements

### Requirement: 启动器 Everything 查询防抖与竞态安全

快捷启动器 `es` 前缀的查询 SHALL 做输入防抖（约 250ms）后再发起 `plugin_invoke` 调用；对在途请求 MUST 做竞态丢弃——仅最后一次查询的结果允许渲染。插件未启用时 MUST NOT 发起任何调用。

#### Scenario: 连续按键只发一次

- **WHEN** 用户在 250ms 内连续输入 `es chrome`
- **THEN** 实际发出的 `plugin_invoke` 查询不超过防抖窗口结束后的那一次
- **AND** 渲染结果来自最后一次输入

#### Scenario: 慢查询不回写旧结果

- **WHEN** 前一查询仍在途而新查询已发出
- **THEN** 先返回的旧结果 MUST 被丢弃
- **AND** 结果区只呈现当前 filter 对应的结果

### Requirement: Everything 错误提示去重

当 Everything 未运行或不支持当前平台时，启动器 SHALL 在同一启动器会话内只提示一次可理解错误（toast 或行内提示），后续查询静默置空结果区；错误恢复（Everything 启动）后下一次成功查询 MUST 正常展示结果。其他查询类错误（非 NotRunning/UnsupportedPlatform）不受此去重约束。

#### Scenario: 未运行时不刷屏

- **WHEN** Everything 未运行且用户连续多次输入 `es` 查询
- **THEN** 仅出现一次「未检测到 Everything」提示
- **AND** 后续查询不再弹 toast，结果区为空

#### Scenario: 恢复后自动可用

- **WHEN** 用户随后启动了 Everything 并再次查询
- **THEN** 查询正常返回结果
- **AND** 无需重启应用或启动器
