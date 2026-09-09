## ADDED Requirements

### Requirement: WASM 参数透传

系统 SHALL 将 `plugin_invoke(plugin_id, method, args_json)` 的方法名与参数经 `omni_alloc` 写入客体内存后调用 `call(method_ptr, method_len, args_ptr, args_len)`；客体返回 `(len<<32)|ptr`，最高位 1 表示错误文本。缺 `omni_alloc` 又需回传数据时 SHALL 返回可读错误包。

#### Scenario: 回显透传

- **WHEN** 调用 WASM 客体 `echo` 方法并传 JSON 参数
- **THEN** 返回相同 JSON（往返一致），单测覆盖 wat 客体

#### Scenario: 非法 wasm 拒绝

- **WHEN** 逻辑包不是合法 wasm
- **THEN** `instantiate` 失败并返回“逻辑包编译失败”，不影响其他插件

### Requirement: QuickJS 磁盘逻辑加载

系统 SHALL 支持磁盘包 `entry.logic=.js`（≤2MB）经 QuickJS 执行，内存 64MB/栈 1MB/单次 10s 中断语义不变；`call(method,argsJson)->JSON` 与内置包一致。

#### Scenario: JS 逻辑兜底路由

- **WHEN** 插件无原生 handler 但有 L2 JS 实例且方法在 `methods[]` 白名单内
- **THEN** `plugin_invoke` 经 L2 实例执行并返回结果

### Requirement: 权限闸与 prod 确认

`plugin_invoke` SHALL 先查 `methods[]` 白名单再逐项权限强制；L2 `net.fetch` 命中 `env_tag=prod` 主机 SHALL 经宿主弹窗确认（60s 超时=拒绝），不可配置绕过；成败 SHALL 写 `audit_log`（args 只存 sha256+len）。

#### Scenario: 缺权调用被拒并审计

- **WHEN** 逻辑包调用未声明权限的 host function
- **THEN** 返回权限拒绝错误且记 `action=plugin.permission/blocked`

#### Scenario: prod 主机二次确认

- **WHEN** L2 请求访问 prod 标签主机
- **THEN** 弹出确认，拒绝/超时则拦截并审计
