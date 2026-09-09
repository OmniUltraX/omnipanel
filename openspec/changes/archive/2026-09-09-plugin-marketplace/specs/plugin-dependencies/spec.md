## ADDED Requirements

### Requirement: 依赖声明与解决

manifest SHALL 支持 `dependencies[]`（`{id, versionReq}`，禁自依赖，req 语法 `^/>=/=`）；resolver SHALL BFS 展平输出安装计划；环依赖与版本冲突 SHALL 报可读错误并列出环路/冲突双方。

#### Scenario: 缺件一次装齐

- **WHEN** 安装带缺失依赖的插件并确认计划
- **THEN** 依赖与本体按拓扑序一次装齐

#### Scenario: 环依赖拒绝

- **WHEN** 依赖形成环
- **THEN** 拒绝并列出环路，不安装任何包

### Requirement: 卸载保护

被其它已安装插件依赖 SHALL 拒绝卸载并指名依赖方；禁用不拦截。

#### Scenario: 被依赖拒卸

- **WHEN** 卸载仍被依赖的插件
- **THEN** 拒绝并提示先卸载依赖方或保留
