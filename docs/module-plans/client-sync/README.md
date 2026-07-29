# 客户端 ↔ 客户端同步（同账号）

与 [助手端快照](../assistant/) **完全独立**：

| | 客户端 → 助手 | 客户端 ↔ 客户端 |
|---|---|---|
| 路径 | `assistant/{userId}/{deviceId}/…` | `sync/{userId}/v1/…` |
| 目的 | 助手端只读元数据 / 聊天分片 | 多设备恢复与合并本地数据 |
| 触发 | `scheduleAssistantSnapshotSync` | `hydrateClientSync` / `scheduleClient*Sync` |

## 对象布局

| Object | 内容 |
|---|---|
| `…/ai-conversations/latest.json` | AI 会话全文 + tombstone |
| `…/modules/latest.json` | 统一连接（SSH/Docker/文件/面板/协议）、数据库连接（含密码）、知识库、HTTP 集合/环境/请求、工作区 |

冲突：按 `updatedAt` LWW；删除靠 tombstone。  
同账号多设备测试需要可连：模块 blob **会携带** SSH Vault 密码与 DB 密码（仅账号级 `sync/` 前缀，勿与助手公开快照混淆）。

STS：沿用 `/api/assistant/oss/sts`；账号服务需允许 `sync/{userId}/` Put/Get。

## 触发时机

- 登录 / 冷启动：`hydrateClientSync`（会话 + 模块并行 pull）
- 会话增删改 / 一轮生成结束 → 会话 push
- 连接 / 数据库 / 知识库 / HTTP / 工作区变更 → 模块 push（debounce 约 5s；删除立即）

## 前端入口

`frontend/src/modules/clientSync/`
