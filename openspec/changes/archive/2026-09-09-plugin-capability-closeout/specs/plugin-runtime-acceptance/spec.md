## ADDED Requirements

### Requirement: L3 Overlay 真机可用

声明 `overlays[].entry` HTML 的已启用插件 SHALL 在 Overlay 中渲染自身 UI（经 `plugin_read_asset` + 现有沙箱帧）。越权桥消息 MUST 拒绝并落 audit。

#### Scenario: 样板浮层显示自身页

- **WHEN** 启用 L3 overlay 样板并触发 Overlay
- **THEN** 浮层内可见插件自己的 HTML，而非空白宿主壳

### Requirement: prod 联网二次确认

`env_tag=prod` 时 L2 `net/fetch` 与 L3 `plugin_sandbox_net_fetch` SHALL 走同一确认器；用户取消或超时 MUST 不发网，并记 `plugin.permission/blocked`。

#### Scenario: 取消不发网

- **WHEN** 生产标签连接目标上插件请求联网且用户取消
- **THEN** 请求不发出且 audit 可查拒绝

### Requirement: 官方目录与包验签分层

官方 HTTPS registry 无签名 SHALL 允许读取；有签名则 MUST 验官方公钥。`.omni-plugin` 在 release 构建 MUST 拒绝未签名包。

#### Scenario: 未签目录可浏览

- **WHEN** 官方源返回未签名 registry JSON
- **THEN** 市场列表仍可展示（包安装仍走包验签）
