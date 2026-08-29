## Context

危险操作确认散落在 `appConfirm` / `appPrompt`：数据库服务重启已是「点两次 + 输入 RESTART」，删表 / 删库只有一框。重启执行走前端 `sshPoolExecCommand`，删表走 `db_execute_query` 发 DDL，后端都不校验「人是否确认过」。

产品要的是通用在场证明，而不是再复制一套三步框。操作系统提供 Hello / Touch ID / PIN；应用只应拿到「通过 / 拒绝」，不采集生物特征。本期消费者仅 `/database`；管道必须能被后续 Docker / SSH 复用。

约束：IPC 走 tauri-specta；新命令 `Result<T, OmniError>`；crate 单向依赖；Web（`OMNIPANEL_WEB`）与 Linux 第一期无原生验证。

## Goals / Non-Goals

**Goals:**

- 通用 `presence`：探测、系统验证、短命 token（内存、一次性、按 action+target 绑定）。
- 统一 `requireStepUp`：有 OS 则「说明 → 系统验证」；否则打字证明后由后端签发 token。
- 重启 MySQL/Redis、删表、删库（含 SQL 编辑器里的 DROP TABLE/DATABASE/SCHEMA）必须带有效 token。
- 设置可关系统验证；关了或不可用时不得出现「点一下就发 token」的 IPC。

**Non-Goals:**

- Docker / SSH / 云 / AI 审批接入。
- Linux PAM、官方/社区 biometric 插件、Vault 生物识别解锁。
- 用 token 表达团队角色或多人审批。

## Decisions

### D1. 新 crate `omnipanel-presence`，commands 只做桥

```
frontend  requireStepUp
    │ commands.*（specta）
    ▼
src-tauri/commands/presence.rs     薄桥：窗口 HWND、设置开关
    │
    ▼
crates/omnipanel-presence
    PresenceVerifier trait
    TokenStore（进程内存）
    win: UserConsentVerifier + RequestVerificationForWindowAsync
    macos: LAContext evaluatePolicy
    other: Unavailable
```

- **为何独立 crate**：平台 cfg 与 WinRT/LocalAuthentication 依赖不应污染 db/ssh；单测可注入 `FakeVerifier` / 固定时钟。
- **否决** `tauri-plugin-biometry`：社区小、无 Linux、把存储和验证绑在一起；官方 biometric 仅移动端。
- **否决** 只写在 frontend：系统对话框必须由原生调起，token 必须后端签发。

联动：重启仍用现有 SSH 连接（`sshPoolExecCommand` 的逻辑上收到 crate/command 内）；不改 SSH 模块对外 API。SQL 执行继续走 `omnipanel-db`，仅在 command 入口加闸。

### D2. Token 合同：action + target，TTL 120s，用一次作废

```
PresenceGrant {
  token: 32 字节随机 hex
  action: "db.service.restart" | "db.schema.drop_table" | "db.schema.drop_database"
  target: 规范化指纹（见下）
  expires_at
}
```

`consume(token, action, target)`：三者全等、未过期、未用过 → 删除并 Ok；否则 `ErrorCode` 明确失败（过期 / 已用 / 不匹配 / 缺失）。

target 规范化：

| action | target |
|--------|--------|
| `db.service.restart` | `{sshConnectionId}|{service}|{kind}|{containerOrHost}` |
| `db.schema.drop_table` | `{connectionId}|{database}|{table}`；批量则为排序后的多行，一次验证覆盖一批 |
| `db.schema.drop_database` | `{connectionId}|{database}` |

**无「点击即签发」命令。** 只有两条签发路径：

1. `presence_verify(action, target, reason)` — 系统验证成功后签发。
2. `presence_issue_typed(action, target, typed)` — `typed` 与后端期望串全等后签发。

期望串：重启固定 `RESTART`；删表 / 删库为对象名（批量时为后端规定的拼接串，与 UI 提示一致）。设置关闭或 OS 不可用只能走 2。

### D3. 危险 SQL 在 `db_execute_query*` 入口拦截，不只挡按钮

Schema 树 / 表面板改为专用 command（见 D4），避免 DDL 与查询混用。SQL 编辑器仍走 `db_execute_query` / `db_execute_query_in_session`：解析首条有效语句，若为 `DROP TABLE` / `DROP DATABASE` / `DROP SCHEMA`，必须带匹配 token，否则拒绝。新增可选参数 `presence_token: Option<String>`（旧调用不传 = None，SELECT 不受影响）。

**否决**「只改 UI、编辑器照发」：闸会被查询框绕过。

历史 `Result<_, String>` 的 execute 命令本期只加参数与闸，不强制迁 OmniError（与仓库渐进策略一致）。新 presence / 重启 / drop command 用 `OmniError`。

### D4. 专用危险 command，重启不再由前端拼 SSH

| Command | 职责 |
|---------|------|
| `presence_status` | `{ available, kind: hello\|touchid\|none, osEnabled }` |
| `presence_verify` | OS 验证 → token |
| `presence_issue_typed` | 打字证明 → token |
| `db_restart_service` | 校验 token 后执行现有 host/docker 重启脚本 |
| `db_drop_table` | 校验 token 后按引擎拼 DROP TABLE 并执行 |
| `db_drop_database` | 校验 token 后 DROP DATABASE |

前端 `restartDeployedService` / `invoke("db_execute_query", DROP…)` 不再作为这两类操作的合法路径（可留内部被新 command 调用）。

`npm run gen:bindings` 后只走 `commands.*`。

### D5. UX：有 OS 时两步，无 OS 时保留证明强度

```
用户触发危险操作
        │
        ▼
   说明影响（appConfirm，WarnAlert）
        │ 取消 → 停
        ▼
   presence_status
        │
   ┌────┴────────────────────┐
   │ 设置开且 available      │ 否则
   ▼                         ▼
 presence_verify        提示输入期望串
 系统对话框              appPrompt
   │                         │
   ▼                         ▼
 token                    presence_issue_typed
   │                         │
   └──────────┬──────────────┘
              ▼
     db_restart_service / db_drop_* / execute(+token)
```

- 重启：有 OS **不再**第二次确认 + 打字；无 OS 保持打 `RESTART`。
- 删表 / 删库：有 OS 为「说明 + 系统验证」；无 OS 为「说明 + 输入对象名」（比现在只点确定更严，与 token 模型一致）。
- 重启 **无宽限期**（低频、中断连接）。本期不实现通用 sudo 式 timestamp。
- UI 复用 `appConfirm` / `appPrompt` / 设置页既有 Toggle；不新增指纹伪 UI，系统对话框即验证面。

设置：`security.osPresenceEnabled` 默认 `true`，写入现有 settings 存储；设置页安全分组增加开关与「本机：Windows Hello / 不可用」只读状态。

### D6. Web / Linux / 测试

- Linux 与 Web：`available=false`，`presence_verify` 返回不可用；只走 typed。
- 单测：`FakeVerifier`、过期/错 action/错 target/二次 consume。
- 无头 CI：不调真实 Hello。

## Risks / Trade-offs

- **[共享工位 Hello = 谁录了谁能批]** → 文案写明「验证的是本机登录用户」；不做伪多用户。
- **[打字签发仍可被脚本 invoke]** → 比「无闸」强（必须知道对象名 / RESTART）；OS 路径无法用 invoke 伪造。接受 typed 弱于 Hello。
- **[SQL 拦截漏检复杂脚本]** → 第一期只认首条语句的 DROP TABLE/DATABASE/SCHEMA；多语句夹带后续加强。
- **[macOS 未签名 LAContext 失败]** → 探测失败则降级 typed，不阻断发版。
- **[Win7/无 Hello]** → `available=false`，走 typed。
- **[db_execute_query 加可选参数]** → 需 `gen:bindings`；未传 token 的 DROP 会被拒，属预期。

## Migration Plan

1. 落地 crate + 命令 + 设置，重启 / 删表 / 删库改走新 API。
2. 旧三步重启与「只点确定删表」仅作为 typed / 说明层残留，不再单独执行。
3. 回滚：关设置 + 保留 typed command；或回退调用方。token 不落盘，无数据迁移。

## Open Questions

- SQL 编辑器一次选中多条语句且含多条 DROP 时，第一期拒绝整批并提示拆开，还是一条 token 绑定多 target？（实现时默认：含多于一条危险语句则拒绝，要求逐条 step-up。）
- 删视图是否与删表同一 action？（建议同一 `drop_table` 合同，target 带 kind=view。）
