## Why

危险操作的确认目前几乎全是点一下 `appConfirm`；数据库服务重启虽已做成「点两次 + 手打 RESTART」，但仍是前端闸，IPC 可绕过，且与 Docker 重启确认复制粘贴。操作系统已提供在场证明（Windows Hello / Touch ID / PIN），应用层却没用上，生产库误操作的最后一道人机边界偏软。

## 目标

- **通用在场验证**：Rust 侧提供跨平台 `presence` 能力（探测 + 调起系统验证 + 短命 token），业务不直接碰 Hello / Touch ID。
- **统一 step-up 管道**：前端只调 `requireStepUp`；有系统验证则「说明影响 → OS 验证」，否则降级为现有确认 / 打字 token。
- **第一刀数据操作**：数据库服务重启（MySQL / Redis）、删表、删库必须走 step-up，且后端消费 presence token，禁止只信前端布尔值。
- **可关可降级**：设置项可关系统验证；Linux / Web / 未录入 / CI 明确降级，不得假装已验证。

## 非目标（Non-goals）

- **不接 Docker / SSH / 云资源 / AI tool 审批**（同一管道后续复用，本期只做数据操作消费者）。
- **不用官方 `tauri-plugin-biometric`**（仅移动端）；不把社区 `tauri-plugin-biometry` 绑成产品依赖。
- **不做 Linux 指纹 / PAM / polkit 第一期实现**，探测为不可用后走降级。
- **不用系统验证解锁 Vault / 绑定密钥**（keyring 存密与在场证明分开）。
- **不替换所有 `appConfirm`**；medium / 低风险仍点确认。
- **不加第四步确认**：有 OS 验证时用它替换重启流程的后两步，而不是叠在三步之上。
- **不引入 OmniPanel 账号身份或多人审批**；OS 验证只证明「能解锁这台电脑的人在场」。

## 背景与动机

影响 Phase 2 数据库客户端（路由 `/database`），并预埋跨模块通用能力。环境标签策略不变：`prod` 与 destructive DDL 仍要强提醒；本期把「点确定」升级为可核验的在场证明。

现状：

| 操作 | 现确认 | 后端闸 |
|------|--------|--------|
| 重启 MySQL / Redis | 三步（确认 ×2 + 输入 `RESTART`） | 无，直接 `sshPoolExecCommand` |
| 删表 / 删库 | 一次 `appConfirm` | 无（SQL 照发） |
| Docker 守护进程重启 | 与数据库重启同构三步（复制粘贴） | 本期不改 |

对应产品原则：生产与高危操作必须二次确认且可审计（PRD 安全基线）；AI / 脚本路径同样不得绕过本闸。

## What Changes

- 新增通用 `presence`：探测可用性、调起系统验证（Win Hello / macOS LocalAuthentication）、签发与校验短命 token。
- 新增 `requireStepUp`：按风险档与设置决定 OS 验证或打字 / 对话框降级；重启有 OS 时改为「说明 + 系统验证」。
- 设置页增加「危险操作使用系统验证」开关（默认开）。
- `db_restart_service`（或等价专用 command）接收并校验 token，不再只靠前端拼 SSH。
- 删表 / 删库的执行路径携带并校验 token；生产环境不得降级为「只点一次确定」。
- 设置关闭、平台不支持、用户取消、token 过期 / 冒用均拒绝执行，并给出可理解文案。

## Capabilities

### New Capabilities

- `user-presence`: 系统在场验证、可用性探测、短命 token 签发与一次性消费。
- `step-up-confirm`: 统一 step-up 策略、设置开关、无 OS 时降级到确认框 / 打字 token。
- `database-dangerous-ops`: 重启数据库服务、删表、删库必须走 step-up 且后端校验 token。

### Modified Capabilities

<!-- openspec/specs/ 目前为空，无既有能力合同可修订。 -->

## 成功标准

- Windows（已录入 Hello）或 macOS（Touch ID / 密码回退）上重启 MySQL/Redis、删表、删库会弹出系统验证；通过后才执行，取消则不执行。
- 系统验证不可用或设置关闭时，重启仍须打字 `RESTART`；删表 / 删库至少保留明确确认，生产不得静默放行。
- 直接调用重启 / 删表 / 删库 command 而不带有效 token 被拒绝。
- token 过期、已消费、action 不匹配均拒绝；不能拿「重启」的 token 去删库。
- Web 构建（`OMNIPANEL_WEB=1`）不调用原生验证，走降级路径且类型检查通过。
- `cd frontend && npx tsc -b` 零 error；相关 Rust 单测覆盖 token 生命周期与无 token 拒绝。

## Impact

- **后端**：新 presence 模块（建议 crate 或 `src-tauri` 内聚模块）、specta 命令（探测 / 验证 / 策略读取）、数据库危险 command 改签名、SSH 重启不再走裸 `sshPoolExecCommand`。
- **前端**：`lib/stepUp.ts`、设置项、`useDeploymentServiceActions`、Schema 删表/删库、`DatabaseTablesPanel` 等确认点；i18n 中英。
- **平台**：Windows WinRT `UserConsentVerifier`（HWND 挂窗口）；macOS `LAContext`；Linux / Web 探测失败。
- **安全**：token 仅内存、短 TTL、按 action 绑定；不把生物特征数据收入应用。
