## ADDED Requirements

### Requirement: 统一 step-up 入口
前端危险操作 MUST 通过统一 `requireStepUp` 取得 token，MUST NOT 在业务模块内直接调起平台 API 或复制第三套确认流程。step-up MUST 先展示操作影响（复用 `appConfirm` / WarnAlert），再按策略选择系统验证或打字证明。

#### Scenario: 本机可用且设置为开
- **GIVEN** `presence_status` 为 available 且 osEnabled
- **WHEN** 用户确认影响说明后
- **THEN** 调起系统验证，成功则得到 token，取消则中止且不调用危险 command

#### Scenario: 本机不可用
- **GIVEN** `available` 为 false 或 osEnabled 为 false
- **WHEN** 用户确认影响说明后
- **THEN** 提示输入期望串，校验成功后得到 token；取消或输错则中止

### Requirement: 有系统验证时不得叠加多余步骤
当走系统验证时，重启流程 MUST 为「说明影响 + 系统验证」，MUST NOT 再要求第二次确认或输入 `RESTART`。本期重启 MUST NOT 提供验证宽限期。

#### Scenario: 重启且 Hello 可用
- **WHEN** 用户重启 MySQL 或 Redis 且系统验证可用
- **THEN** 只出现一次影响说明和一次系统对话框，通过后执行

#### Scenario: 重启且无系统验证
- **WHEN** 用户重启服务且必须降级
- **THEN** 说明影响后仍须输入 `RESTART` 才签发 token

### Requirement: 设置项控制是否优先系统验证
设置页 MUST 提供「危险操作使用系统验证」开关，默认开启，文案走 i18n（zh-CN / en-US）。关闭后 MUST 仍要求打字证明，MUST NOT 把危险操作降级为只点确定。页面 MUST 展示本机能力只读状态（如 Windows Hello / 不可用）。

#### Scenario: 关闭开关后重启
- **GIVEN** 用户关闭系统验证
- **WHEN** 触发重启
- **THEN** 不调起 Hello / Touch ID，仍须输入 `RESTART`

#### Scenario: Web 构建设置页
- **GIVEN** `OMNIPANEL_WEB` 构建
- **WHEN** 打开该设置
- **THEN** 开关可显示但系统验证不可用，step-up 走打字路径，类型检查通过

### Requirement: 用户取消与错误可理解
用户取消、验证失败、期望串不匹配时 MUST 中止操作，MUST 使用 i18n 文案，MUST NOT 部分执行批量删除中的后续对象（已成功的不回滚，但 MUST 停止继续并发未开始的项；批量在取得 token 前失败则一项都不执行）。

#### Scenario: 说明阶段取消
- **WHEN** 用户在影响说明对话框选择取消
- **THEN** 不调用 `presence_verify` / `presence_issue_typed`，不执行危险 command

#### Scenario: 批量删表在 step-up 失败
- **WHEN** 多表删除在取得 token 前失败或取消
- **THEN** 任何表都未被删除
