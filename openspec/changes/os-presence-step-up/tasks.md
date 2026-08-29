## 1. Presence crate（crates/omnipanel-presence/）

- [x] 1.1 新建 crate：`PresenceVerifier` trait、`Unavailable` 实现、`TokenStore`（签发 / consume / TTL 120s / action+target 绑定）；挂入 workspace `Cargo.toml`。验证：`cargo test -p omnipanel-presence`（假时钟：过期、错 action、错 target、二次 consume）
- [x] 1.2 Windows 适配：`UserConsentVerifier` + `RequestVerificationForWindowAsync`（HWND 由 command 传入）；探测 Hello 不可用时 `available=false`。验证：`cargo test -p omnipanel-presence` 非 Win 编译通过；Win 本机手动点一次对话框
- [x] 1.3 macOS 适配：`LAContext` evaluatePolicy，失败/未签名降级为不可用。验证：macOS 目标交叉检查编译；无 Mac 时至少 `cfg` 隔离不破坏 Windows CI

## 2. Tauri 命令（src-tauri/src/commands/、state.rs、lib.rs）

- [x] 2.1 新增 `presence_status` / `presence_verify` / `presence_issue_typed`（`Result<_, OmniError>`）；设置读取 `security.osPresenceEnabled`（默认 true）；`osEnabled=false` 或不可用时 `presence_verify` 拒绝。验证：注册进 `collect_commands!` 与 `generate_handler!`，`npm run gen:bindings`
- [x] 2.2 `db_restart_service`：consume `db.service.restart` token 后执行现有 host/docker 重启逻辑（从 `deploymentServiceActions.ts` 迁到后端）；无 token 拒绝。验证：`cargo test` 覆盖无 token / 错 token；不跑真实 SSH
- [x] 2.3 `db_drop_table` / `db_drop_database`：按引擎拼 DDL，consume 对应 action+target（批量 target 含全部对象）。验证：单测无 token 拒绝；不连真实库
- [x] 2.4 `db_execute_query` 与 `db_execute_query_in_session` 增加可选 `presence_token`；首条语句为 DROP TABLE/DATABASE/SCHEMA 时强制 consume；多条危险语句整批拒绝。验证：单测 SELECT 无 token 放行、单条 DROP 无 token 拒绝、双 DROP 拒绝
- [x] 2.5 审计：重启 / drop / 编辑器危险 DDL 成功或 token 失败写入现有 audit 通道，禁止记录 token 明文。验证：单测或日志断言字段

## 3. 前端通用 step-up（frontend/src/lib/、frontend/src/modules/settings/）

- [x] 3.1 `lib/stepUp.ts`：`requireStepUp`（先 `appConfirm` 说明 → `presence_status` → verify 或 `appPrompt` + `presence_issue_typed`）；只走 `commands.*` + `unwrapCommand`。验证：vitest mock IPC（可用/不可用/取消/输错）
- [x] 3.2 设置页安全分组：开关 `security.osPresenceEnabled` + 本机能力只读文案；i18n zh-CN / en-US。验证：`cd frontend && npx tsc -b`；Web 构建不引用原生插件

## 4. 数据库消费者（frontend/src/modules/database/）

- [x] 4.1 `useDeploymentServiceActions.ts`：重启改 `requireStepUp` + `db_restart_service`；有 OS 时去掉第二次确认与打字。验证：不跨 module import；vitest 或手动：取消不发重启
- [x] 4.2 Schema 树 / `DatabaseTablesPanel` / 删库入口：删表删库改 `requireStepUp` + `db_drop_*`；批量一次 step-up。验证：无 token 路径不再 `invoke("db_execute_query", DROP)`
- [x] 4.3 SQL 编辑器提交：检测危险 DDL 则先 step-up 再带 token 调用 execute；多危险语句提示拆开。验证：SELECT 路径不变；`npx tsc -b`

## 5. 联调与门禁

- [x] 5.1 `cd frontend && npx tsc -b` 零 error；`cargo test -p omnipanel-presence` 及危险 command 相关测试通过
- [ ] 5.2 手动验收（Windows Hello 或打字降级）：重启 MySQL/Redis、删表、删库、编辑器 DROP TABLE；取消 / 关设置 / 错 token 均不执行；生产连接同样要 token
