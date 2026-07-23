# Assistant 模块：客户端 → 助手端 OSS 元数据快照

> 状态：设计已确认（2026-07-23）  
> 第一期范围：客户端采集脱敏元数据并上传 OSS；助手端通知/拉取协议后补。

## 背景与目标

客户端与助手端已通过账号服务完成设备绑定。为让助手端感知客户端工作区资源，使用 **OSS + 临时 STS** 传输各业务模块的**对象元数据**（非任意文件、不含密钥）。

**第一期成功标准**

- 用户可手动触发「推送快照」
- 生成单一 `snapshot.json` 并成功 PUT 到 OSS
- 返回 `objectKey` / 大小 / 时间供 UI 展示
- 敏感字段（密码、私钥、Token 等）绝不进入快照

**第一期明确不做**

- 助手端拉取 / SSE 通知 / `latest` pointer
- 双向同步、冲突合并
- 分模块增量 object
- 密钥或可连资源的凭据下发

## 架构

| 层 | 位置 | 职责 |
|---|---|---|
| 传输内核 | `crates/omnipanel-assistant` | STS、OSS PUT、快照序列化、Collector 注册与编排 |
| Tauri 薄壳 | `src-tauri/src/commands/assistant.rs` | 注入本机只读数据到 `CollectContext`，调用 `push` |
| 前端 | `frontend/src/modules/assistant/` | 触发同步、进度/结果；不写 OSS 细节 |

数据流：

```text
前端触发 → Tauri command → 各 MetadataCollector 组装快照
  → 账号服务换 STS → PUT snapshot.json → 返回 objectKey/etag/bytes
```

## 快照 Schema

```json
{
  "schemaVersion": 1,
  "generatedAt": "ISO-8601",
  "clientDeviceId": "...",
  "bindId": null,
  "modules": {
    "terminal": { "items": [] },
    "database": { "items": [] },
    "docker": { "items": [] },
    "files": { "items": [] },
    "server": { "items": [] },
    "knowledge": { "items": [] },
    "protocol": { "items": [] },
    "tasks": { "items": [] }
  }
}
```
单模块采集失败时，该模块可写 `error` 字段，其它模块照常；仅 STS/上传失败导致整次推送失败。

### 模块载荷含义

| 模块 | 内容 |
|---|---|
| terminal | 主机（SSH 等）元数据 |
| database | 数据库连接元数据 |
| docker | Docker 实例元数据（含本地） |
| files | 文件连接元数据（含本地） |
| server | 第三方/服务器面板：每个面板实例元数据 |
| knowledge | 知识库文档元数据 |
| protocol | 协议实验室全部请求元数据 |
| tasks | 任务中心最近 **5** 条 |

### 脱敏白名单原则

保留：`id`、`name`、`kind/type`、`host`、`port`、`status`、`enabled`、标签/分组等展示定位字段。  
禁止：`password`、`privateKey`、`token`、`secret`、凭据明文、以及任何可直接用于登录的材料。

## Collector 边界

```rust
trait MetadataCollector {
    fn module_id(&self) -> &'static str;
    fn collect(&self, ctx: &CollectContext) -> Result<ModulePayload, OmniError>;
}
```

- `CollectContext` 由 Tauri 层注入只读快照输入；crate **不**依赖前端 store
- 每个业务模块一个 collector 实现文件

## STS / OSS（服务端需实现）

客户端正式推送时会调用账号服务：

```http
POST {AUTH_API_BASE}/api/assistant/oss/sts
Authorization: Bearer <access_token>
X-App-Id: omni-client
X-Device-Id: <client_device_id>
X-Device-Public-Key: <optional, 可空>
```

**成功响应**（推荐包一层 `data`；也兼容直接返回凭证对象）：

```json
{
  "data": {
    "endpoint": "https://oss-cn-hangzhou.aliyuncs.com",
    "bucket": "omni-assistant",
    "region": "cn-hangzhou",
    "accessKeyId": "...",
    "accessKeySecret": "...",
    "securityToken": "...",
    "expiration": "2026-07-23T06:00:00Z",
    "objectKeyPrefix": "assistant/{userId}/{clientDeviceId}",
    "uploadUrl": null
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| endpoint / bucket / region | 是 | S3 兼容端点信息 |
| accessKeyId / accessKeySecret / securityToken | 是* | 临时凭证（若提供 `uploadUrl` 可省略签名路径） |
| expiration | 是 | ISO-8601 过期时间 |
| objectKeyPrefix | 否 | 有则客户端写到 `{prefix}/snapshots/{ts}-{id}.json`；无则用默认 `assistant/{userId}/{deviceId}/snapshots/...` |
| uploadUrl | 否 | 若下发预签名 PUT URL，客户端优先直传，跳过本地 SigV4 |

\* 推荐优先下发 **STS 临时凭证**（权限限制为该 prefix 下 `PutObject`）；也可只下发单次 `uploadUrl`。

**权限建议**：STS 仅允许写入本用户/本设备 prefix，禁止 ListBucket / GetObject 全桶。

**Object key（客户端约定）**

```text
# 无 objectKeyPrefix 时
assistant/{userId}/{clientDeviceId}/snapshots/{generatedAt}-{shortId}.json

# 有 objectKeyPrefix 时
{objectKeyPrefix}/snapshots/{generatedAt}-{shortId}.json
```

**快照 JSON 实际形状**（`Content-Type: application/json`）：

```json
{
  "schemaVersion": 1,
  "generatedAt": "ISO-8601",
  "clientDeviceId": "...",
  "bindId": null,
  "modules": {
    "terminal": { "items": [] },
    "database": { "items": [] },
    "docker": { "items": [] },
    "files": { "items": [] },
    "server": { "items": [] },
    "knowledge": { "items": [] },
    "protocol": { "items": [] },
    "tasks": { "items": [] }
  }
}
```

单模块失败时该模块可为 `{ "items": [], "error": "..." }`。第一期不做 `latest` pointer / 通知 API。

凭证仅内存使用，不落盘；401/403 客户端按 Auth 错误引导重新登录。

### 错误分类

| 类型 | 含义 | UI |
|---|---|---|
| Auth | 登录/设备无效 | 引导重新登录 |
| Sts | STS 失败 | 可重试 |
| Collect | 单模块采集失败 | 快照仍可上传，模块带 error |
| Upload | OSS 失败 | 可重试 |
| Encode | 序列化异常 | 内部错误 |

日志不得打印 Secret / SecurityToken。

## 目录结构

```text
crates/omnipanel-assistant/
  src/
    lib.rs
    error.rs
    types.rs
    collect/{mod,terminal,database,docker,files,server,knowledge,protocol,tasks}.rs
    sts.rs
    oss.rs
    push.rs

src-tauri/src/commands/assistant.rs

frontend/src/modules/assistant/
  api.ts
  types.ts
  useAssistantPush.ts
  AssistantSyncPanel.tsx   # 设备页或设置入口「同步到助手端」
```

## 实现顺序（建议）

1. crate 接入 workspace + 类型 / Collector 注册表  
2. database + tasks 两个真实 Collector 打通 assemble  
3. STS + OSS PUT（可 mock HTTP）  
4. Tauri command + bindings  
5. 补齐其余 Collector  
6. 前端手动推送 UI  

## 测试（第一期）

- 脱敏：输入含 password 的连接 → 快照中无该字段  
- assemble：单模块失败不影响其它模块入库  
- STS/上传：HTTP mock，不强制真连 OSS  

## 后续（非本期）

- 助手端拉取与「发布快照」pointer API  
- 可选分模块增量 object  
- 绑定成功后自动推送 / 定时同步  
