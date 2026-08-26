<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo/omni.png">
    <img src="logo/omni.png" alt="OmniPanel" width="96" height="96">
  </picture>
  <h1 align="center">OmniPanel</h1>
  <p align="center">
    AI 原生跨平台运维工作站
  </p>
  <p align="center">
    <a href="./README.zh-CN.md">简体中文</a> ·
    <a href="./README.md">English</a>
  </p>
  <p align="center">
    <a href="https://omniultrax.github.io/omnipanel/"><img src="https://img.shields.io/badge/website-live-0ea5a4?style=flat-square" alt="Website"></a>
    <a href="https://github.com/OmniUltraX/omnipanel/pkgs/container/omnipanel-web"><img src="https://img.shields.io/badge/docker-ghcr.io-2496ed?style=flat-square" alt="Docker"></a>
    <a href="https://github.com/OmniUltraX/omnipanel/releases"><img src="https://img.shields.io/github/v/release/OmniUltraX/omnipanel?style=flat-square&color=007aff" alt="Release"></a>
    <a href="https://github.com/OmniUltraX/omnipanel/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square&color=007aff" alt="License"></a>
    <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/rust-1.85+-orange?style=flat-square&color=ff5f57" alt="Rust"></a>
    <a href="https://tauri.app"><img src="https://img.shields.io/badge/tauri-2.x-ffc131?style=flat-square" alt="Tauri"></a>
  </p>
</div>

---

**OmniPanel** 是一个 AI 原生的跨平台个人工程工作台。它将终端、SSH、数据库、Docker、服务器管理、文件、协议调试和 AI 辅助集成于**桌面应用与 Web 版** —— 告别工具频繁切换，专注真正重要的工作。

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
| **SSH / SFTP** | 连接管理、SFTP、隧道、跳板机；**tmux** 远端会话治理 |
| **文件** | 本地 / 远程浏览、收藏、**跨连接传输** |
| **数据库** | SQL 编辑器、虚拟滚动网格、NL2SQL；第一方引擎 + sidecar/DBX（Oracle、达梦、Hive 等） |
| **Docker** | 本地 / 远程 Engine / SSH 宿主机 / 1Panel / **宝塔** — 容器、镜像、Compose、网络、卷 |
| **服务器管理** | 主机监控；**宝塔 / 1Panel**（网站、应用、证书、计划任务）；**云厂商**（阿里云自动发现有实例的地域） |
| **协议调试** | HTTP/API、WebSocket、MQTT、串口 —— 统一工作区 |
| **AI 助手** | 上下文感知运维，Plan / Skills，`omni_ask_user`，敏感信息脱敏，多模型 |
| **工作流 / 任务** | 模板、排障手册、任务中心、快捷启动，可审计执行 |
| **工作区** | **自定义监控面板**与可插拔小组件（主机 / Docker / MySQL / Redis） |

### 插件平台

OmniPanel 通过签名插件体系向第三方开放三级扩展能力：

| 级别 | 第三方能做什么 | 沙箱保障 |
|------|----------------|----------|
| **L1 声明式** | 数据库引擎表单、主题 token、菜单、AI 工具元数据、Overlay 面板——一个 plugin.json 即可 | 无需（零代码） |
| **L2 逻辑包** | logic.js（QuickJS）或 logic.wasm，调用受权限闸保护的宿主能力（netFetch / fsRead / connectionUpsert） | 内存/栈/超时三重护栏、逐次权限校验、生产目标弹窗确认、审计日志 |
| **L3 沙箱 UI** | Overlay 面板以 HTML 渲染于不透明 origin iframe（CSP 默认拒外联） | postMessage 白名单桥 |

从磁盘安装 .omni-plugin（ed25519 签名），按插件启用/禁用，重启保持。
详见[插件开发指南](./docs/plugins/README.md)。
### 近期亮点（v0.8.x）

| 类别 | 说明 |
|------|------|
| **插件平台** | `.omni-plugin` 签名安装；L1 声明式 / L2 逻辑包 / L3 沙箱 Overlay；Host SDK 与开发者文档 |
| **云厂商** | 阿里云展开账户后自动发现有 ECS / 轻量实例的地域 |
| **同步安全** | 新设备小程序扫码配对；主设备自动传钥；仅扫码路径，密码不进 modules 快照 |
| **团队同步** | 模块文件夹树同步；上传后 peek 与本地一致 |
| **数据库** | 远程导出修复 SSH 池滞后；导出前校验连接就绪 |
| **性能** | 取消模块窗启动预热，降低常驻内存 |
| **Web 版** | 浏览器访问 + GHCR 公开 Docker 镜像，支持 Render / Zeabur / Railway 等一键部署 |

完整版本记录见 [CHANGELOG.md](./CHANGELOG.md)。

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

### 🌐 Web 模式（P0：前后端分离）

同一套前端产物、同一个 Rust 后端能力，浏览器直接打开即用（本地终端/SSH/Docker 等操作发生在服务端所在机器）：

```bash
# 1. 构建 Web 版前端（把 @tauri-apps/api 替换为 HTTP/WS 桥）
cd frontend && OMNIPANEL_WEB=1 npm run build && cd ..

# 2. 启动 Web 服务端（内嵌静态托管 + /ipc/invoke + WS 事件流）
cargo run -p omnipanel-server -- --static-dir frontend/dist --port 8899

# 3. 浏览器打开 http://127.0.0.1:8899
```

架构：不改任何业务代码，只把 `invoke`/`listen` 的底层传输从 Tauri IPC 换成 HTTP + WebSocket：

- `POST /ipc/invoke`：`{ cmd, args }` → 命令分发（等价 Tauri `invoke`）
- `WS /ipc/events`：后端事件广播（等价 Tauri `listen`）
- `GET /`：静态托管 `frontend/dist`

P0 已打通本地终端链路（`create_terminal`/`write_terminal`/`resize_terminal`/`close_terminal`/`terminal_snapshot`/`list_shells`），其余模块命令按 `crates/omnipanel-server/src/ipc.rs` 的 match 渐进接入。桌面端（`tauri build`）不受任何影响。

## 部署

本项目 **Web 版** 支持 **Docker、Render、Zeabur、Railway、Koyeb、DigitalOcean、Fly.io** 等平台部署。

**一键部署到 Render**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/OmniUltraX/omnipanel)

**一键部署到 Zeabur**

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/projects/new?gitRepo=https://github.com/OmniUltraX/omnipanel)

**一键部署到 Railway**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.app/new/template?template=https://github.com/OmniUltraX/omnipanel)

**一键部署到 Koyeb**

[![Deploy to Koyeb](https://www.koyeb.com/static/images/deploy/button.svg)](https://app.koyeb.com/deploy?type=docker&image=ghcr.io/omniultrax/omnipanel-web:latest&name=omnipanel-web&ports=8899:http)

**一键部署到 DigitalOcean**

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/OmniUltraX/omnipanel/tree/master)

**一键部署到 Fly.io**

[![Deploy on Fly.io](https://img.shields.io/badge/Deploy%20on-Fly.io-8B5CF6?style=for-the-badge&logo=fly.io&logoColor=white)](https://fly.io/launch?source=github)

> Fly.io：在 Launch 流程中选择本仓库，使用根目录 `fly.toml`；或本地 `fly launch` 后 `fly deploy`。

### Docker 部署

镜像：[ghcr.io/omniultrax/omnipanel-web](https://github.com/OmniUltraX/omnipanel/pkgs/container/omnipanel-web)（公开镜像，无需 `docker login`）

```bash
# 方式一：docker run（管理宿主机 Docker 需挂载 docker.sock）
docker run -d --name omnipanel -p 8899:8899 \
  -v omnipanel-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e OMNIPANEL_API_KEY=请替换为长随机字符串 \
  ghcr.io/omniultrax/omnipanel-web:latest

# 方式二：docker compose
cd deploy/docker && cp .env.example .env && docker compose up -d
```

浏览器打开 <http://localhost:8899>。`OMNIPANEL_API_KEY` **未设置时容器仍可启动**，但会打印安全警告（方案 A：适合本地试用）；生产环境请务必设置。

详细说明见 [docs/web/docker.md](./docs/web/docker.md)。

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
