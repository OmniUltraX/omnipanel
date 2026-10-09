# Agent Sidecar 协议（v1）

第三方 Agent 来源**不写进宿主进程**，也不要塞进 `logic.js` / WASM。写一个独立进程（任意语言，含 Rust）实现本协议即可。
宿主按 `plugin.json` 的 `runtime=sidecar` + `entry.driver` 拉起它，经 stdin/stdout 一行一条 JSON-RPC 调用。
崩溃只影响这个进程，不会拖垮主程序。

宿主仍然是 `InternalOrchestrator`：对话轮次、工具执行、审批、Skills、RAG 都不进插件。
插件只做三件事：读本机登录、拉模型目录、把**一轮**上游对话翻成宿主已经认识的事件。

单源实现：`crates/omnipanel-agent-proto`（信封）、`crates/omnipanel-agent-session`（服务端分发）、
`crates/omnipanel-ai/src/providers/agent_source/sidecar.rs`（宿主拉起与事件翻译）。
本文是面向第三方的人话版；冲突时以 Rust 单源为准。

官方示例是 `plugins/agent-cursor` 与 `plugins/agent-workbuddy`。可跑的最小样板是 `plugins-samples/agent-echo`。

## 和 logic.js / WASM 的关系

这三样不是上下层，是三条不同的路：

| | 谁在跑 | 适合什么 |
|---|---|---|
| `logic.js`（QuickJS） | 宿主进程里的沙箱 | 短调用，返回一份 JSON。IO 只走 `host.*` |
| `logic.wasm` | 同一个沙箱槽位 | 同上，只是换成 WASM |
| sidecar | 独立进程，stdin/stdout | 私有协议、长连接、HTTP/2、本机登录文件 |

`logic.js` 和 WASM **不会**再去启动 sidecar，sidecar 里也**不嵌** WASM。
云厂商那种一次 HTTP 换一份 JSON，继续用 L2。Cursor 这种要自己握 HTTP/2 流的，走 sidecar。

## 1. 传输

- `stdin` 读请求，`stdout` 写响应和流式事件，**一行一条 JSON**，UTF-8，`\n` 结尾。
- `stderr` 只打日志。`stdout` 上多一个 `console.log` 就会把协议流弄脏。
- JSON-RPC 2.0 信封。`chat` 进行中可以穿插没有 `id` 的通知 `chat_event`。

```json
{ "jsonrpc": "2.0", "id": 1, "method": "handshake", "params": {} }
{ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": 1, "engine": "echo", "capabilities": ["status", "catalog", "chat"] } }
{ "jsonrpc": "2.0", "id": 2, "error": { "code": -32000, "message": "未登录" } }
{ "jsonrpc": "2.0", "method": "chat_event", "params": { "id": 4, "event": { "type": "content_delta", "text": "hi" } } }
```

- 非法 JSON 回 `id: 0` 的 error，不挂断。
- 空行忽略。
- 一个进程同时只处理一个请求。宿主会串行调用。

## 2. 方法

| 方法 | params | result |
|---|---|---|
| `handshake` | `{}` | `{ "protocolVersion": 1, "engine": "<sourceId>", "capabilities": ["status","catalog","chat"] }` |
| `status` | `{ "proxy?": Proxy }` | `AgentSourceCard`。读缓存，不要为了展示再打一轮目录请求 |
| `catalog` | `{ "proxy?": Proxy }` | `AgentSourceCard`。重新读登录并刷新目录 |
| `chat` | `{ "model", "request", "proxy?" }` | 先发若干 `chat_event`，最后 `{ "ok": true }` |

未知方法回 error，不要静默成功。

`engine` 和卡片里的 `id` 必须等于清单 `contributes.agentSources[].id`。

### AgentSourceCard

字段名 camelCase。`account`、`tokenExpiresAtMs`、`error`、`models`、`credits` 可以省略。

```json
{
  "id": "echo",
  "title": "Echo",
  "signedIn": true,
  "account": "demo",
  "tokenExpiresAtMs": null,
  "catalogSource": "live",
  "error": null,
  "models": [{ "id": "echo-1", "name": "Echo", "credits": null, "badges": [] }]
}
```

- `catalogSource`：`none`（没有登录或没有目录）、`live`（刚从上游拉到）、或实现自己的缓存标记。
- 未登录时仍然回卡片，把原因放进 `error`，不要用 JSON-RPC error 代替「未登录」这种正常状态。
- 卡片里**不要**放 token、cookie、刷新密钥。

### chat

`request` 就是宿主的 `ChatRequest`：`model`、`messages`、`stream`、可选 `tools`。
消息 `role` 为 `user` / `assistant` / `system` / `tool`。带工具结果的消息用 `toolCallId`，模型上一轮的工具调用用 `toolCalls`。

`proxy` 是宿主设置里的代理，没有则为 `null`：

```json
{ "enabled": false, "protocol": "http", "host": "", "port": 0, "username": "", "password": "" }
```

插件用它访问**自己的上游**。回环地址不要走代理。

### chat_event

`params.id` 等于这次 `chat` 的请求 id。`params.event` 是宿主 `StreamEvent`，`type` 为：

| type | 字段 | 含义 |
|---|---|---|
| `content_delta` | `text` | 正文增量 |
| `reasoning_delta` | `text` | 推理增量 |
| `tool_call` | `id`, `name`, `arguments` | 模型要调用的工具。`arguments` 是 JSON 字符串 |
| `usage` | `input_tokens`, `output_tokens` | 用量 |
| `done` | `stop_reason` | `end_turn` / `tool_use` / `max_tokens` / `error` / `cancelled` / `refusal` |
| `error` | `message` | 这一轮失败 |

看到 `tool_call` 就结束这一轮（再补 `done`，`stop_reason` 用 `tool_use`）。
**不要自己执行工具。** 宿主跑完工具，会带着 `role: tool` 的消息再开一轮 `chat`。

## 3. 拉起规则（`entry.driver` 相对插件安装目录）

和数据库 sidecar 同一套：

| 后缀 | 宿主实际执行 |
|---|---|
| `.js` / `.mjs` | `node <driver>`（PATH 里要有 node） |
| `.jar` | `java -jar <driver>` |
| 其它（含无后缀 / `.exe`） | 直接执行该文件 |

Windows 上如果 driver 没有后缀，宿主还会再试同名 `.exe`。

官方 Cursor / WorkBuddy 不在「已安装插件」目录里。开发时宿主按这个顺序找二进制：

1. `OMNIPANEL_AGENT_CURSOR_BIN` / `OMNIPANEL_AGENT_WORKBUDDY_BIN`
2. 正在运行的 `omnipanel-app` 同目录
3. 仓库 `plugins/agent-*/<entry.driver>`（Windows 会补 `.exe`）
4. 仓库 `target/debug`，其次 `target/release`（若当前程序路径里有 `release` 则反过来）

```bash
cargo build -p omnipanel-agent-cursor -p omnipanel-agent-workbuddy
```

产物是 `target/debug/omnipanel-agent-cursor.exe` 与 `target/debug/omnipanel-agent-workbuddy.exe`（Windows）。
桌面开发版就在旁边，设置里刷新即可，不用先拷进 `bin/`。

发给别人的包把对应平台的二进制放进 `bin/`，`entry.driver` 指过去。每个平台打自己的包。

## 4. 安全

- 登录态只留在 sidecar 进程内存。不要写回宿主，不要打进 `status` / `catalog` / 错误信息，不要写日志。
- 插件不执行工具，不弹审批，不改用户工程。工具循环在宿主。
- 选择器里的 backend id 仍是 `http:{来源}::{模型}`。`cli:` / `acp:` 整轮外派已经去掉。

## 5. 自测

```bash
node scripts/check-agent-sidecar.mjs plugins-samples/agent-echo/bin/agent.mjs --source echo
node scripts/check-agent-sidecar.mjs --cmd "node plugins-custom/<mine>/bin/agent.mjs" --source <sourceId>
```

检查项：`handshake` 协议版本为 1 → `status` / `catalog` 是卡片且 `models` 为数组 →
`chat` 至少一条 `content_delta`，最后 `result.ok` → 未知方法回 error。

新插件：

```bash
node scripts/create-plugin.mjs <name> agent
node scripts/check-agent-sidecar.mjs plugins-custom/<name>/bin/agent.mjs --source <name>
```

脚手架给出的 `bin/agent.mjs` 会回一条假目录和一句假正文。换成真实上游后再打包。
Rust 官方示例的进程入口在 `plugins/agent-cursor/src-agent` 与 `plugins/agent-workbuddy/src-agent`，服务端循环可以复用 `omnipanel-agent-session::serve`。
