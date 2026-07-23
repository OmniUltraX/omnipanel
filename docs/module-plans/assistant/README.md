# Assistant 模块：客户端 → 助手端 OSS 元数据快照

> 状态：设计已确认（2026-07-23）  
> 第一期范围：客户端采集脱敏元数据并上传 OSS；助手端通知/拉取协议后补。

## 背景与目标

客户端与助手端已通过账号服务完成设备绑定。为让助手端感知客户端工作区资源，使用 **OSS + 临时 STS** 传输各业务模块的**对象元数据**（非任意文件、不含密钥）。

**第一期成功标准**

- 登录后，模块元数据变更自动上传（debounce）；绑定成功立即推一次
- 生成 **概览 + 各模块列表** 多文件并成功 PUT 到 OSS
- 无手动「试组装 / 推送」入口
- 敏感字段（密码、私钥、Token 等）绝不进入快照

**第一期明确不做**

- 助手端拉取 / SSE 通知 / `latest` pointer
- 双向同步、冲突合并
- 分模块增量变更检测
- 密钥或可连资源的凭据下发

## 架构

| 层 | 位置 | 职责 |
|---|---|---|
| 传输内核 | `crates/omnipanel-assistant` | STS、OSS PUT、快照序列化、Collector 注册与编排 |
| Tauri 薄壳 | `src-tauri/src/commands/assistant.rs` | 注入本机只读数据到 `CollectContext`，调用 `push` |
| 前端 | `frontend/src/modules/assistant/` | 元数据变更后 debounce 自动推送；无手动上传 UI |

数据流：

```text
模块元数据写入成功 → scheduleAssistantSnapshotSync (debounce 5s)
  → Tauri assistant_push_snapshot → 采集 → 凭证 → PUT modules/* + overview
  → POST /api/assistant/snapshots/notify
```

## 快照 Schema（v2 · 多文件）

每次推送写入同一快照目录：

```text
{prefix}/snapshots/{generatedAt}-{shortId}/
  overview.json
  modules/terminal.json
  modules/database.json
  modules/docker.json
  modules/files.json
  modules/server.json
  modules/knowledge.json
  modules/protocol.json
  modules/tasks.json
```

### overview.json

```json
{
  "schemaVersion": 2,
  "generatedAt": "ISO-8601",
  "clientDeviceId": "...",
  "bindId": null,
  "modules": {
    "terminal": { "count": 3, "objectKey": ".../modules/terminal.json" },
    "database": { "count": 1, "objectKey": ".../modules/database.json" },
    "docker": { "count": 0, "objectKey": ".../modules/docker.json" },
    "files": { "count": 0, "objectKey": ".../modules/files.json" },
    "server": { "count": 0, "objectKey": ".../modules/server.json" },
    "knowledge": { "count": 0, "objectKey": ".../modules/knowledge.json" },
    "protocol": { "count": 0, "objectKey": ".../modules/protocol.json" },
    "tasks": { "count": 5, "objectKey": ".../modules/tasks.json" }
  }
}
```

某模块采集失败时，对应 entry 可带 `"error": "..."`，`count` 为 0。

### modules/{id}.json

```json
{
  "schemaVersion": 2,
  "moduleId": "database",
  "generatedAt": "ISO-8601",
  "clientDeviceId": "...",
  "items": [ { "id": "...", "name": "..." } ],
  "error": null
}
```

单模块采集失败时该模块文件仍会上传（`items: []` + `error`）；其它模块照常。仅凭证/上传失败导致整次推送失败。

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
    "endpoint": "https://omniminiapp.oss-cn-beijing.aliyuncs.com",
    "bucket": "omniminiapp",
    "region": "cn-beijing",
    "cname": true,
    "accessKeyId": "...",
    "accessKeySecret": "...",
    "securityToken": "",
    "expiration": "",
    "objectKeyPrefix": "assistant/{userId}/{clientDeviceId}",
    "uploadUrl": null
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| endpoint / bucket / region | 是 | `cname=true` 时 endpoint 为虚拟主机风格（已含 bucket） |
| cname | 否 | 默认 false；为 true 时 PUT `{endpoint}/{key}`，不再拼 `/{bucket}/` |
| accessKeyId / accessKeySecret | 是 | 永久 AK 或 STS 临时 AK |
| securityToken | 否 | 临时 STS 才有；空字符串视为永久，**不得**带空 token 参与签名 |
| expiration | 否 | 空则视为永久，客户端不按时间刷新 |
| objectKeyPrefix | 否 | 有则写到 `{prefix}/snapshots/{ts}-{id}.json` |
| uploadUrl | 否 | 预签名 PUT URL，优先直传 |

兼容非空 `securityToken` 的临时 STS。每次推送会重新请求一次 `/oss/sts`（无本地定时刷新）。

**权限建议**：凭证应限制到本用户/本设备 prefix 的 `PutObject`。

**Object key（客户端约定 · 快照目录）**

```text
# 无 objectKeyPrefix 时
assistant/{userId}/{clientDeviceId}/snapshots/{generatedAt}-{shortId}/overview.json
assistant/{userId}/{clientDeviceId}/snapshots/{generatedAt}-{shortId}/modules/{moduleId}.json

# 有 objectKeyPrefix 时
{objectKeyPrefix}/snapshots/{generatedAt}-{shortId}/overview.json
{objectKeyPrefix}/snapshots/{generatedAt}-{shortId}/modules/{moduleId}.json
```

第一期不做 `latest` pointer 由客户端维护；上传成功后客户端会调用 notify，由服务端更新 latest / 通知助手端。凭证仅内存使用，不落盘；401/403 按 Auth 错误引导重新登录。

### 上传完成通知

```http
POST {AUTH_API_BASE}/api/assistant/snapshots/notify
Authorization: Bearer <access_token>
X-App-Id: omni-client
X-Device-Id: <client_device_id>
X-Device-Public-Key: <optional>
Content-Type: application/json
```

Body（**snake_case**）：

```json
{
  "snapshot_dir": "assistant/{userId}/{deviceId}/snapshots/{run}/",
  "overview_key": "assistant/.../overview.json",
  "object_keys": [
    ".../modules/terminal.json",
    ".../modules/database.json",
    ".../overview.json"
  ],
  "generated_at": "2026-07-23T10:00:00Z"
}
```

`object_keys` 含本次上传的全部文件；`snapshot_dir` 以 `/` 结尾。notify 失败则整次推送失败（自动同步可重试）。

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
  autoSync.ts              # debounce 自动上传
  index.ts
```

## 实现顺序（建议）

1. crate 接入 workspace + 类型 / Collector 注册表  
2. database + tasks 两个真实 Collector 打通 assemble  
3. STS + OSS PUT（可 mock HTTP）  
4. Tauri command + bindings  
5. 补齐其余 Collector  
6. 前端：元数据变更自动推送（去掉手动测试入口）

## 测试（第一期）

- 脱敏：输入含 password 的连接 → 快照中无该字段  
- assemble：单模块失败不影响其它模块入库  
- STS/上传：HTTP mock，不强制真连 OSS  

## 后续（非本期）

- 助手端拉取与「发布快照」pointer API  
- 可选分模块增量 object  
- 绑定成功后自动推送 / 定时同步  
