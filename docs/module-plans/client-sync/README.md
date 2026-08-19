# 客户端 ↔ 客户端同步（默认个人团队）

与 [助手端快照](../assistant/) **完全独立**：

| | 客户端 → 助手 | 客户端 ↔ 客户端 |
|---|---|---|
| 路径 | `assistant/{userId}/{deviceId}/…` | 默认个人团队 OSS：`team_sync/{teamId}/…` |
| 目的 | 助手端只读元数据 / 聊天分片 | 登录后多端共享同一份工作区快照 |
| 凭证 | `/api/assistant/oss/sts` | `/api/teams/{teamId}/oss/sts` |
| 触发 | `scheduleAssistantSnapshotSync` | 数据变更自动 **push**；启动 **pull** |

## 对象布局

登录后 `/api/me.teams` 中 `kind=personal` 的团队为默认快照位置：

| Object | 内容 |
|---|---|
| `{teamOssKey}ai-conversations/latest.json` | AI 会话全文 + tombstone |
| `{teamOssKey}modules/latest.json` | 统一连接、数据库、知识库、HTTP、工作区 |

协作团队（`kind=custom`）仍走个人中心「团队」手动推送/拉取，对象 key 同为 `modules/latest.json`。

## 触发时机

- **本机上传（自动）**：会话 / 连接 / 数据库 / 知识库 / HTTP / 工作区变更 → debounce push；登录与冷启动也会补推一次
- **启动拉取**：登录后从默认个人团队 OSS hydrate 本机

后端命令：

- `client_sync_push_conversations` / `client_sync_push_modules`（写默认个人团队）
- `team_sync_push_modules` / `team_sync_pull_modules`（指定 teamId，含自定义团队）

控制台可搜 `[client-sync:modules]` / `[team-sync]`。

## 前端入口

`frontend/src/modules/clientSync/`  
团队 UI：`frontend/src/components/user/UserCenterTeams.tsx`
