<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo/omni.png">
    <img src="logo/omni.png" alt="OmniPanel" width="96" height="96">
  </picture>
  <h1 align="center">OmniPanel</h1>
  <p align="center">
    AI-Native Cross-Platform Engineering Workstation
    <br>
    AI 原生跨平台运维工作站
  </p>
  <p align="center">
    <a href="https://omniultrax.github.io/omnipanel/"><img src="https://img.shields.io/badge/website-live-0ea5a4?style=flat-square" alt="Website"></a>
    <a href="https://github.com/OmniUltraX/omnipanel/releases"><img src="https://img.shields.io/github/v/release/OmniUltraX/omnipanel?style=flat-square&color=007aff" alt="Release"></a>
    <a href="https://github.com/OmniUltraX/omnipanel/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square&color=007aff" alt="License"></a>
    <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/rust-1.85+-orange?style=flat-square&color=ff5f57" alt="Rust"></a>
    <a href="https://tauri.app"><img src="https://img.shields.io/badge/tauri-2.x-ffc131?style=flat-square" alt="Tauri"></a>
  </p>
</div>

---

## 🇬🇧 English

**OmniPanel** is an AI-native, cross-platform engineering workstation for developers. It unifies terminal, SSH, database, Docker, server management, protocol debugging, and AI assistance into a single desktop application — eliminating context switching and letting you focus on what matters.

> One window to manage servers, databases, containers, and workflows. One AI that understands your entire engineering context.

**Website:** [https://omniultrax.github.io/omnipanel/](https://omniultrax.github.io/omnipanel/) · **Releases:** [GitHub Releases](https://github.com/OmniUltraX/omnipanel/releases)

### 📸 Screenshots

SSH host overview with live CPU / memory / disk metrics and the built-in AI assistant side by side:

![OmniPanel SSH — resource monitoring](docs/examples/OmniTerminal.png)

Remote Docker hosts over SSH: container table, resource usage, logs and one-click shell:

![OmniPanel Docker — container orchestration](docs/examples/OmniDocker.png)

AI Agent inspection report — structured health checks grounded in live container and host context:

![OmniPanel AI Agent — service inspection report](docs/examples/OmniAgentTerminal.png)

### ✨ Key Features

| Module | Description |
|--------|-------------|
| **Terminal** | Multi-tab & split panes, Blocks output grouping, VT100/VT220 compatibility |
| **SSH / SFTP** | Connection manager, visual file transfer, tunnels, jump hosts, batch commands |
| **Database** | SQL editor, virtual-scroll grid, NL2SQL, schema tools, multi-engine support |
| **Docker** | Local / remote Engine / SSH host / 1Panel — containers, images, Compose, networks, volumes |
| **Server** | Live system monitor, remote files, process/service management, panel integrations |
| **Protocol Lab** | HTTP/API, WebSocket, MQTT, serial — one workspace |
| **AI Assistant** | Context-aware ops (terminal, schema, containers, logs), Plans, Skills, multi-model |
| **Workflow / Tasks** | Templates, runbooks, task center, auditable execution |

### 🛠️ Tech Stack

```
UI Layer      │  Tauri 2 (React / TypeScript + Rust backend)
Terminal      │  xterm.js (frontend) · portable-pty / ConPTY
SSH           │  russh + russh-sftp
Database      │  sqlx | tiberius | redis-rs | mongodb
Docker        │  bollard
AI            │  rig | async-openai | Ollama | CLI Agent adapter
Storage       │  rusqlite / SQLCipher | keyring-core
```

### 🚀 Getting Started

```bash
# Prerequisites: Rust 1.85+, Node.js 20+
git clone https://github.com/OmniUltraX/omnipanel.git
cd omnipanel

# Frontend deps
cd frontend && npm install && cd ..

# Dev (Tauri + Vite)
cd frontend && npm run tauri dev

# Or frontend only
cd frontend && npm run dev
```

### 📁 Project Structure

```
omnipanel/
├── src-tauri/           # Tauri desktop shell (Rust commands, plugins)
├── frontend/            # React / TypeScript UI
├── crates/              # Shared Rust libraries
├── website/             # Product site (GitHub Pages)
├── docs/
│   ├── examples/        # Product screenshots used in README / website
│   └── module-plans/    # Module design notes
├── logo/                # Application icons
└── CHANGELOG.md
```

### 🖥️ Cross-Platform Support

| Platform | PTY Backend | Notes |
|----------|-------------|-------|
| Windows 10+ | ConPTY | Native Windows terminal |
| macOS 12+ | POSIX PTY | Retina display support |
| Linux | POSIX PTY | Wayland & X11 |

---

## 🇨🇳 中文

**OmniPanel** 是一个 AI 原生的跨平台个人工程工作台。它将终端、SSH、数据库、Docker、服务器管理、协议调试和 AI 辅助集成为一个桌面应用 —— 告别工具频繁切换，专注真正重要的工作。

> 一个窗口，管理服务器、数据库、容器与工作流；一个 AI，贯穿开发运维上下文。

**官网：** [https://omniultrax.github.io/omnipanel/](https://omniultrax.github.io/omnipanel/) · **安装包：** [GitHub Releases](https://github.com/OmniUltraX/omnipanel/releases)

### 📸 界面预览

SSH 主机概览：CPU / 内存 / 磁盘实时监控，右侧 AI 助手同屏协作：

![OmniPanel SSH · 资源监控](docs/examples/OmniTerminal.png)

远程 Docker（SSH 宿主机）：容器列表、资源占用、日志与一键进入 Shell：

![OmniPanel Docker · 容器编排](docs/examples/OmniDocker.png)

AI Agent 服务巡检：基于真实容器与主机上下文生成结构化健康报告：

![OmniPanel AI Agent · 服务巡检报告](docs/examples/OmniAgentTerminal.png)

### ✨ 核心模块

| 模块 | 说明 |
|------|------|
| **终端** | 多标签分屏，Blocks 输出分组，VT100/VT220 高兼容 |
| **SSH / SFTP** | 连接管理、可视化传文件、隧道、跳板机、批量命令 |
| **数据库** | SQL 编辑器、虚拟滚动网格、NL2SQL、多引擎支持 |
| **Docker** | 本地 / 远程 Engine / SSH 宿主机 / 1Panel — 容器、镜像、Compose、网络、卷 |
| **服务器管理** | 实时监控、远程文件、进程/服务、面板集成 |
| **协议调试** | HTTP/API、WebSocket、MQTT、串口 —— 统一工作区 |
| **AI 助手** | 上下文感知运维（终端、库表、容器、日志），Plan / Skills，多模型 |
| **工作流 / 任务** | 模板、排障手册、任务中心、可审计执行 |

### 🛠️ 技术栈

```
UI 层        │  Tauri 2（React / TypeScript + Rust 后端）
终端         │  xterm.js（前端）· portable-pty / ConPTY
SSH          │  russh + russh-sftp
数据库       │  sqlx | tiberius | redis-rs | mongodb
Docker       │  bollard
AI           │  rig | async-openai | Ollama | CLI Agent 适配
存储         │  rusqlite / SQLCipher | keyring-core
```

### 🚀 快速开始

```bash
# 前置要求: Rust 1.85+, Node.js 20+
git clone https://github.com/OmniUltraX/omnipanel.git
cd omnipanel

# 安装前端依赖
cd frontend && npm install && cd ..

# 开发模式（Tauri + Vite）
cd frontend && npm run tauri dev

# 或仅启动前端
cd frontend && npm run dev
```

### 📁 项目结构

```
omnipanel/
├── src-tauri/           # Tauri 桌面壳层（Rust 命令、插件）
├── frontend/            # React / TypeScript UI
├── crates/              # 共享 Rust 库
├── website/             # 产品官网（GitHub Pages）
├── docs/
│   ├── examples/        # 产品截图（README / 官网复用）
│   └── module-plans/    # 模块设计说明
├── logo/                # 应用图标
└── CHANGELOG.md
```

### 🖥️ 跨平台支持

| 平台 | PTY 后端 | 说明 |
|------|----------|------|
| Windows 10+ | ConPTY | 原生 Windows 终端 |
| macOS 12+ | POSIX PTY | 支持 Retina |
| Linux | POSIX PTY | Wayland & X11 |

### 🤖 AI 三条能力线

| 能力线 | 入口 | 用途 |
|--------|------|------|
| **InternalOrchestrator** | Tauri IPC `ai_chat_stream` | 内置 UI：多 backend、`omni_*` 工具、终端审批 |
| **Agent Router** | `http://127.0.0.1:8765/v1/*` | 纯 LLM 路由（OpenAI 兼容 SSE），零 MCP 耦合 |
| **OmniMCP** | `http://127.0.0.1:12756/mcp` | Cursor / Claude Code 等外部 Agent 接入 |

详情与版本记录见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 📄 License

MIT © 2026 [OmniUltraX](https://github.com/OmniUltraX)

---

<div align="center">
  <p>All in One · 小而全而优而美</p>
</div>
