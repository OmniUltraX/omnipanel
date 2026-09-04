# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OmniPanel is an AI-native cross-platform engineering workstation for developers. It unifies terminal, SSH, database, Docker, server management, and AI assistance into a single desktop application.

**Status:** Phase 0 complete — Tauri + React framework skeleton搭建完成，Shell 组件（Sidebar、Topbar、StatusBar、CommandPalette）就位。Phase 1 (MVP) 进行中 — Docker 模块后端全功能完成（本地 / 远程 Engine / SSH 宿主机 / 1Panel 面板四种来源），前端 6 个子页签（容器 / 镜像 / Compose / 网络 / 卷 / 文件）+ 资源监控 + 连接对话框就位。下一步聚焦 Database 模块后端实现。

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
```

## Mandatory Type Check (强校验)

**所有前端代码变更完成后，必须运行 `tsc -b` 通过后才能视为完成。** 这是 CI 流水线（`tauri-apps/tauri-action` → `build:ci` → `tsc -b && vite build`）的强校验门禁，本地不通过则 CI 必挂。

```bash
cd frontend && npx tsc -b
```

- 零 error 才算通过；warning 可接受但建议修复。
- 新增/删除 import 时同步检查未使用变量（TS6133）。
- 类型变更时检查跨文件兼容性（TS2322/TS2345 等）。
- 测试文件的类型必须与被测代码的签名严格匹配，不要用 `typeof` 推断具体字面量类型代替 `Record<string, ...>` 等宽泛类型。

## Release / Commit Docs Sync（发版与提交文档同步）

**只要涉及发版、打 tag、版本 bump，或用户明确要求「提交 / 发版 / 发布」时，必须同步更新对外文档与官网，不得只改代码或只改 CHANGELOG。**

至少检查并按需更新：

| 产物 | 路径 | 何时更新 |
|------|------|----------|
| 变更日志 | `CHANGELOG.md` | 每个正式版本（`## [x.y.z]`）；发版 tag 前必有对应段落 |
| 英文 README | `README.md` | 用户可见能力、部署方式、亮点摘要变化时 |
| 中文 README | `README.zh-CN.md` | 与英文 README **同次变更、内容对齐** |
| 官网文案 | `website/`（如 `index.html`、`src/i18n.ts`、相关样式） | 官网展示的能力、部署入口、亮点与 README 不一致时 |
| 部署配置 | 仓库根目录 `render.yaml` / `railway.toml` / `fly.toml` / `.do/` 等 | README/官网新增或变更一键部署方式时 |

约定：

1. **发版（`chore(release)` / `v*` tag）**：CHANGELOG 必改；若本版含用户可见能力或部署变化，README（中英）与官网同提交。
2. **普通功能提交**：若变更会反映到对外介绍（新模块、部署、破坏性变更），同一提交或紧随的文档提交中同步 README / 官网；纯内部重构可不动。
3. **中英文与官网**：同一事实不要只改一侧；亮点/部署按钮等对外文案保持一致。
4. CI 会校验 tag 版本在 `CHANGELOG.md` 中有对应 `## [version]` 段落——缺了发版会失败。

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

## Workbench UI（数据库 / SSH 事实源）

工作台页头必须用 `WorkbenchPanelHeader` + `WorkbenchActionButton`（`frontend/src/components/ui/primitives/`）。视觉事实源是数据库表页头：10px 标签、芯片、幽灵操作。

`Button` 省略 `variant` 时是 **实心蓝**；`danger` 是浅红底色块。页头、行内、空态、对话框 footer、设置、登录、协议发送一律用 `WorkbenchActionButton`，不要 `primary` / `secondary` / `danger`。尺寸统一扁平硬朗：11px / 4×8 / 4px 圆角，不要再传 `size`。不要新写 `xxx-panel__header`。详见 `.cursor/rules/workbench-actions.mdc`。

## Tauri IPC Pattern

正式业务路径是 **tauri-specta** 生成的 `commands.*`（见 `frontend/src/ipc/bindings.ts`），不是裸 `invoke`。

```typescript
import { commands } from "./ipc/bindings";
import { unwrapCommand } from "./ipc/result";

const id = await unwrapCommand(commands.createTerminal(80, 24));
```

### 约定（新代码必须遵守）

1. **业务读/写只走 `commands.*`**：模块半层 Api（如 `dockerComposeApi`、`fileApi`）可包一层编排；**禁止**为新业务再写裸 `invoke`（窗口 / 插件 / 通用文件对话框等除外）。
2. **Result 解包只用** `frontend/src/ipc/result.ts` 的 `unwrapCommand` / `unwrapCommandResult` / `formatIpcError`；不要复制 docker/files 里的本地 unwrap，并尽量保留 OmniError 的 `code` / `cause`。
3. **新后端命令强制 `Result<T, OmniError>`**；db/terminal 等历史 `Result<_, String>` 按文件渐进迁移，不一刀切。
4. **事件名** 用 `frontend/src/ipc/events.ts` 常量；长生命周期 / 跨 remount → App Event；请求绑定回调 → Channel。
5. **注册双清单**：`collect_commands!`（类型导出）与 `generate_handler!`（运行时）须保持命令集合一致；改完跑 `npm run gen:bindings`（内部 `cargo run` + `OMNIPANEL_GEN_BINDINGS_ONLY=1`）。

注意：JS `Error` 重抛不会进入 specta 的 `{ status: "error" }` envelope；终端热路径已有注释说明，勿误用。

Backend 向前端推事件：
```rust
app.emit("terminal-output", payload)?;
```

Tauri Commands 定义在 `src-tauri/src/commands/`，在 `src-tauri/src/lib.rs` 注册。
