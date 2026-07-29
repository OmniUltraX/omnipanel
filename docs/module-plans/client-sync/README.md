# 客户端 ↔ 客户端同步（同账号）

与 [助手端快照](../assistant/) **完全独立**：

| | 客户端 → 助手 | 客户端 ↔ 客户端 |
|---|---|---|
| 路径 | `assistant/{userId}/{deviceId}/…` | `sync/{userId}/devices/{deviceId}/…` |
| 目的 | 助手端只读元数据 / 聊天分片 | 多设备手动导入本地数据 |
| 触发 | `scheduleAssistantSnapshotSync` | 数据变更自动 **push**；跨端 **手动** 导入 |

## 对象布局

每台客户端设备各自一份快照：

| Object | 内容 |
|---|---|
| `sync/{userId}/devices/{deviceId}/ai-conversations/latest.json` | AI 会话全文 + tombstone |
| `sync/{userId}/devices/{deviceId}/modules/latest.json` | 统一连接（含 SSH Vault）、数据库连接（含密码）、知识库、HTTP、工作区 |

模块 blob **会携带** SSH Vault 密码与 DB 密码（仅账号级 `sync/` 前缀，勿与助手公开快照混淆）。

STS：沿用 `/api/assistant/oss/sts`；账号服务需允许 `sync/{userId}/` Put/Get。

## 触发时机

- **本机上传（自动）**：会话 / 连接 / 数据库 / 知识库 / HTTP / 工作区变更 → debounce push；登录与冷启动也会补推一次
- **跨端导入（手动）**：侧栏头像菜单 →「数据同步」→ 选择其它客户端 → Tab 勾选 → 导入到本机

后端命令：

- `client_sync_push_conversations` / `client_sync_push_modules`
- `client_sync_peek_device` / `client_sync_import_from_device`

控制台可搜 `[client-sync:modules]` / `[client-sync:peek]` / `[client-sync:import]`。

## 前端入口

`frontend/src/modules/clientSync/`  
UI：`frontend/src/components/user/DataSyncWindow.tsx`
