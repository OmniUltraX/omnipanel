## ADDED Requirements

### Requirement: 探测本机在场验证能力
系统 MUST 提供 `presence_status`，返回本机是否可调起操作系统在场验证、模态种类，以及设置中是否启用系统验证。Linux 与 Web 构建 MUST 报告不可用。系统 MUST NOT 采集或上传生物特征数据。

#### Scenario: Windows Hello 可用且设置为开
- **GIVEN** 桌面 Windows 已录入 Windows Hello，且 `security.osPresenceEnabled` 为 true
- **WHEN** 调用 `presence_status`
- **THEN** `available` 为 true，`kind` 为 hello，`osEnabled` 为 true

#### Scenario: 平台不支持
- **GIVEN** Linux 桌面或 `OMNIPANEL_WEB` 构建
- **WHEN** 调用 `presence_status`
- **THEN** `available` 为 false，`kind` 为 none

#### Scenario: 用户关闭系统验证
- **GIVEN** 本机 Hello 可用，但设置关闭系统验证
- **WHEN** 调用 `presence_status`
- **THEN** `available` 仍可反映本机能力，`osEnabled` 为 false

### Requirement: 系统验证成功后签发短命 token
`presence_verify` MUST 调起操作系统验证对话框（Windows Hello 或 macOS LocalAuthentication），成功后签发仅存于进程内存的 token。token MUST 绑定 action 与规范化 target，TTL MUST 不超过 120 秒。`presence_verify` 在 `osEnabled` 为 false 或本机不可用时 MUST 失败，且 MUST NOT 签发 token。

#### Scenario: 用户完成系统验证
- **WHEN** 调用 `presence_verify` 且用户通过系统验证
- **THEN** 返回未过期 token，其 action/target 与请求一致

#### Scenario: 用户取消系统验证
- **WHEN** 用户取消或验证失败
- **THEN** 命令返回错误，不签发 token

#### Scenario: 设置已关闭仍请求系统验证
- **GIVEN** `osEnabled` 为 false
- **WHEN** 调用 `presence_verify`
- **THEN** 拒绝并说明应使用打字签发

### Requirement: 打字证明签发 token
`presence_issue_typed` MUST 仅在 `typed` 与该 action 的后端期望串完全一致时签发 token。重启的期望串 MUST 为 `RESTART`。删表 / 删库的期望串 MUST 为对应对象名（批量 MUST 与 UI 提示的拼接规则一致）。系统 MUST NOT 提供「仅点击即可签发」的命令。

#### Scenario: 输入 RESTART 签发重启 token
- **WHEN** `presence_issue_typed` 的 action 为 `db.service.restart` 且 typed 为 `RESTART`
- **THEN** 签发绑定该重启 target 的 token

#### Scenario: 对象名不匹配
- **WHEN** 删表签发时 typed 与表名不一致
- **THEN** 拒绝且不签发 token

### Requirement: token 一次性消费且不可挪作他用
危险命令 MUST 通过 `consume(token, action, target)` 校验。过期、已消费、action 不一致、target 不一致或缺失 MUST 拒绝执行且 MUST NOT 产生副作用。成功消费后同一 token MUST 无法再次使用。

#### Scenario: 用重启 token 删库
- **GIVEN** 已签发 `db.service.restart` token
- **WHEN** 将其传给删库 command
- **THEN** 拒绝执行，数据库不变

#### Scenario: 二次使用
- **GIVEN** token 已被一次危险命令消费
- **WHEN** 再次使用同一 token
- **THEN** 拒绝

#### Scenario: 过期
- **GIVEN** token 签发已超过 TTL
- **WHEN** 危险命令携带该 token
- **THEN** 拒绝

#### Scenario: 生产环境无 token
- **GIVEN** 连接 `env_tag` 为 prod
- **WHEN** 不带 token 调用重启或 DROP 类 command
- **THEN** 拒绝（与非 prod 相同，均须 token）
