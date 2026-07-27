# 助手端：如何拉取 AI 助手聊天消息

OmniPanel 客户端在 AI 助手**流式生成**时，会把模型输出的**结构化事件**分片上传到阿里云 OSS。助手端按本文约定从 OSS 拉取并还原 parts。

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
- 时机：某次 AI 回复开始生成时开始录制；流式过程中**约每 5 秒**上传一次缓冲；本轮结束再 flush 剩余内容
- 内容：本轮用户消息（`user`）+ 流事件 NDJSON（思考 / 正文 / 工具），不是完整多轮会话库
- 凭证：客户端走 `POST /api/assistant/oss/sts` 申请的 STS，以 `text/plain; charset=utf-8` PUT

## 文件格式（`omni-chat-events.v1`）

UTF-8。前若干行为元数据注释，空行后为 **NDJSON**（每行一个 JSON 对象）：

```text
# conversation=conv_1785118483379_1
# written_at=2026-07-27T08:18:10.228Z
# file_id=0
# format=omni-chat-events.v1

{"v":1,"t":"user","text":"帮我检查一下服务器负载"}
{"v":1,"t":"reasoning","text":"先看一下资源占用…"}
{"v":1,"t":"content","text":"## 结论\n"}
{"v":1,"t":"content","text":"CPU 正常。\n"}
{"v":1,"t":"tool_call","id":"call_1","name":"omni_ssh_exec","arguments":"{\"cmd\":\"uptime\"}"}
{"v":1,"t":"tool_result","id":"call_1","status":"completed","result":" 12:00:01 up 10 days…"}
```

### 头注释

| 字段 | 含义 |
|---|---|
| `conversation` | 会话 id（与目录名一致） |
| `written_at` | 本分片写入时间（ISO-8601 UTC） |
| `file_id` | 分片序号，与文件名 `{n}.txt` 一致 |
| `format` | 正文协议；当前固定 `omni-chat-events.v1` |

无 `# format=` 的旧分片视为**纯文本遗留格式**（思考与正文未区分、无 Tools），可整段当作 `content` 展示。

### 事件行（`v: 1`）

| `t` | 字段 | 说明 |
|---|---|---|
| `user` | `text` | 本轮用户发送的完整消息（生成开始时写入一次，非整段增量） |
| `reasoning` | `text` | 思考 / 推理增量（可多行事件，按序拼接） |
| `content` | `text` | 助手对用户可见正文增量（Markdown） |
| `tool_call` | `id`, `name`, `arguments` | 工具调用；同 `id` 可能多次出现（arguments 流式补全），**以后者为准** |
| `tool_result` | `id`, `status`, `result?` | 工具状态更新；`status` 如 `pending` / `running` / `completed` / `failed`；同 `id` 可多次，按序应用 |
| `error` | `text` | 流错误文案 |

所有字符串字段均为 JSON 转义后的单行值（正文里的换行在 JSON 内为 `\n`）。

### 还原为 UI parts（建议）

1. 按 `file_id` 升序读完全部分片，去掉 `#` 头与空行，逐行 `JSON.parse`
2. 忽略未知 `t`（向前兼容），校验 `v === 1`
3. 按事件顺序构建 parts：
   - `user` → 用户气泡（通常每轮一条，在助手输出之前）
   - 连续的 `reasoning.text` → 合并为一个「思考」块（可折叠）
   - 连续的 `content.text` → 合并为一个 Markdown 正文块
   - `tool_call` → 插入 / 更新 Tools 列表项（按 `id`）
   - `tool_result` → 更新对应 `id` 的状态与结果
4. 最终顺序保留流式到达顺序（user → 思考 ↔ 正文 ↔ 工具可交错）

## 助手端推荐拉取流程

1. **定位用户前缀**  
   `agent_chat_message/{userKey}/`

2. **列出会话**  
   `ListObjectsV2`，`prefix = agent_chat_message/{userKey}/`，`delimiter = /`

3. **列出某会话分片**  
   `prefix = …/{sessionId}/`，过滤 `*.txt`，按数字排序

4. **读取并解析**  
   `GetObject` → 解析头 + NDJSON 事件 → 还原 parts

5. **增量同步（可选）**  
   记录已消费的最大 `file_id`；轮询间隔可略大于 5s。上传失败时客户端会回滚编号，偶发空洞可跳过或短暂重试。

## 权限建议

- 助手端使用服务端角色 / 长期密钥，只读 `agent_chat_message/` 前缀
- 不要依赖客户端 STS（临时、且面向上传）

## 与「元数据快照」的区别

| | 聊天消息分片（本文） | 客户端元数据快照 |
|---|---|---|
| 前缀 | `agent_chat_message/...` | `assistant/.../snapshots/...` |
| 内容 | 流事件 NDJSON | 连接/知识库等脱敏 JSON |
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
- 前端订阅与去重：`frontend/src/modules/assistant/chatInbox.ts`（按 `messageId` 本地去重，写入当前 AI 会话）

## 客户端实现索引

- 录制与编码：`frontend/src/lib/ai/chatOssRecorder.ts`
- 流式挂钩：`frontend/src/components/ai/assistant-ui/AiRuntimeProvider.tsx`
- STS 上传：`src-tauri/src/commands/assistant.rs` → `assistant_upload_oss_text`
- 入站收件：`src-tauri/src/commands/assistant_chat.rs` + `frontend/src/modules/assistant/chatInbox.ts`
