# OmniPanel Web 化（P0：前后端分离）

> Issue #6「改造成 web 端，前后端分离」的 P0 落地说明。

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

## 新增/改动文件

### 后端（Rust）

| 文件 | 说明 |
|---|---|
| `crates/omnipanel-server/`（新增） | Web 服务端 crate |
| `crates/omnipanel-server/src/server.rs` | axum 路由：`/ipc/invoke`、`WS /ipc/events`、静态托管、健康检查 |
| `crates/omnipanel-server/src/ipc.rs` | `{ cmd, args }` → 命令分发（等价 Tauri `invoke`） |
| `crates/omnipanel-server/src/terminal.rs` | P0 终端会话：create/write/resize/close/snapshot/list_shells |
| `crates/omnipanel-server/src/bus.rs` | 事件总线（替代 `app.emit_all`） |
| `crates/omnipanel-server/src/ws.rs` | WS 订阅升级 + 事件转发 |
| `crates/omnipanel-core/src/output_buffer.rs`（新增） | 输出缓冲下沉到 core，Tauri/Web 共用 |
| `src-tauri/src/output_buffer.rs` | 改为转发到 omnipanel-core（桌面端零行为变化） |
| `Cargo.toml` | workspace 新增 `crates/omnipanel-server` |

### 前端（TypeScript/React）

| 文件 | 说明 |
|---|---|
| `frontend/src/ipc/transport.ts`（新增） | Web IPC 传输层：`webInvoke`（HTTP）+ WS 事件总线 |
| `frontend/src/shims/tauri/`（新增） | `@tauri-apps/api` 的浏览器 shim（core/event/window/dpi/menu/tray/app） |
| `frontend/vite.config.ts` | `OMNIPANEL_WEB=1` 时把 `@tauri-apps/api/*` alias 到 shim |

**桌面端零影响**：vite alias 仅 `OMNIPANEL_WEB=1` 时生效，Tauri 构建走真实 `@tauri-apps/api`，
`tauri build` / `tauri dev` 行为完全不变。

## 启动方式

```bash
# 1. 构建 Web 版前端
cd frontend && OMNIPANEL_WEB=1 npm run build && cd ..

# 2. 启动服务端
cargo run -p omnipanel-server -- --static-dir frontend/dist --port 8899

# 3. 浏览器打开 http://127.0.0.1:8899
```

## IPC 协议

`POST /ipc/invoke`

```json
// 请求
{ "cmd": "create_terminal", "args": { "cols": 120, "rows": 40, "shell": null } }

// 成功
{ "ok": true, "data": "term-1" }

// 失败（HTTP 仍 200，与 Tauri invoke 语义一致：由 ok:false 表达错误）
{ "ok": false, "error": "Terminal session term-1 not found" }
```

`WS /ipc/events`（帧格式）

```json
{ "event": "terminal-output", "payload": { "session_id": "term-1", "data": "<base64>" } }
```

## P0 已验证链路

- [x] `list_shells` → 返回本机 shell 列表
- [x] `create_terminal` → 创建本地 PTY
- [x] `write_terminal` → 写入命令
- [x] `terminal_snapshot` → 快照含屏幕内容
- [x] `close_terminal` → 关闭会话 + 清理缓冲
- [x] `WS /ipc/events` → 实时收到 `terminal-output` 事件
- [x] 错误路径：未知命令 / 写入已关闭会话
- [x] 前端 `tsc -b` 通过（桌面与 Web 两态）
- [x] `vite build` 通过（默认 Tauri 态 + `OMNIPANEL_WEB=1` Web 态）

## 边界与后续（P1/P2）

1. **语义变化**：Web 模式下本地终端/文件/Docker 操作发生在**服务端所在机器**，而非用户浏览器所在机器——这正是「服务器版控制台」想要的，但产品上需明确。
2. **多窗口/跨窗口拖拽**：Web 单窗口下自然降级，功能不缺失、体验有差异。
3. **P1**：Docker/SSH/DB 模块命令接入（`ipc.rs` 的 match 按模块扩展）+ API Key 鉴权（复用 gateway 的 `api_key` 模式）。
4. **P2**：AI stream Channel、文件传输大文件优化、生产部署（TLS/反代/systemd）。
