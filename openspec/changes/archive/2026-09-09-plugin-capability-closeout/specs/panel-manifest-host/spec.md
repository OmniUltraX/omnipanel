## ADDED Requirements

### Requirement: 未知页签走通用壳

面板 Host SHALL 继续渲染第一方已知 `panelTabs` id 的现有页面。清单中**未在第一方登记**的 tab id SHALL 用通用表单壳渲染（`formFields` + `plugin_invoke`），MUST NOT 要求为该插件写死 React 页。

#### Scenario: 样板自定义 tab

- **WHEN** 安装并启用 `panel-starter`（或同等第三方 panel），其 tab id 不是 overview/websites/apps/certificates/cronjobs/databases
- **THEN** 服务器面板出现该页签且能完成一次 invoke 回显

### Requirement: 禁止样板 ID 特判

Host MUST NOT 以样板或第三方插件 id 分支渲染。

#### Scenario: 换 id 仍可用

- **WHEN** 将样板 id 改为另一合法反向域名并安装
- **THEN** 页签仍出现且行为相同
