---
name: omnipanel
description: OmniPanel 工程工作站项目概览与模块说明
---

# OmniPanel Skill

当用户询问 OmniPanel 架构、模块或开发约定时使用本 Skill。

## 项目结构

- `src-tauri/` — Tauri 2 后端（Rust）
- `frontend/` — React + TypeScript 前端
- `crates/` — 共享 Rust 库（omnipanel-ai、omnipanel-store 等）
- `agent/` — 本 ACP 本地 Agent（DeepAgents + Skills + MCP）

## 模块

- Terminal / SSH / Database / Docker / Server / Files / Protocol / Knowledge
- AI 助手与 ACP 服务集成在 `crates/omnipanel-ai` 与前端设置页

## 开发

- 桌面开发：`npm run tauri dev`（仓库根目录）
- **OmniAgent 两种启动模式**（`cd agent`）：

```
agent/
├── core/           # 核心：config、runtime、turn、sessions
├── adapters/
│   ├── acp/        # ACP stdio 适配器（OmniPanel 集成）
│   └── web/        # HTTP 适配器（assistant-ui 客户端）
├── dev-ui/         # Web 模式 UI
└── skills/
```

| 模式 | 命令 | 说明 |
|------|------|------|
| **acp**（默认） | `npm start` | ACP stdio，供 OmniPanel「设置 → Agent」连接 |
| **web** | `npm run start:web` | 一键启动 API + assistant-ui，浏览器打开 `http://127.0.0.1:9478` |

web 模式配置：复制 `agent/debug-config.example.json` → `debug-config.json`，或设置 `OMNIAGENT_CONFIG`。
也可通过 `OMNIAGENT_MODE=web` / `--mode web` 切换模式。
