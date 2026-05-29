# OmniPanel 架构与协作约定

本文件是多人协作的唯一 onboarding 入口，描述代码边界、IPC 契约、错误处理、状态管理与提交规范。新成员开工前请通读本文。产品需求见 [`../PRD.md`](../PRD.md)。

## 1. 总体分层

```
前端 (React + TS)  ──invoke──▶  Tauri 命令 (src-tauri)  ──▶  后端 crates (业务逻辑)
       ▲                              │
       └──────── events ◀─────────────┘
```

- **前端**：只负责展现与交互，不放业务规则；通过自动生成的 typed client 调用后端。
- **`src-tauri`**：薄编排层。只做命令注册、参数桥接、事件 emit，**不写业务逻辑**。
- **后端 crates**：所有业务能力按领域拆分为独立 crate，便于独立测试与多人并行。

## 2. Crate 边界（后端）

| crate | 职责 | 不应包含 |
|-------|------|----------|
| `omnipanel-store` | rusqlite 本地库、keyring 凭据、`Connection` 统一连接模型、schema migration | UI、协议实现 |
| `omnipanel-exec` | 执行引擎 `ExecutionEngine` + `Executor` trait，动作分发/回显/审计 | 具体驱动细节（通过 trait 解耦） |
| `omnipanel-ssh` | russh / russh-sftp 会话封装 | 存储、UI |
| `omnipanel-db` | `DbDriver` trait + MySQL/PostgreSQL/SQLite 实现 | 连接持久化（用 store） |
| `omnipanel-core` | 终端（portable-pty + alacritty_terminal VT 状态） | 其他领域逻辑 |
| `omnipanel-ai` | `AiProvider` trait + OpenAI/Anthropic/ACP | 其他领域逻辑 |

规则：

- crate 之间**单向依赖**，禁止环依赖。`exec` 可依赖各驱动 crate 与 `store`；驱动 crate 不依赖 `exec`。
- 新增领域能力优先开新 crate 或在对应 crate 内扩展，**不要往 `src-tauri` 堆业务代码**。
- 扩展点一律走 trait（参照现有 `AiProvider`），方便并行开发与未来插件化。

## 3. 前端目录约定

| 目录 | 职责 |
|------|------|
| `src/modules/<feature>` | 功能模块 UI（terminal/ssh/database/...），可依赖 stores、lib、components |
| `src/stores` | Zustand 全局状态，**唯一可写状态的地方**；模块通过 store 共享状态 |
| `src/components` | 跨模块复用的 UI（shell/ai/dock/ui） |
| `src/lib` | 纯函数工具、领域常量、IPC 封装 |
| `src/ipc` | 自动生成的后端 bindings（勿手改） |
| `src/i18n` | 文案，所有用户可见字符串必须走 `useI18n`，禁止硬编码 |

规则：模块之间不要互相 import，跨模块通信走 store 或事件。

## 4. IPC 契约（前后端类型一致性）

- 使用 `tauri-specta` 从 Rust 命令与类型自动生成前端 `src/ipc/bindings.ts`。
- 每个 `#[tauri::command]` 必须加 `#[specta::specta]`，参数/返回类型派生 `specta::Type`。
- **前端禁止手写命令字符串与参数类型**，统一调用生成的 typed client。
- 改了命令签名后需重新生成 bindings（开发期由 `tauri_specta::Builder` 在 debug 构建时导出）。

## 5. 错误处理约定

- 后端各 crate 用 `thiserror` 定义领域错误，统一汇入 `OmniError { code, kind, message, cause }`。
- 命令返回 `Result<T, OmniError>`，**不再返回 `Result<T, String>`**。
- 错误必须包含可读 message 与错误码；面向用户的错误应能区分原因（参照 PRD 4.5「错误可理解」）。
- 前端统一处理 `OmniError` 结构，按 code 决定提示与重试策略。

## 6. 安全基线

- 敏感凭据（密码、私钥、Token）只存系统 keyring，**绝不明文落库/落盘**，库内仅存 `credential_ref`。
- 本地库支持 SQLCipher 整库加密（feature 开关，主密钥存 keyring）。
- 高风险动作（生产环境、危险命令）必须经执行引擎确认并写 `audit_log`。

## 7. 测试约定

- Rust：每个 crate 在 `#[cfg(test)]` 写单元测试；跨 crate 行为放 `tests/` 集成测试。`cargo test --workspace` 必须绿。
- 前端：`vitest` + `@testing-library/react`，测试文件与源码同目录命名 `*.test.ts(x)`。
- 纯逻辑（commandGuard、解析、store reducer）优先覆盖。

## 8. 提交与 CI

- 提交信息遵循约定式提交（Conventional Commits），描述用中文，例：`feat(ssh): 新增密钥认证`。
- PR 必须通过 [`ci.yml`](../.github/workflows/ci.yml)：`cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`、`eslint`、`tsc`、`vitest`，覆盖 Linux/Windows/macOS。
- 每个里程碑结束保证整工作区可编译、CI 绿、可运行。
