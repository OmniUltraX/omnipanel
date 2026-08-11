<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo/omni.png">
    <img src="logo/omni.png" alt="OmniPanel" width="96" height="96">
  </picture>
  <h1 align="center">OmniPanel</h1>
  <p align="center">
    AI-Native Cross-Platform Engineering Workstation
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
| **SSH / SFTP** | Connection manager, SFTP, tunnels, jump hosts; **tmux** remote session governance |
| **Files** | Local / remote browsing, favorites, **cross-connection transfer** |
| **Database** | SQL editor, virtual-scroll grid, NL2SQL, schema tools, multi-engine support |
| **Docker** | Local / remote Engine / SSH host / 1Panel — containers, images, Compose, networks, volumes |
| **Server** | Host monitor; **BT Panel / 1Panel** (sites, apps, certs, cron); **cloud vendors** |
| **Protocol Lab** | HTTP/API, WebSocket, MQTT, serial — one workspace |
| **AI Assistant** | Context-aware ops, Plans, Skills, `omni_ask_user`, secret redaction, multi-model |
| **Workflow / Tasks** | Templates, runbooks, task center, Quick Launcher, auditable execution |

### What's new in v0.7.0

Panel domains + 1Panel v1/v2 compatibility, SSH tmux sessions, cross-connection file transfer, Quick Launcher, Vault credentials, cloud vendor entry — see [CHANGELOG.md](./CHANGELOG.md).

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

### 🐳 Docker (Web edition)

Image: [ghcr.io/omniultrax/omnipanel-web](https://github.com/OmniUltraX/omnipanel/pkgs/container/omnipanel-web)

```bash
docker run -d --name omnipanel -p 8899:8899 \
  -v omnipanel-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e OMNIPANEL_API_KEY=replace-with-a-long-random-secret \
  ghcr.io/omniultrax/omnipanel-web:latest

# Or: cd deploy/docker && cp .env.example .env && docker compose up -d
```

Open <http://localhost:8899>. If `OMNIPANEL_API_KEY` is unset, the container still starts but logs a security warning (local trial only). See [docs/web/docker.md](./docs/web/docker.md).

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

### 🤖 Three AI Capability Lines

| Line | Entry | Purpose |
|------|-------|---------|
| **InternalOrchestrator** | Tauri IPC `ai_chat_stream` | Built-in UI: multi-backend, `omni_*` tools, terminal approval |
| **Agent Router** | `http://127.0.0.1:8765/v1/*` | Pure LLM routing (OpenAI-compatible SSE), zero MCP coupling |
| **OmniMCP** | `http://127.0.0.1:12756/mcp` | External agents (Cursor / Claude Code, etc.) |

Details and release notes: [CHANGELOG.md](./CHANGELOG.md).

---

## 📄 License

MIT © 2026 [OmniUltraX](https://github.com/OmniUltraX)

---

<div align="center">
  <p>All in One · Compact · Complete · Excellent · Beautiful</p>
</div>
