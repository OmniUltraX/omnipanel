## ADDED Requirements

### Requirement: 磁盘包前端逻辑动态装载

系统 SHALL 支持磁盘安装包（`app_data/plugins/<id>/`）的前端逻辑动态装载：当清单含 `entry.ui`（约定 `ui/main.js`）且插件 `enabled+activated` 时，前端 SHALL 经 `plugin_read_asset` 读取后沙箱求值并执行 `activate({host, manifest})`；`deactivate` SHALL 在失活时被调用。第一方静态 `PLUGIN_MODULES` 路径 SHALL 保留且优先级相同（同走差量先卸后启）。

#### Scenario: 第三方前端 activate 生效

- **WHEN** 用户安装含 `ui/main.js` 的第三方包并启用
- **THEN** 其 `activate` 被调用并完成 launcher/menu/probe 登记，禁用后登记消失

#### Scenario: 非法入口降级为 L1

- **WHEN** `ui/main.js` 缺失或求值返回值无 `activate` 函数
- **THEN** 系统记 `unsupported_reason=ui.invalid_entry`，清单贡献（L1 部分）仍可用，前端逻辑不生效且不影响其他插件

#### Scenario: 单插件失败隔离

- **WHEN** 某插件 `activate` 抛错
- **THEN** 控制台记 `[plugin-runtime] activate <id> 失败`，该插件不加入 active 集，其他插件正常激活

### Requirement: 差量生命周期语义

系统 SHALL 按 `enabled+activated` 差量驱动先卸后启；`syncPluginLifecycles` SHALL 保持幂等。

#### Scenario: 启用→禁用差量

- **WHEN** 插件从启用变为禁用
- **THEN** 其 `deactivate` 被调用，launcher 前缀/菜单/探针登记被移除
