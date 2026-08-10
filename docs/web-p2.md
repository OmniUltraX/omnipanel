# OmniPanel Web 化（P2：Docker 全量 / AI 对话流 / 文件管理 / 无头部署）

> Issue #6「改造成 web 端，前后端分离」的 P2 落地说明。延续 P0/P1「不改业务代码、
> 只换传输层」的路线：浏览器与桌面共用同一套前端产物、同一个 Rust 后端能力。

## P0 / P1（已完成，PR #7）

- P0：本地终端链路 + IPC transport shim + HTTP/WS 桥 + 静态托管
- P1：DB / SSH / Docker 核心只读 + 会话链路 + API Key 鉴权

## P2 新增（本阶段）

### 1. Docker 全量命令（`crates/omnipanel-server/src/docker_ops.rs`）

延续 P1「复用 `omnipanel-docker` 领域 crate」路线，补齐写操作与全部资源命令：

| 分类 | 命令 |
|---|---|
| 容器 | `docker_list_container_stats` / `docker_inspect_container` / `docker_container_action` / `docker_container_logs` / `docker_clear_container_logs` / `docker_list_container_log_infos` / `docker_create_container` |
| 镜像 | `docker_list_images` / `docker_remove_image` / `docker_inspect_image` / `docker_image_history` / `docker_prune_images` / `docker_search_images` / `docker_prune_build_cache` / `docker_tag_image` / `docker_pull_image` / `docker_push_image` / `docker_build_image` / `docker_host_run_cli` |
| 卷 | `docker_list_volumes` / `docker_create_volume` / `docker_remove_volume` / `docker_inspect_volume` / `docker_prune_volumes` |
| 网络 | `docker_list_networks` / `docker_create_network` / `docker_remove_network` / `docker_prune_networks` / `docker_inspect_network` / `docker_connect_network` / `docker_disconnect_network` |
| Compose | `docker_list_compose_projects` / `docker_compose_action` / `docker_read_compose_files` / `docker_write_compose_files` |
| daemon | `docker_read_daemon_config` / `docker_write_daemon_config` / `docker_restart_daemon` / `docker_start_local_engine` / `docker_get_system_disk_usage` |
| 容器内文件 | `docker_list_container_dir` / `docker_read_container_file` / `docker_write_container_file` / `docker_list_volume_dir` / `docker_read_volume_file` |
| 交互终端 | `docker_exec_command`（一次性）/ `docker_create_exec_session` / `docker_create_host_shell_session` / `docker_exec_write` / `docker_exec_resize` / `docker_exec_close` |

### 2. Docker 流式（日志 / stats / 进度 → WS 事件）

- `docker_stream_container_logs` → `docker-log` / `docker-log-end` 事件
- `docker_stream_stats` → `docker-stats` / `docker-stats-end` 事件
- `docker_pull_image` / `docker_push_image` / `docker_build_image` / `docker_host_run_cli`
  的进度回调 → **Channel 帧**（等价桌面端 `progress_channel`）

**Channel 帧协议**（新增通用能力）：

```
WS 帧: { "event": "@channel", "payload": { "channelId": "42", "payload": <原回调负载> } }
```

前端 `@tauri-apps/api/core` 的 Web shim 中，`Channel` 构造时向 `@channel` 订阅并按
`channelId` 分发到 `onmessage`——桌面端 `Channel` 语义完全一致，业务代码零改动。

### 3. AI 对话流（`crates/omnipanel-server/src/ai.rs`）

- `ai_chat_stream`：复用 `omnipanel-ai::InternalOrchestrator`（与桌面端同一套推理编排），
  支持 **HTTP 后端（OpenAI / Anthropic 兼容）流式对话**，事件经 Channel 帧回传。
  请求体与桌面端完全同构：`{ request: <InternalChatRequestDto>, onEvent: <channelId> }`。
- `ai_chat_cancel`：按 conversation_id 置位取消标志。
- `ai_http_stream_post`：流式 HTTP 代理（绕过浏览器 CORS，由服务端发起到任意 URL）。

**诚实边界**：
- ACP / CLI 后端（依赖本地 Agent 进程）在 Web 端返回明确错误。
- MCP 工具执行依赖桌面端 `ToolExecutor`，Web 端暂不注入工具（`tools_mode` 被忽略，
  以 `pure_text` 语义直接推理）；工具面能力在后续版本接入。
- RAG / Skills 注入复用 `omnipanel-store`（与桌面端共用同一份配置与知识库）。

### 4. 文件管理器（`crates/omnipanel-server/src/files.rs`）

- 协议：**本机文件系统 + SFTP**（复用 `omnipanel-ssh::SshSession` 的 SFTP 能力，
  连接配置复用 `omnipanel-store` 存储 + Vault 凭据注入，含绑定 SSH 连接复用）。
- 命令：`file_list_connections` / `file_list_dir` / `file_read_file` / `file_upload_file` /
  `file_mkdir` / `file_rename` / `file_delete` / `file_local_quick_paths` /
  `file_local_system_info` / `file_upload_local_bytes` / `file_download_file`。
- 跨连接传输引擎（fastpath / remote-direct / relay + 断点续传）体量较大且深度依赖桌面端
  `AppState`/`AppHandle`，P2 先提供本机↔SFTP 的单向传输，relay 在后续版本接入。
- FTP / S3 协议依赖桌面端 `suppaftp` / `rust-s3`，本 crate 未引入，返回明确错误。

### 5. Vault 文件式 fallback（无头服务器关键能力）

`omnipanel-store::Vault` 现在支持**系统钥匙串 → 本地文件**自动降级：

- keyring 后端初始化失败（无 D-Bus / 无桌面会话）或操作报后端不可用错误时，
  自动把凭据读写到 `~/.omnipd/secrets/<ref>.secret`（Unix 下权限 0600）。
- `NoEntry` 不降级（后端正常只是没这条凭据），保持 NotFound 语义。
- 桌面端不受影响（钥匙串可用时永远走钥匙串）。

**这解决了 P1 遗留问题**：Web 无头服务器（容器 / 无桌面环境）下连接凭据无法持久化。

### 6. 生产部署样例（`deploy/`）

- `deploy/omnipanel-web.service`：systemd 单元（普通用户运行、环境文件读 API Key、
  安全加固、重启策略）
- `deploy/omnipanel-web.env.example`：API Key 环境文件模板（chmod 600）

```bash
# 构建 Web 版
cd frontend && OMNIPANEL_WEB=1 npm run build && cd ..
cargo build --release -p omnipanel-server

# 安装到 /opt/omnipanel/，然后：
sudo cp deploy/omnipanel-web.service /etc/systemd/system/
sudo mkdir -p /etc/omnipanel
sudo cp deploy/omnipanel-web.env.example /etc/omnipanel/omnipanel-web.env
# 编辑 env 填入随机 key：openssl rand -hex 32
sudo systemctl daemon-reload && sudo systemctl enable --now omnipanel-web
```

**生产建议**：`--bind 127.0.0.1` + 前置反代（Caddy / nginx）终止 TLS，
`VITE_OMNIPANEL_API_KEY=<key>` 注入前端构建产物（与 `--api-key` 一致）。

## IPC 协议（与 P0/P1 一致）

`POST /ipc/invoke`：

```json
// 请求
{ "cmd": "docker_list_images", "args": { "connectionId": "docker-local" } }

// 成功
{ "ok": true, "data": [...] }

// 失败（HTTP 仍 200，与 Tauri invoke 语义一致：由 ok:false 表达错误）
{ "ok": false, "error": "[NotFound] 连接不存在" }
```

`WS /ipc/events`（帧格式）：

```json
// 命名事件（终端 / docker-log / docker-stats 等）
{ "event": "terminal-output", "payload": { "session_id": "term-1", "data": "<base64>" } }

// Channel 帧（AI stream / 镜像进度 / CLI 逐行）
{ "event": "@channel", "payload": { "channelId": "42", "payload": { ... } } }
```

## 已验证链路（真实可信，非纸上谈兵）

### P0 终端回归

- [x] `list_shells` / `create_terminal` / `write_terminal`（`echo hello-p2`）/ `terminal_snapshot` 含输出
- [x] WS 订阅 `terminal-output` → 实时收到事件帧

### P2 文件管理器（本机链路实测）

- [x] `file_list_connections` → 本机连接 online
- [x] `file_list_dir`（/tmp）→ 条目齐全（含权限/大小/时间）
- [x] `file_upload_local_bytes` → 上传成功 → `file_read_file` 读回字节一致
- [x] `file_mkdir` / `file_rename` / `file_delete` → 全通
- [x] `file_local_quick_paths` → home/desktop/documents/downloads

### P2 Channel 帧（`@channel`）

- [x] `ai_http_stream_post` 指向本地 mock SSE → 收到 `chunk` 帧 + `done` 帧（channelId 42）
- [x] `ai_chat_stream` 指向本地 mock OpenAI 端点 → 收到 `content_delta` × 2 + `done`（stop_reason）

### P2 AI 错误路径

- [x] `ai_chat_stream`（acp backend）→ `Web 端暂不支持 backend: acp:...`
- [x] `ai_chat_cancel` → OK

### P2 Docker（本环境无 Docker，验证错误路径）

- [x] `docker_get_local_engine_status` → `{ installed: false, ... }`
- [x] `docker_list_containers` / `docker_list_volumes` / `docker_exec_command`（本地无 Engine）→ 合理报错

### P2 Vault 文件 fallback（headless 实测）

- [x] keyring 不可用（无 D-Bus）时 `Vault::store/get/delete` → 文件 `~/.omnipd/secrets/` 读写成功
- [x] 权限 0600、删除后再次读取 → NotFound

### 构建

- [x] `cargo check/build -p omnipanel-server` 零警告
- [x] `cargo check -p omnipanel-store` / `-p omnipanel-gateway`（Vault 改动不影响桌面链路）
- [x] 前端 `tsc -b` 通过
- [x] `vite build` 通过（默认 Tauri 态 + `OMNIPANEL_WEB=1` Web 态）

## 边界与后续（诚实说明）

1. **语义变化**：Web 模式下本地终端/文件/Docker 操作发生在服务端所在机器，
   这正是「服务器版控制台」想要的行为，但产品上需明确。
2. **AI 工具面**：Web 端 AI 暂不支持 MCP 工具执行（依赖桌面端 ToolExecutor）；
   纯文本 / HTTP 流式对话已可用。后续可把工具执行下沉到 `omnipanel-*` crate。
3. **文件传输**：P2 提供本机↔SFTP 单向传输；跨连接 relay / 断点续传 / FTP / S3
   在后续版本接入。
4. **多窗口/跨窗口拖拽**：Web 单窗口下自然降级，功能不缺失、体验有差异。
