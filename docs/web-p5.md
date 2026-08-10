# OmniPanel Web 化（P5：S3 服务端分片复制 + 外部 MCP 工具审批接入）

> Issue #6「改造成 web 端，前后端分离」的 P5 落地说明。延续 P0→P4「不改业务代码、
> 只换传输层」的路线，补齐上一阶段诚实说明的两个剩余边界：
>
> 1. **S3 relay 走内存级 get/put**（同桶复制需本机中转，大对象受内存限制）→
>    改为**服务端分片复制（UploadPartCopy）**，完全不经本机；
> 2. **外部 MCP 调用 Web 端直接执行、不弹审批**（与桌面端「外部工具需审批」默认关
>    时的行为不一致）→ 接入**审批闭环**，默认与桌面端一致需审批。

## P5-A：S3 服务端分片复制（UploadPartCopy，完全不经本机）

### 后端（`crates/omnipanel-s3`）

**`omnipanel-s3` 新增原语（双路径：rust-s3 / 阿里云·七牛 SigV4 自签）：**

| API | 说明 |
|---|---|
| `upload_part_copy(key, part_number, upload_id, copy_source, copy_range)` | 服务端分片复制：`x-amz-copy-source` + `x-amz-copy-source-range`，把源对象某字节范围复制为一个分片，**不经本机**（服务端直传），返回 ETag。rust-s3 路径复用 `put_multipart_chunk` 加额外 header 实现。 |
| `copy_object_multipart(from_key, to_key, object_size, part_size)` | 大对象分片复制：先 `initiate_multipart_upload`，逐片 `upload_part_copy`（默认 8MB，单分片最小 5MB），失败自动 `abort_multipart_upload`。规避 S3 单次 CopyObject 的 5GB 上限。 |
| `head_object_size(key)` | HEAD 对象返回 `Content-Length`（字节）；对象不存在时报错。 |

- 单测 11 个全过 + mock S3 实测（含 UploadPartCopy / copy-range / 416）。

**`omnipanel-server` 文件链路（`files.rs`）：**

- 新增 **`file_s3_copy_object`** IPC（同一 S3 连接内 `fromPath` → `toPath`，完全不经本机）：
  - 小对象（≤5GB 且单次 CopyObject 成功）走 `copy_object_internal` 单次服务端拷贝；
  - 大对象 / SigV4 路径（阿里云 / 七牛单次 CopyObject 本身不支持）走
    `copy_object_multipart` 分片直传；
  - 无法 HEAD（拿不到大小）时兜底走单次拷贝。
- 返回复制后的对象大小（字节）。

### mock 服务器（`docs/web/mock_s3_server.py`）

扩展支持 `UploadPartCopy`（`x-amz-copy-source` 可选 + `x-amz-copy-source-range`，
`bytes=start-end`，越界返回 416）。回归资产
`crates/omnipanel-server/examples/verify_s3_copy.rs`：上传 8MB 源对象 → 服务端复制
src → dst → 读回校验内容与长度一致 → 小对象单次拷贝路径也验证。

## P5-B：外部 MCP 工具审批接入（Web 端）

把上阶段「Web 端外部 MCP 直接执行、不弹审批」的边界闭环，使 Web 端行为**与桌面端
一致**（默认需审批）。

### 后端（`crates/omnipanel-server/src/terminal.rs` / `ai_tools.rs` / `mcp.rs` / `ai.rs`）

- `ServerState` 新增：
  - `mcp_external_require_approval: AtomicBool`（**默认 true，与桌面端一致**）；
  - `pending_internal_tool_results`：`conversation_id:tool_call_id → oneshot` 审批通道表。
- `ServerToolExecutor` 新增 `with_conversation(conversation_id)` 绑定会话 id，对外部
  MCP 工具：
  - **开启审批**（默认）：注册 pending 通道 → 经事件总线广播 `tool-approval-required`
    （含 `conversationId` / `toolCallId` / `toolName` / `arguments`）→ 浏览器收到后调
    `ai_chat_tool_result` 回传 `approved` → **服务端自执**（浏览器只确认、不传执行结果）；
  - **关闭审批**：服务端直接 `call_service_tool` 自执（P4 原有路径）。
  - 拒绝返回明确错误；**超时（300s）** 从 pending 表移除并返回超时错误。
- `ai_chat_tool_result` 从 P3/P4 的「自执空操作」改为**真实回传审批结果**：
  从 `pending_internal_tool_results` 取出 oneshot 并 `send((result, approved))`。
- 新增 `mcp_set_external_require_approval(require)` IPC，等价桌面端
  `ai_gateway_configure` 的 `mcp_external_require_approval` 参数。

### 前端

Web 端经 WS 事件总线收到 `tool-approval-required` 后弹出审批；`ai_chat_tool_result`
通过 `POST /ipc/invoke` 回传。审批 UI 复用既有 AI 审批组件（AiApprovalDock /
ApprovalDialog / actionDraftStore / toolGate）。

### 回归资产

`crates/omnipanel-server/examples/verify_mcp_approval.rs`：注册 mock MCP SSE 服务 →
开启审批 → 触发外部工具调用（应广播 `tool-approval-required` + 挂起等待）→
并发任务模拟浏览器批准（`approved=true`）→ 服务端自执返回结果 → 另一调用模拟拒绝
（`approved=false`）→ 返回拒绝 → 关闭审批后直接自执 → 清理服务。

## 验证（真跑过，不是纸上谈兵）

| 链路 | 结果 |
|---|---|
| `omnipanel-s3` 单测 11 个（XML / 供应商 / SigV4 向量 / 凭据 / ETag 转义 / 分片复制） | ✅ 全过 |
| live mock S3：8MB 对象分片复制（UploadPartCopy + copy-range）→ 读回内容一致 | ✅ |
| `verify_s3_copy`：大对象分片复制 + 小对象单次拷贝 | ✅ 全通 |
| `verify_mcp_approval`：批准→自执、拒绝→报错、关闭审批→直执、超时→报错 | ✅ 全通 |
| `verify_mcp_web` 回归（关闭审批直执路径） | ✅ 全通 |
| `cargo check/build`（server / s3 / mcp / ai 零警告）+ `tsc -b` + `vite build`（双态）+ `check:ipc-registry` | ✅ 全过 |

## 诚实说明的剩余边界

1. **S3 SigV4（阿里云 / 七牛）分片复制无真实云端实测**：本地 mock 不验签，签名算法
   复用桌面端已验证实现（`UploadPartCopy` 与标准 S3 语义一致）；真机若遇
   `SignatureDoesNotMatch`，错误信息带完整签名对照现场可自查。
2. **MCP 审批通过后由服务端自执**（浏览器只确认、不传回执行结果）；拒绝 / 超时返回
   明确错误。生产部署仍建议 `--api-key` + TLS 反代保护。
3. **S3 relay（跨桶 / 与 local/SFTP 的传输）仍经服务端临时文件中转**（分块读写，不占
   内存但占磁盘临时空间）；本阶段 `file_s3_copy_object` 为**同连接同桶**的服务端复制，
   RemoteDirect / FastPath 不受影响。
4. 存量 `ftp_web_test` 需外部 FTP 服务器（本环境未起），与本次改动无关。

## 启动方式（同前）

```bash
cd frontend && OMNIPANEL_WEB=1 npm run build && cd ..
cargo run -p omnipanel-server -- --static-dir frontend/dist --port 8899
# 浏览器打开 http://127.0.0.1:8899
```

## 回归验证方式

```bash
# 1) S3 服务端分片复制
python3 docs/web/mock_s3_server.py 19000
cargo run -p omnipanel-server --example verify_s3_copy

# 2) 外部 MCP 工具审批
python3 docs/web/mock_mcp_server.py 18080
cargo run -p omnipanel-server --example verify_mcp_approval
```
