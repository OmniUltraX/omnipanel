## ADDED Requirements

### Requirement: 沙箱桥白名单与权限闸

L3 iframe（`sandbox="allow-scripts"` 无 `same-origin`，srcdoc CSP `default-src 'none'`）与宿主的 postMessage 协议 SHALL 为 `{__omni:true, nonce, type:request, method, args}` ↔ `{__omni:true, nonce, type:response|error}`；`method` SHALL 仅允许 `selection.get/invoke/netFetch/overlay.hide` 四种，每条 SHALL 校验 `pluginId+nonce` 并过 manifest 权限闸（`invoke` 再走后端 `plugin_invoke` 二次闸）。越权 SHALL 拒绝并记 `action=plugin.bridge.blocked`。

#### Scenario: 合法桥调用往返

- **WHEN** L3 页面调用 `host.selectionGet()`
- **THEN** 宿主校验通过后返回选区，nonce 一一对应

#### Scenario: 越权桥消息被拒并审计

- **WHEN** 插件调用白名单外方法或缺权方法
- **THEN** 返回 error，记 `plugin.bridge.blocked` 审计，前端控制台可观测

### Requirement: Overlay 自定义渲染

当 active 插件声明 `overlays[].entry=ui/index.html` 时，`PluginOverlayHost` SHALL 经 `plugin_read_asset`（html/htm 白名单）加载并以 `PluginSandboxFrame` 渲染，宿主壳（标题/关闭/尺寸）不变。

#### Scenario: L3 样板显示自身 UI

- **WHEN** 用户经选区总线打开 L3 翻译样板 Overlay
- **THEN** Overlay 显示插件自身 HTML，而非宿主占位
