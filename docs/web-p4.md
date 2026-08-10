# OmniPanel Web 化（P4：S3 分块传输 + 外部 MCP 服务桥接）

> Issue #6「改造成 web 端，前后端分离」的 P4 落地说明。延续 P0→P3「不改业务代码、
> 只换传输层」的路线，补齐上一阶段诚实说明的两个剩余边界：
>
> 1. **S3 relay 内存级中转**（大对象受服务端内存限制）→ 改为**分块流式**；
> 2. **外部 MCP 服务未接入**（设置页 MCP 管理与 AI 工具面外部工具在 Web 端不可用）→
>    桥接 `omnipanel-mcp::McpManager`。

## P4-A：S3 分块上传 / Range 下载（流式，不整载进内存）

### 后端（`crates/omnipanel-s3` + `crates/omnipanel-server`）

**`omnipanel-s3` 新增能力（双路径：rust-s3 / 阿里云·七牛 SigV4 自签）：**

| API | 说明 |
|---|---|
| `initiate_multipart_upload(key)` | `POST /?uploads` → UploadId |
| `upload_part(key, part_number, upload_id, data)` | `PUT ?partNumber&uploadId` → ETag |
| `complete_multipart_upload(key, upload_id, parts)` | `POST ?uploadId` + CompleteMultipartUpload XML |
| `abort_multipart_upload(key, upload_id)` | `DELETE ?uploadId`（失败自动清理残留） |
| `upload_object_multipart(key, data, chunk_size)` | 分块上传整份数据（单块最小 1MB，失败自动 abort） |
| `get_object_range(key, start, end)` | Range GET（供流式下载 / 断点续传；416 视为读尽返回空） |

- 单测 11 个全过 + mock S3 实测 3 条链路（CRUD / multipart 6MB·6 片 / abort 后 404）。

**`omnipanel-server` 文件链路（`files.rs` / `transfer.rs`）：**

- `file_upload_file` S3 路径：`≥8MB` 自动走 multipart 分块，小文件单 PUT（行为不变）。
- 新增 `file_upload_local_path_multipart`：把本地文件**分块读**（不整载进内存）上传到 S3。
- 新增 `file_download_s3_range_to_file`：按 Range **分块写**本地文件（不整载进内存）。
- relay 升级为流式：
  - `local/SFTP ↔ S3`：S3 侧走分块上传 / Range 分块下载（temp 中转文件，不再整载内存）；
  - `S3 ↔ S3` 跨桶回落：同样经 temp 文件流式中转（同桶仍优先服务端拷贝）。

### mock 服务器（`docs/web/mock_s3_server.py`）

新增 multipart（Initiate / UploadPart / Complete / Abort）与 Range GET / 416 支持，
回归资产 `crates/omnipanel-server/examples/verify_s3_multipart.rs`（16MB 分块上传 +
Range 下载全链路）。

## P4-B：外部 MCP 服务桥接（Web 端）

### 后端（`crates/omnipanel-server/src/mcp.rs` + `terminal.rs`）

- `ServerState` 新增 `mcp_manager`（懒初始化 `McpManager::bootstrap`，幂等）。
- 新增 `mcp_*` IPC 命令（与桌面端 `src-tauri/src/commands/mcp.rs` 语义一致）：

| 命令 | 说明 |
|---|---|
| `mcp_list_services` | 服务列表（内置 OmniMCP + 自定义） |
| `mcp_upsert_service` | 新增/更新（stdio / SSE） |
| `mcp_delete_service` | 删除（内置不可删） |
| `mcp_set_service_enabled` / `mcp_set_service_running` | 启用 / 运行状态 |
| `mcp_list_service_tools` / `mcp_call_tool` | 工具列表 / 调用 |

- **AI 工具面注入**：`ai_chat_stream` 的 DirectInject 在无模块过滤（master / web）时，
  把启用中的外部 MCP 工具并入工具面（`extmcp::{service_id}::{tool}`）。
- **执行器桥接**：`ServerToolExecutor` 对 `extmcp::*` 名称走
  `McpManager::call_service_tool` 桥接执行（服务端自执）。

### 前端

设置页 MCP 管理（`stores/mcpServicesStore.ts` + `McpServicesSection`）调用的
`mcp_*` 命令在 Web 模式经 `POST /ipc/invoke` 分发，浏览器下可直接管理外部 MCP 服务。

### mock 服务器（`docs/web/mock_mcp_server.py`）

MCP Streamable HTTP 子集（initialize / tools/list / tools/call），回归资产
`crates/omnipanel-server/examples/verify_mcp_web.rs`：注册 → 列工具 → 调用 →
工具面注入 → 执行器桥接 → 删除，全链路实测通过。

## 验证（真跑过，不是纸上谈兵）

| 链路 | 结果 |
|---|---|
| `omnipanel-s3` 单测（XML 解析 / 供应商识别 / SigV4 向量 / 凭据校验 / ETag 转义） | ✅ 11 全过 |
| mock S3：multipart 6MB·6 片上传 → 读回一致 → Range 下载 → abort 404 | ✅ 3 条 live 全过 |
| Web 端 `verify_s3_multipart`：16MB 分块上传 + Range 分块下载回写一致 | ✅ |
| relay：local↔S3 / S3↔S3（升级流式后回归） | ✅ 全过 |
| mock MCP：注册 SSE 服务 → 列工具 → `mcp_call_tool` → 工具面注入 → 执行器桥接 | ✅ 全过 |
| `cargo check`（server / s3 / mcp / ai 零警告）+ `tsc -b` + `vite build`（双态） | ✅ 全过 |

## 诚实说明的剩余边界

1. **S3 SigV4 路径分块无真实云端实测**：阿里云 / 七牛的分块语义与标准 S3 一致
   （`?uploads` / `?partNumber&uploadId` / CompleteMultipartUpload XML），
   签名算法复用桌面端已验证实现；真机若遇 `SignatureDoesNotMatch`，
   错误信息带完整签名对照现场可自查（沿用 P3-C 的诊断设施）。
2. **外部 MCP 调用 Web 端直接执行、不弹审批**：与桌面端「外部工具需审批」开关默认关
   时的行为一致；设置页审批开关依赖 Tauri AppState，Web 端未接入，
   建议部署方以 `--api-key` + TLS 反代保护（同 P3 危险操作语义）。
3. **S3 relay 仍经服务端临时文件中转**（分块读写，不整载内存但占磁盘临时空间）；
   RemoteDirect / FastPath（两远端直连、S3 同桶服务端拷贝）不受影响。
4. **`omnipanel-mcp` 既有单测 `omni_module::parses_tool_module_key` 失败为存量问题**
   （`omni_ssh_exec` 按前缀解析为 `ssh`，而 spec 的 module_key 为 `terminal`），
   与 P4 改动无关，未纳入本次修复范围。

## 启动方式（同前）

```bash
cd frontend && OMNIPANEL_WEB=1 npm run build && cd ..
cargo run -p omnipanel-server -- --static-dir frontend/dist --port 8899
# 浏览器打开 http://127.0.0.1:8899
```
