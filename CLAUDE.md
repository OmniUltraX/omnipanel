# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OmniPanel is an AI-native cross-platform engineering workstation for developers. It unifies terminal, SSH, database, Docker, server management, and AI assistance into a single desktop application.

**Status:** Phase 0 complete — Tauri + React framework skeleton搭建完成，Shell 组件（Sidebar、Topbar、StatusBar、CommandPalette）就位，所有功能面板 UI 骨架就位。下一步聚焦终端和 SSH 模块的真实后端实现。

## Technology Stack

- **App framework:** Tauri 2.x (Rust backend + WebView frontend)
- **Frontend:** React 18 + TypeScript + Vite + React Router
- **Terminal (frontend):** xterm.js (planned, not yet integrated)
- **Terminal (backend):** alacritty_terminal crate (planned) / portable-pty
- **SSH:** russh + russh-sftp (preferred) or ssh2-rs (fallback)
- **Database drivers:** sqlx (MySQL/PostgreSQL/SQLite), tiberius (SQL Server), redis-rs, mongodb
- **Docker:** bollard
- **AI:** rig (multi-model), async-openai, Ollama HTTP API, CLI Agent adapter
- **Storage:** rusqlite/SQLCipher (local config), keyring-core (credentials)
- **HTTP:** reqwest
- **Protocols:** serialport (serial), rumqttc (MQTT), tokio-tungstenite (WebSocket)

## Project Structure

```
omnipanel/
├── src-tauri/                    # Tauri backend (Rust)
│   ├── src/
│   │   ├── main.rs               # App entry
│   │   ├── lib.rs                # Tauri Builder, plugin registration
│   │   ├── state.rs              # Global app state
│   │   ├── commands/             # Tauri Commands (callable from frontend)
│   │   └── terminal/             # Terminal core logic
│   └── Cargo.toml
├── frontend/                     # Frontend (React + TypeScript)
│   ├── src/
│   │   ├── App.tsx               # Routes & Shell layout
│   │   ├── components/
│   │   │   ├── shell/            # Sidebar, Topbar, StatusBar, CommandPalette
│   │   │   ├── panels/           # Feature panels (Terminal, SSH, DB, Docker, etc.)
│   │   │   └── ui/               # Shared UI components (Icons)
│   │   └── styles.css            # Global styles & theme variables
│   ├── package.json
│   └── vite.config.ts
├── crates/                       # Shared Rust core libraries (progressive migration)
│   ├── omnipanel-core/           # Core engine (terminal, storage)
│   ├── omnipanel-renderer/       # GPU rendering (future phase)
│   └── omnipanel-ui/             # egui UI (future phase, optional)
├── design/                       # Design assets
├── Cargo.toml                    # Rust workspace
└── PRD.md                        # Product requirements document
```

## Build Commands

```bash
# Install frontend dependencies
cd frontend && npm install

# Run in development mode (Tauri dev)
npm run tauri dev

# Build for production
npm run tauri build

# Run frontend only (no Tauri)
cd frontend && npm run dev

# Build Rust workspace only
cargo build

# Run Rust tests
cargo test

# Run a single crate's tests
cargo test -p omnipanel-core

# Check formatting
cargo fmt --check

# Run clippy lints
cargo clippy -- -D warnings
```

## Architecture Principles

- **Local-first:** Credentials, history, config stored locally by default. Optional cloud sync, never mandatory.
- **Workspace model:** Each workspace groups connections (SSH/DB/Docker), resources, history, workflows, and security policies for a project or environment.
- **Context continuity:** Terminal, SSH, database, Docker, and AI share context — no copy-paste between modules.
- **AI safety:** AI suggests but never executes without user confirmation. Dangerous commands require explicit approval. All high-risk operations are auditable.
- **Environment tagging:** All resources tagged as dev/test/staging/prod. Production operations get strong warnings.

## Development Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Framework skeleton (Tauri + React + Shell) | Done |
| 1 (Month 1-4) | MVP: Terminal + SSH client + basic AI | In progress |
| 2 (Month 5-7) | Database management (MySQL, PostgreSQL) | — |
| 3 (Month 8-10) | Docker + server management + panel integration | — |
| 4 (Month 11-13) | Blocks terminal, workflows, protocol debugging, AI agent chains | — |
| 5 (Month 14-15) | Polish and release v1.0 | — |

## Cross-Platform Targets

- **Windows 10+:** conpty for terminal PTY
- **macOS 12+:** posix PTY
- **Linux:** posix PTY, Wayland/X11

## Performance Targets

- Terminal throughput: >500MB/s (`cat` large files)
- Input latency: <5ms (keystroke to screen)
- Memory per terminal tab: <20MB
- VT emulation compatibility: >98% (VT100/VT220)

## Tauri IPC Pattern

Frontend calls Rust backend via `invoke`:
```typescript
import { invoke } from "@tauri-apps/api/core";
const id = await invoke<string>("create_terminal", { cols: 80, rows: 24 });
```

Backend sends events to frontend via `app.emit()`:
```rust
app.emit("terminal-output", payload)?;
```

Tauri Commands are defined in `src-tauri/src/commands/` and registered in `src-tauri/src/lib.rs`.
