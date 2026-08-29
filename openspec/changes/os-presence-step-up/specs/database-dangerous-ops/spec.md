## ADDED Requirements

### Requirement: 重启数据库服务必须消费 token
重启已部署的 MySQL 或 Redis（host `systemctl`/`service` 或 Docker `restart`）MUST 通过 `db_restart_service`（或等价专用 command）执行。该 command MUST `consume` 与 action `db.service.restart` 及该实例 target 绑定的 token。前端 MUST NOT 再以裸 `sshPoolExecCommand` 作为用户重启入口。

#### Scenario: 持有匹配 token 后重启
- **GIVEN** 已签发绑定该 SSH 目标与服务种类的重启 token
- **WHEN** 调用 `db_restart_service` 并携带该 token
- **THEN** 执行重启脚本，token 被消费

#### Scenario: 无 token 重启
- **WHEN** 不带 token 或不匹配 token 调用重启 command
- **THEN** 拒绝，远端服务不被重启

#### Scenario: 生产主机重启
- **GIVEN** 部署所在连接或主机环境为 prod
- **WHEN** 用户触发重启
- **THEN** 仍须 step-up 与有效 token（不得因 prod 以外的确认框而跳过 token）

### Requirement: 删表必须消费 token
从连接信息 / Schema 树 / 表列表面板删除表（及同期约定的视图）MUST 走 `db_drop_table`（或批量等价 command），MUST 消费 `db.schema.drop_table` 且 target 覆盖将删除的每一个对象。系统 MUST 按引擎生成 DROP 语句，MUST NOT 在无 token 时调用通用查询执行 DROP。

#### Scenario: 单表删除成功
- **GIVEN** token 绑定该连接、库名与表名
- **WHEN** 调用 `db_drop_table`
- **THEN** 表被删除，token 不可再用

#### Scenario: 批量删表共用一次 step-up
- **GIVEN** 用户选择多张表并完成一次 step-up
- **WHEN** 执行批量删除
- **THEN** token 的 target 包含全部选中表；缺任一表名的 token MUST 被拒绝

#### Scenario: 无 token 删表
- **WHEN** 直接调用删表 command 或对 `db_execute_query` 发送 DROP TABLE 且 token 无效
- **THEN** 拒绝，表仍存在

### Requirement: 删库必须消费 token
删除数据库 MUST 走 `db_drop_database`，MUST 消费 `db.schema.drop_database` 且 target 为该连接与库名。生产环境（`env_tag=prod`）MUST 与非 prod 一样强制 token，MUST NOT 仅用一次 `appConfirm` 放行。

#### Scenario: 删库成功
- **GIVEN** 匹配的删库 token
- **WHEN** 调用 `db_drop_database`
- **THEN** 数据库被删除

#### Scenario: 生产环境无 token 删库
- **GIVEN** 连接 env_tag 为 prod
- **WHEN** 不带有效 token 请求删库
- **THEN** 拒绝，库仍存在

### Requirement: SQL 编辑器危险 DDL 同样过闸
`db_execute_query` 与 `db_execute_query_in_session` MUST 识别首条有效语句是否为 `DROP TABLE` / `DROP DATABASE` / `DROP SCHEMA`。若是，MUST 要求有效 `presence_token` 且 action/target 与语句对象一致。一次脚本含多于一条此类危险语句时 MUST 拒绝整批，提示拆开逐条确认。非危险语句 MUST 不要求 token。

#### Scenario: 编辑器执行 DROP TABLE 且已 step-up
- **GIVEN** 用户对将删除的表完成 step-up
- **WHEN** 编辑器提交该 DROP TABLE 并附带 token
- **THEN** 语句执行成功

#### Scenario: 编辑器执行 DROP TABLE 无 token
- **WHEN** 编辑器或任意调用方提交 DROP TABLE 且不带有效 token
- **THEN** 拒绝执行

#### Scenario: 普通 SELECT
- **WHEN** 提交 SELECT 且不传 token
- **THEN** 正常执行

#### Scenario: 多条危险语句
- **WHEN** 一次提交包含两条及以上 DROP TABLE/DATABASE/SCHEMA
- **THEN** 全部不执行并返回明确错误

### Requirement: 危险操作可审计
重启、删表、删库（含编辑器危险 DDL）无论成功或因 token 失败，MUST 写入现有审计通道（与当前 `audit_log` / 任务记录惯例一致），记录 action、target 摘要、是否通过在场验证；MUST NOT 写入 token 明文或生物特征相关数据。

#### Scenario: 重启成功记审计
- **WHEN** `db_restart_service` 成功
- **THEN** 审计条目包含重启 action 与目标摘要

#### Scenario: token 失败记审计
- **WHEN** 因 token 无效拒绝删库
- **THEN** 审计或错误日志可区分「未授权 / token 无效」，不含 token 值
