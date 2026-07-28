# 助手端：如何拉取 AI 助手聊天消息

OmniPanel 客户端在 AI 助手**流式生成**时，会把模型输出分片上传到阿里云 OSS。助手端按本文约定从 OSS 拉取并还原 UI。

> **2026-07-28 协议变更**：正文由 `omni-chat-events.v1`（NDJSON）改为 `omni-chat-sections.v1`（分隔符段落 + 上传前聚合）。下方「助手端迁移清单」是必改项。

## 助手端迁移清单（必读）

OSS **路径 / 桶 / 轮询策略不变**；需要改的是**读对象后的解析与渲染**。

### 1. 按 `# format=` 分支解析

读完对象后先扫头注释：

| `# format=` | 处理 |
|---|---|
| `omni-chat-sections.v1`（或无此行但正文含 `\|[…]\|` 分隔符） | **新协议**：按分隔符切段（下文） |
| `omni-chat-events.v1` | **旧协议**：逐行 `JSON.parse`，读 `t` / `text` 等（保留兼容） |
| 无 format 且无分隔符 / 无 `{` 行 | 整段当纯文本正文 |

**不要**再假定每行都是 `{"v":1,"t":"content","text":"…"}`。

### 2. 新协议解析（替换 NDJSON 循环）

分隔符三行一组，**必须精确匹配**（含横线数量与标签两侧 `|`）：

```text
----------------
|[TAG]|
----------------
<正文，可多行，直到下一个 ---------------- 或 EOF>
```

建议算法：

1. 跳过以 `#` 开头的头注释与紧随空行  
2. 扫描行：若当前行为 `----------------`，下一行为 `|[TAG]|`，再下一行又是 `----------------` → 开启一段  
3. 之后行写入该段 `body`，直到再次遇到 `----------------`（下一段开始）  
4. 未知 `TAG`：忽略该段（向前兼容）  
5. 按段顺序追加到 UI（不要把同一分片内已聚合的同类型再拆碎）

### 3. 标签映射（替换旧 `t` 字段）

| 新标签 `TAG` | 旧 NDJSON `t` | 正文形态 | UI 建议 |
|---|---|---|---|
| `user_message` | `user` | 纯文本 | 用户气泡 |
| `ai_reasoning` | `reasoning` | 纯文本（已聚合） | 可折叠思考 |
| `ai___message` | `content` | Markdown 纯文本（已聚合） | 助手正文 |
| `tool_calling` | `tool_call` | **多行 JSON**（每行一次调用） | 工具调用 |
| `tool___result` | `tool_result` | **多行 JSON**（每行一次结果） | 工具结果 |
| `error______` | `error` | 纯文本 | 错误提示 |

注意标签里的下划线数量是约定的一部分（如 `ai___message`、`tool___result`），匹配时用**全字相等**，不要用模糊包含。

### 4. 工具段 JSON 字段（section 内多行 JSON）

`tool_calling` / `tool___result` 的正文是 **NDJSON**：每行一个完整 JSON 对象，**不要**对整段 body 做一次 `JSON.parse`。

并行多个工具时，客户端会聚合成**同一个** section（只出现一次分隔符）：

```text
----------------
|[tool_calling]|
----------------
{"id":"call_00_…","name":"omni_docker_list_containers","arguments":"{\"connection_id\":\"docker-local\",\"filter\":\"all\"}"}
{"id":"call_01_…","name":"omni_docker_list_containers","arguments":"{\"connection_id\":\"docker-bound-…\",\"filter\":\"all\"}"}

----------------
|[tool___result]|
----------------
{"id":"call_00_…","status":"failed","result":"…"}
{"id":"call_01_…","status":"completed","result":"…"}
```

字段约定：

- `tool_calling` 行：`id` / `name` / `arguments`
- `tool___result` 行：`id` / `status` / `result?`
- `status`：`pending` / `running` / `completed` / `failed` 等
- **同 section 内同 `id`**：后写覆盖先写（流式补全 arguments 时只留最新一行）
- `tool_calling` 与 `tool___result` **不会**混在同一 section；中间若插入正文/思考会打断，新开 section
- **其它段落不要 `JSON.parse` 整段 body**（正文是裸文本 / Markdown）

助手端解析伪代码：

```text
for line in section.body.splitlines():
  if line.strip():
    obj = JSON.parse(line)
    upsert_tool_by_id(obj)
```

### 5. 增量语义（行为未变，实现可简化）

- 仍按 `{sessionId}/{n}.txt` 的 `n`（`file_id`）升序消费  
- 每个分片只含**自上次客户端 flush 以来**的新段落；同类文本在分片内已拼好，助手端**无需再按 chunk 拼接**同标签连续增量（同一分片内通常一段一个标签）  
- 跨分片：若后一片再次出现同标签，按顺序**追加**（思考/正文）或按 `id` **更新**（工具）

### 6. 自测建议

用新客户端打一轮含工具的对话，拉取最新 `*.txt`，确认：

- [ ] 头注释有 `# format=omni-chat-sections.v1`  
- [ ] 正文出现 `|[user_message]|` / `|[ai___message]|` 等，而不是 `"t":"content"`  
- [ ] 思考与正文已是整段，无海量单字符 JSON 行  
- [ ] 并行工具只有**一个** `|[tool_calling]|` section，body 内多行 JSON  
- [ ] 对工具 section **按行** `JSON.parse`，而非整段一次 parse  
- [ ] 旧会话（`omni-chat-events.v1`）仍能打开（若产品要求历史兼容）

### 7. 反向链路（助手 → 客户端）不受本次格式影响

助手端 **notify / 写 OSS 给客户端** 的协议不变（`POST /api/assistant/chat/notify` 等）。本次只改**客户端上行聊天分片**的正文格式。若助手写入站消息，建议正文用纯文本或带 `text`/`message` 字段的 JSON；客户端也会尝试解析分隔符里的 `user_message` / `ai___message`。

---

## 存储位置

| 项 | 值 |
|---|---|
| Bucket | `omniminiapp` |
| Region | `cn-beijing`（与助手 STS 一致） |
| Endpoint（虚拟主机） | `https://omniminiapp.oss-cn-beijing.aliyuncs.com` |

Object Key 规则（桶内路径，**不含** bucket 名）：

```text
agent_chat_message/{userKey}/{sessionId}/{n}.txt
```

- `{userKey}`：由账号服务在 `/api/me` 的 `oss_path` 中下发。常见形态：
  - `oss_path` = `omniminiapp/agent_chat_message/{userKey}`（客户端会去掉桶名前缀再上传）
  - 或直接 `agent_chat_message/{userKey}`
- `{sessionId}`：客户端会话 / conversation id（如 `conv_1785118483379_1`）；路径分隔符会被替换为 `_`
- `{n}`：从 `0` 起递增的分片编号：`0.txt`、`1.txt`、`2.txt`…

示例：

```text
agent_chat_message/oIbtz2Ycl6r9WuCxxeviTszMDtcg/conv_1785118483379_1/0.txt
agent_chat_message/oIbtz2Ycl6r9WuCxxeviTszMDtcg/conv_1785118483379_1/1.txt
```

## 何时写入

- 触发条件：用户已登录，且 `/api/me` 返回的 `oss_path` 非空
- 时机：某次 AI 回复开始生成时开始录制；流式过程中**约每 3 秒**上传一次缓冲；本轮结束再 flush 剩余内容
- 内容：上传前将同类增量**聚合**为分隔符段落（用户提问 / 思考 / 正文 / 工具），不是完整多轮会话库
- 凭证：客户端走 `POST /api/assistant/oss/sts` 申请的 STS，以 `text/plain; charset=utf-8` PUT

## 文件格式（`omni-chat-sections.v1`）

UTF-8。前若干行为元数据注释，空行后为**分隔符段落**（上传前已聚合，避免每条流式 chunk 各写一行 JSON）。

分隔符固定为：

```text
----------------
|[TAG____________]|
----------------
```

`TAG` 与 `chat_log.txt` 对齐约定一致（如 `ai___message`、`tool___result`）。

```text
# conversation=conv_1785118483379_1
# written_at=2026-07-27T08:18:10.228Z
# file_id=0
# format=omni-chat-sections.v1

----------------
|[user_message]|
----------------
帮我检查一下服务器负载

----------------
|[ai_reasoning]|
----------------
先看一下资源占用…

----------------
|[ai___message]|
----------------
## 结论
CPU 正常。

----------------
|[tool_calling]|
----------------
{"id":"call_1","name":"omni_ssh_exec","arguments":"{\"cmd\":\"uptime\"}"}
{"id":"call_2","name":"omni_docker_list_containers","arguments":"{\"filter\":\"all\"}"}

----------------
|[tool___result]|
----------------
{"id":"call_1","status":"completed","result":" 12:00:01 up 10 days…"}
{"id":"call_2","status":"failed","result":"Docker 未安装或未启动"}
```

### 头注释

| 字段 | 含义 |
|---|---|
| `conversation` | 会话 id（与目录名一致） |
| `written_at` | 本分片写入时间（ISO-8601 UTC） |
| `file_id` | 分片序号，与文件名 `{n}.txt` 一致 |
| `format` | 正文协议；当前固定 `omni-chat-sections.v1` |

| `# format=` | 说明 |
|---|---|
| `omni-chat-sections.v1` | 当前：分隔符段落 |
| `omni-chat-events.v1` | 旧：NDJSON 事件行（只读兼容） |
| （无 format） | 更旧的纯文本遗留，可整段当正文 |

### 段落标签

| 标签 | 正文 | 说明 |
|---|---|---|
| `user_message` | 纯文本 | 本轮用户提问（生成开始写入一次） |
| `ai_reasoning` | 纯文本 | 思考聚合 |
| `ai___message` | 纯文本 Markdown | 对用户可见正文聚合 |
| `tool_calling` | 多行 JSON（每行一次调用：`id` / `name` / `arguments`） | 连续并行调用并入同一 section；同 `id` 覆盖 |
| `tool___result` | 多行 JSON（每行一次结果：`id` / `status` / `result?`） | 同上；`status` 如 `pending` / `running` / `completed` / `failed` |
| `error______` | 纯文本 | 流错误 |

### 聚合规则（上传前）

1. 连续同类型文本增量合并为一段（多个 content chunk → 一个 `ai___message`）
2. 类型切换则新开一段（含 `tool_calling` ↔ `tool___result` 切换）
3. 连续的 `tool_calling`（或连续的 `tool___result`）并入**同一 section**：不同 `id` 各占一行 JSON；同 `id` 覆盖为最新快照
4. 每个分片只含**自上次 flush 以来**的新段落（增量）

### 还原为 UI parts（建议）

1. 按 `file_id` 升序读完全部分片，去掉 `#` 头
2. 按分隔符切段，识别 `| [TAG] |`；忽略未知标签
3. 按顺序构建：
   - `user_message` → 用户气泡
   - `ai_reasoning` → 思考块（可折叠）
   - `ai___message` → Markdown 正文
   - `tool_calling` → **按行** `JSON.parse`，按 `id` 插入/更新工具项
   - `tool___result` → **按行**解析，更新对应 `id` 的状态与结果
4. 若遇到旧 `omni-chat-events.v1`，按 NDJSON `t` 字段解析（见历史实现）

## 助手端推荐拉取流程

1. **定位用户前缀**  
   `agent_chat_message/{userKey}/`

2. **列出会话**  
   `ListObjectsV2`，`prefix = agent_chat_message/{userKey}/`，`delimiter = /`

3. **列出某会话分片**  
   `prefix = …/{sessionId}/`，过滤 `*.txt`，按数字排序

4. **读取并解析**  
   `GetObject` → 解析头 + 分隔符段落 → 还原 parts

5. **增量同步（可选）**  
   记录已消费的最大 `file_id`；轮询间隔可略大于 3s。上传失败时客户端会回滚编号，偶发空洞可跳过或短暂重试。

## 权限建议

- 助手端使用服务端角色 / 长期密钥，只读 `agent_chat_message/` 前缀
- 不要依赖客户端 STS（临时、且面向上传）

## 与「元数据快照」的区别

| | 聊天消息分片（本文） | 客户端元数据快照 |
|---|---|---|
| 前缀 | `agent_chat_message/...` | `assistant/.../snapshots/...` |
| 内容 | 分隔符聚合段落 | 连接/知识库等脱敏 JSON |
| 上传命令 | `assistant_upload_oss_text` | `assistant_push_snapshot` |

## 反向：助手 → 客户端消息

助手端把消息写入用户 `oss_path` 下对象后，调用服务端 notify；客户端通过 latest / SSE 拿到索引再读 OSS。

### 流程

1. 助手写 OSS：`{oss_path}{file}`（`object_key` 必须落在当前用户 `oss_path` 下）
2. 助手 `POST /api/assistant/chat/notify` → Redis `latest` + Pub/Sub
3. 客户端 `GET /api/assistant/chat/latest` 和/或 `GET /api/assistant/chat/wait`（SSE：`ping` / `message` / `fail`）拿到 `objectKey`，再 STS GET 读对象

### 接口

| 方法 | 路径 | 角色 | 说明 |
|------|------|------|------|
| POST | `/api/assistant/chat/notify` | assistant | 上报已写 OSS |
| GET | `/api/assistant/chat/latest` | client | 读最近一条索引 |
| GET | `/api/assistant/chat/wait` | client | SSE 推送新索引 |

**notify body 示例：**

```json
{
  "object_key": "agent_chat_message/{union_id}/msg-001.json",
  "message_id": "msg-001",
  "created_at": "2026-07-27T10:00:00Z"
}
```

无 `union_id` / `oss_path` → `409`。

**Redis：**

- Key：`omni:chat:latest:{userId}`（TTL 7 天）
- Channel：`omni:chat:{userId}`

**索引 JSON：** `userId`、`objectKey`、`ossPath`、`messageId`、`createdAt`、`publishedAt`、助手设备信息。

### 客户端实现

- 后端收件箱：`src-tauri/src/commands/assistant_chat.rs`（`assistant_chat_inbox_start` / `stop` / `latest` / `fetch_object`）
- App Event：`assistant-chat-inbound`（见 `frontend/src/ipc/events.ts`）
- 前端订阅与去重：`frontend/src/modules/assistant/chatInbox.ts`（按 `messageId` 本地去重，经 `sendToAiDock` 写入用户消息并触发 AI 生成）

## 客户端实现索引

- 录制与编码：`frontend/src/lib/ai/chatOssRecorder.ts`
- 流式挂钩：`frontend/src/components/ai/assistant-ui/AiRuntimeProvider.tsx`
- STS 上传：`src-tauri/src/commands/assistant.rs` → `assistant_upload_oss_text`
- 入站收件：`src-tauri/src/commands/assistant_chat.rs` + `frontend/src/modules/assistant/chatInbox.ts`
