# OmniPanel Web 化（P1：前后端分离 + 运维闭环）

> Issue #6「改造成 web 端，前后端分离」的 P0→P1 落地说明。

## 一句话方案

**不改任何业务代码，只把 `invoke` / `listen` 的底层传输从 Tauri IPC 换成 HTTP + WebSocket。**
浏览器和桌面共用同一套前端产物、同一个 Rust 后端能力。

```
┌─────────────┐    POST /ipc/invoke    ┌──────────────────────────────┐
│  浏览器      │  ───────────────────►  │  omnipanel-server            │
│ (同一套前端) │  WS  /ipc/events ◄───  │  ├─ 静态托管 frontend/dist    │
└─────────────┘   事件流               │  ├─ 命令分发 (等价 invoke)    │
                                      │  └─ 事件广播 (等价 listen)    │
┌─────────────┐                        │     复用 omnipanel-* crates  │
│ Tauri 桌面端 │  现状不动              │     与 AppState 同一套逻辑    │
└─────────────┘                        └──────────────────────────────┘
```

## P0（已完成，PR #7）

- 本地终端链路：`create_terminal` / `write_terminal` / `resize_terminal` /
  `close_terminal` / `terminal_snapshot` / `list_shells`
- 事件总线 + WS 广播（`terminal-output` / `terminal-event`）
- 静态托管 `frontend/dist`
- 前端 transport shim + `@tauri-apps/api` 浏览器 shim

## P1 新增（本 PR）

### 后端新增命令（均复用桌面端领域 crate，无业务重写）

**数据库（`crates/omnipanel-server/src/db.rs`）**
复用 `omnipanel-db` 的 `DbDriver`（MySQL / PG / SQLite / Redis / MongoDB / Qdrant），
连接管理复用 `omnipanel-store::DatabaseConnectionStore`（与桌面端共用
`~/.omnipd/database/connections.json`）：

- `db_list_connections` / `db_save_connection` / `db_delete_connection` / `db_get_connection_secret`
- `db_test_connection`（返回版本串）
- `db_list_databases` / `db_list_tables` / `db_preview_table` / `db_count_table` / `db_count_tables`
- `db_execute_query`（SELECT 返回行集 / DML 返回影响行数，`limit` 包裹防超大结果集，`run_id` 支持取消）
- `db_cancel_query`

**SSH（`crates/omnipanel-server/src/ssh.rs`）**
复用 `omnipanel-ssh::SshSession`（交互式 shell），输出经事件总线广播
（与本地终端共用 `terminal-output` 事件），连接配置复用
`omnipanel-store::inject_ssh_vault_into_config`（Vault 凭据注入）：

- `ssh_list_connections`
- `ssh_connect_connection`（按连接 id 建会话，返回会话 id）
- `ssh_write` / `ssh_resize` / `ssh_disconnect`

**Docker（`crates/omnipanel-server/src/docker.rs`）**
复用 `omnipanel-docker` 的 `DockerAdapter`（本地 Engine / Remote Engine / SSH 宿主机 /
1Panel 四种来源，`resolve_target` 逻辑与桌面端等价），SSH 会话按连接池复用：

- `docker_list_connections`（并行探测回填状态）
- `docker_probe_connection` / `docker_get_overview` / `docker_list_containers`
- `docker_get_local_engine_status` / `docker_reset_ssh_session`

### 状态管理（`crates/omnipanel-server/src/state.rs` + `terminal.rs`）

`ServerState` 扩展为 P1 全量状态，进程内单例共享：

- `storage`：元数据库（`~/.omnipd/store/omnipanel.db`）
- `db_connections`：DB 连接仓库
- `running_db_queries`：运行中 SQL 查询 abort 句柄
- `ssh_sessions`：交互式 SSH 会话表
- `docker_ssh_sessions`：Docker SSH-Engine 复用连接池

### API Key 鉴权（复用 gateway 的 api_key 模式）

```bash
cargo run -p omnipanel-server -- --static-dir frontend/dist --port 8899 --api-key <key>
```

- `POST /ipc/invoke`：校验 `Authorization: Bearer <key>`
- `WS  /ipc/events`：校验 `?token=<key>`（浏览器 WebSocket 无法自定义 header）

前端 Web 构建时通过 `VITE_OMNIPANEL_API_KEY` 注入：
```bash
cd frontend && OMNIPANEL_WEB=1 VITE_OMNIPANEL_API_KEY=<key> npm run build
```

### 文件清单

| 文件 | 说明 |
|---|---|
| `crates/omnipanel-server/src/state.rs`（新增） | 存储 / DB 连接仓库 / SSH 配置解析辅助 |
| `crates/omnipanel-server/src/db.rs`（新增） | P1 数据库命令 |
| `crates/omnipanel-server/src/ssh.rs`（新增） | P1 SSH 命令 |
| `crates/omnipanel-server/src/docker.rs`（新增） | P1 Docker 命令 |
| `crates/omnipanel-server/src/ipc.rs` | 命令分发扩展（DB/SSH/Docker） |
| `crates/omnipanel-server/src/terminal.rs` | `ServerState` 扩展 P1 字段 |
| `crates/omnipanel-server/src/server.rs` | `AppCtx`（共享 state + api_key）、鉴权 |
| `crates/omnipanel-server/src/ws.rs` | WS 升级时 token 校验 |
| `crates/omnipanel-server/src/main.rs` | `--api-key` 参数 |
| `frontend/src/ipc/transport.ts` | Web invoke 带 `Authorization` 头；WS 带 `?token=` |

## 启动方式

```bash
# 1. 构建 Web 版前端（可选 API Key）
cd frontend && OMNIPANEL_WEB=1 [VITE_OMNIPANEL_API_KEY=<key>] npm run build && cd ..

# 2. 启动服务端（可选 --api-key）
cargo run -p omnipanel-server -- --static-dir frontend/dist --port 8899 [--api-key <key>]

# 3. 浏览器打开 http://127.0.0.1:8899
```

## IPC 协议（与 P0 一致）

`POST /ipc/invoke`

```json
// 请求
{ "cmd": "db_list_connections", "args": {} }

// 成功
{ "ok": true, "data": [...] }

// 失败（HTTP 仍 200，与 Tauri invoke 语义一致：由 ok:false 表达错误）
{ "ok": false, "error": "[NotFound] SSH 连接不存在" }
```

`WS /ipc/events`（帧格式）

```json
{ "event": "terminal-output", "payload": { "session_id": "term-1", "data": "<base64>" } }
```

## 已验证链路（真实可信，非纸上谈兵）

### P0 终端（回归）

- [x] `list_shells` → 返回本机 bash 列表
- [x] `create_terminal` → `term-1`
- [x] `write_terminal`（`echo hello p1`）→ OK
- [x] `terminal_snapshot` → 快照含 `hello p1`
- [x] `close_terminal` → OK
- [x] WS 订阅 `terminal-output` → 实时收到事件帧

### P1 数据库（SQLite 全链路实测）

- [x] `db_save_connection` → 保存连接（写回 connections.json）
- [x] `db_list_connections` → 返回 `[本地测试库]`
- [x] `db_test_connection` → `3.46.0`（SQLite 版本）
- [x] `db_list_tables` → `["users"]`
- [x] `db_preview_table` → columns `[id, name, age]`，3 行
- [x] `db_count_table` → `3.0`
- [x] `db_execute_query`（`SELECT * FROM users`）→ 3 行
- [x] `db_delete_connection` → OK

### P1 SSH / Docker（错误路径 + 状态）

- [x] `ssh_list_connections` → `[]`（无配置时）
- [x] `ssh_connect_connection`（不存在连接）→ `[NotFound] SSH 连接不存在`
- [x] `ssh_write`（不存在会话）→ `[NotFound] SSH 会话不存在`
- [x] `docker_list_connections` → `[]`（本地无 Docker）
- [x] `docker_get_local_engine_status` → `{ installed: false, ... }`
- [x] `docker_list_containers`（无 Docker）→ `无法连接本地 Docker Engine`

### P1 鉴权

- [x] `/ipc/invoke` 无 key / 错误 key → `401`
- [x] `/ipc/invoke` 带 key → `200`
- [x] `WS /ipc/events` 无 token → 拒绝（InvalidStatus）
- [x] `WS /ipc/events` 带 token → 连接成功

### 构建

- [x] `cargo check -p omnipanel-server` 零警告
- [x] `cargo build -p omnipanel-server` 成功
- [x] 前端 `tsc -b` 通过
- [x] `vite build` 通过（默认 Tauri 态 + `OMNIPANEL_WEB=1` Web 态）

## 边界与后续（诚实说明）

1. **语义变化**：Web 模式下本地终端/文件/Docker 操作发生在**服务端所在机器**，
   而非用户浏览器所在机器——这正是「服务器版控制台」想要的，但产品上需明确。
2. **多窗口/跨窗口拖拽**：Web 单窗口下自然降级，功能不缺失、体验有差异。
3. **P1 覆盖核心只读 + 会话链路**：Docker 的镜像 / 卷 / 网络 / exec / compose / 日志流，
   SSH 的 tmux 复用、SFTP、系统监控，DB 的 schema introspect / 事务会话 / 导出等
   仍按 `ipc.rs` 的 match 渐进接入（P2）。
4. **Vault（keyring）**：Web 端无头服务器环境依赖系统钥匙串；若 keyring 不可用
   则 Vault 读写会失败（连接凭据无法持久化）。这是桌面端同一依赖，产品上可
   为 Web 部署提供文件式 fallback（P2）。
