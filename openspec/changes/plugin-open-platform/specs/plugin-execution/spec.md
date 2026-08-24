## ADDED Requirements

### Requirement: 激活生命周期合同

系统 SHALL 定义插件激活合同：插件导出 `activate(ctx)`（可选 `deactivate()`），由统一 Runtime Loader 在插件 activated 时调用。第一方与第三方 MUST 走同一条加载路径；deactivate MUST 逆序卸载本次 activate 登记的全部贡献点。

#### Scenario: 启用触发 activate

- **WHEN** 插件从 disabled 切换为 enabled 且平台匹配
- **THEN** Runtime Loader MUST 调用其 `activate` 并注入 Host API 与清单
- **AND** activate 内登记的贡献点 MUST 随之出现

#### Scenario: 禁用逆序卸载

- **WHEN** 插件被禁用
- **THEN** Loader MUST 调用 `deactivate`
- **AND** 该插件登记的启动器前缀、菜单项、AI 工具、Overlay MUST 全部消失且不误删其他插件的同名登记

### Requirement: AI Native 工具泛化分发

系统 SHALL 以 manifest `contributes.ai.tools` 为 AI 工具唯一事实源：activated 插件的工具自动并入 ToolRegistry，native 执行统一经 `(plugin_id, method)` 命令网关分发。宿主代码 MUST NOT 为单个插件的工具维护 ID 特判分支。

#### Scenario: 工具随清单增减

- **WHEN** 某 activated 插件的清单声明或移除一个 ai.tools 条目
- **THEN** 模型工具清单 MUST 相应出现或消失
- **AND** 宿主命令层 MUST NOT 出现该插件 ID 的字面量分支

#### Scenario: native 执行经网关鉴权

- **WHEN** 模型调用某插件的 native 工具
- **THEN** 网关 MUST 校验该 method 白名单与所需权限后方可执行

### Requirement: 权限后端强制与审计

系统 SHALL 在后端强制权限：`plugin_invoke` MUST 先校验 method 白名单与权限注解，失败返回稳定错误码（`plugin.permission.denied` / `plugin.method.unknown`）。系统 SHALL 记录插件审计日志（时间、plugin_id、动作、method、参数摘要、结果）；摘要 MUST NOT 包含密钥或完整敏感参数。

#### Scenario: 缺权调用被拒并留痕

- **WHEN** 插件调用未授权的 host method
- **THEN** 调用 MUST 失败且错误码稳定
- **AND** audit 表 MUST 新增一条含 plugin_id 与结果的记录

#### Scenario: 参数摘要不落密钥

- **WHEN** invoke 参数包含 password/token 字段
- **THEN** audit 记录 MUST 仅存字段名与长度类摘要
- **AND** MUST NOT 存原文

### Requirement: WASM 逻辑执行

系统 SHALL 支持以 WASM（wasmtime）执行插件业务逻辑：实例生命周期跟随 activate/deactivate；宿主以 host functions 提供 Host API 子集，按权限逐次校验，缺权 MUST trap 并返回明确错误。生产环境（env_tag=prod）下网络/SSH 类 host functions MUST 强制二次确认且不可配置绕过。

#### Scenario: 缺权 trap

- **WHEN** 未声明 `net:connect` 的 wasm 插件调用 net.fetch
- **THEN** host function MUST trap
- **AND** audit MUST 记录拒绝原因

#### Scenario: prod 主机扫描确认

- **WHEN** wasm 插件对 env_tag=prod 主机发起 SSH 探测类调用
- **THEN** 系统 MUST 触发既有确认流程
- **AND** 用户拒绝时调用 MUST 失败

### Requirement: 沙箱 UI 执行

系统 SHALL 支持插件自定义 UI 经沙箱 iframe 渲染：独立 origin 与默认拒绝外联的 CSP；与宿主的通信仅限 postMessage 白名单消息（对应 Host API 子集），每条消息 MUST 携带 pluginId 且逐条过权限闸。插件 MUST NOT 直接访问主 WebView DOM 或内核 store。

#### Scenario: 越权桥消息被拒

- **WHEN** 沙箱 UI 发送未授权的 Host API 消息
- **THEN** 宿主 MUST 拒绝执行
- **AND** audit MUST 记录该次越权

#### Scenario: Overlay 承载自定义内容

- **WHEN** L3 插件请求在其 Overlay 中渲染自定义界面
- **THEN** 内容 MUST 运行于沙箱环境
- **AND** 宿主壳与导航 MUST 不受其影响
