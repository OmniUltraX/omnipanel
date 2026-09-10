# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OmniPanel is an AI-native cross-platform engineering workstation for developers. It unifies terminal, SSH, database, Docker, server management, and AI assistance into a single desktop application.

**Status:** v0.8.21（事实源见 `CHANGELOG.md`）。桌面版（Tauri）与 Web 版（`crates/omnipanel-server` + axum）双形态，共用同一套前端与业务 crate。

> **本文档只记稳定约定。** 模块进度与版本以 `CHANGELOG.md` 为准，目录结构以实际代码为准。发现本文档与代码不一致时，以代码为准并顺手修正本文档。

已落地：终端、SSH/SFTP、文件、数据库（多引擎 + sidecar + DBX 插件）、Docker（本地 / 远程 Engine / SSH 宿主 / 宝塔 / 1Panel）、服务器面板、云厂商（阿里云 / 腾讯云）、协议实验室、AI 助手、工作流与任务中心、团队 / 客户端同步、插件平台（L1/L2/L3）。活跃方向见 `openspec/changes/`（23 个进行中变更）。

## Technology Stack

### Backend (Rust, edition 2024)

- **App framework:** Tauri 2.x（桌面）· axum 0.8 + tower（Web 版 `omnipanel-server`）
- **Async:** tokio · **IPC 类型生成:** tauri-specta（specta `2.0.0-rc.25`，含本地 patch `crates/specta-typescript-patch`)
- **Terminal:** portable-pty 0.8（VT 状态机自研；**已不使用** `alacritty_terminal`）
- **SSH:** russh 0.54（`ring` 后端，避免 aws-lc-rs 在 Windows 需要 NASM 构建链）+ russh-sftp
- **Database:** sqlx 0.8（MySQL / PostgreSQL）· redis 0.27 · mongodb 3.2 · ClickHouse；引擎以 feature 门面挂在 `omnipanel-db` 上（`engine-*` crate 是薄壳）。SQL Server / Oracle / 达梦 / Hive 走 sidecar 或 DBX 插件
- **Docker:** bollard 0.21（`default-features=false` + `pipe`，Windows 命名管道必需）
- **AI:** 自研 provider（reqwest + SSE）：OpenAI 兼容 / Anthropic / Ollama / ACP / CLI Agent；**已不使用** `rig` / `async-openai`
- **Storage:** rusqlite 0.32（bundled）+ keyring 3（凭据）+ argon2 / aes-gcm / x25519-dalek（加密与密钥交换）
- **HTTP / Protocols:** reqwest · tokio-tungstenite（WebSocket）· rumqttc（MQTT）· serialport · grpc
- **Plugins:** QuickJS（`plugin-js`）、WASM（`plugin-wasm`）、ed25519 签名包（`plugin-pkg`）

### Frontend (React + TypeScript)

- **UI:** React 19 · TypeScript · Vite · react-router 7 · Tailwind
- **State:** zustand 5（`src/stores` 是唯一可写状态处）
- **Layout:** dockview-react（面板 / 分栏）· react-resizable-panels · react-grid-layout
- **Editor:** CodeMirror 6（SQL / JSON / YAML）· Milkdown（知识库）· xterm 6 + addons（终端）
- **Data:** @tanstack/react-table + react-virtual（虚拟滚动表格）· @mui/material + x-charts
- **AI UI:** @assistant-ui/react · react-markdown · remark-gfm

## Project Structure

```
omnipanel/
├── src-tauri/                    # Tauri 桌面壳 —— 薄编排层，不写业务逻辑
│   ├── src/
│   │   ├── main.rs / lib.rs      # 入口 / Tauri Builder、插件与命令注册
│   │   ├── commands/             # 80+ Tauri Commands（只做参数桥接与事件 emit）
│   │   ├── state.rs              # 全局 app state
│   │   └── agent/ panel/ protocol/ background/ media_stream/ …
│   └── tauri.conf.json
├── crates/                       # 30 个领域 crate —— 业务逻辑都在这里
│   ├── omnipanel-core/           # 终端（portable-pty + VT 状态机）
│   ├── omnipanel-ssh/            # russh / SFTP 会话封装
│   ├── omnipanel-db/             # DbDriver trait + 各引擎（feature 门面）
│   │   └── engine-{mysql,postgres,clickhouse,mongodb,redis}/
│   ├── omnipanel-db-sync/        # 库同步与 diff
│   ├── omnipanel-docker/         # bollard 封装（本地 / 远程 / SSH 宿主 / 面板）
│   ├── omnipanel-ai/ -assistant/ -mcp/ -gateway/   # AI 三条能力线
│   ├── omnipanel-cloud/ + -aliyun/ + -tencent/     # 云厂商能力工作台
│   ├── omnipanel-plugin/ -pkg/ -js/ -wasm/         # 插件平台（签名 / QuickJS / WASM）
│   ├── omnipanel-store/          # rusqlite 本地库 + keyring 凭据 + 加密
│   ├── omnipanel-exec/           # 执行引擎 + Executor trait + 审计
│   ├── omnipanel-error/          # OmniError 统一错误模型
│   ├── omnipanel-transfer/ -everything/ -presence/ -s3/ -bg/
│   └── omnipanel-server/         # Web 版（axum）：/ipc/invoke + /ipc/events
├── frontend/                     # 前端（React + TypeScript）
│   ├── src/
│   │   ├── modules/<feature>/    # 23 个功能模块 UI（terminal / ssh / database / …）
│   │   ├── stores/               # zustand，唯一可写状态处
│   │   ├── components/           # 跨模块复用 UI（shell / ai / dock / ui / …）
│   │   ├── ipc/                  # 自动生成的 bindings（勿手改）
│   │   └── lib/ i18n/ hooks/ contexts/ types/ routes/
│   └── package.json
├── openspec/                     # spec-driven 变更（changes/ 进行中，specs/ 已归档）
├── docs/                         # ARCHITECTURE.md（协作约定事实源）、web/、plugins/
├── website/                      # 产品官网（GitHub Pages）
├── design/ plugins/ plugins-samples/ packages/ miniapp/
└── CHANGELOG.md                  # 版本事实源
```

crate 边界、错误处理、安全基线、测试约定的完整说明见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## Build Commands

```bash
# 安装依赖
npm run install:all          # frontend + website
cd frontend && npm ci        # 只装前端

# 开发
npm run tauri dev            # Tauri + Vite（完整桌面应用）
npm run dev:frontend         # 仅前端（无 Tauri）
cd frontend && npm run dev

# 构建
npm run build:frontend       # tsc -b && vite build
npm run tauri build          # 桌面发版构建

# Web 版
cd frontend && OMNIPANEL_WEB=1 npm run build
cargo run -p omnipanel-server -- --static-dir frontend/dist --port 8899

# Rust
cargo build                  # 整个工作区
cargo test                   # 全量测试
cargo test -p omnipanel-core # 单 crate 测试
cargo fmt --check

# IPC 与插件（改了命令 / 插件必跑）
npm run gen:bindings         # 重新生成 frontend/src/ipc/bindings.ts
npm run check:ipc-registry   # 校验命令双清单一致
npm run plugin:validate      # 校验插件清单
```

> **`lint` 目前是空实现**（`frontend/package.json` 里是 `console.log('lint disabled')`），CI 不会拦 lint。质量门禁实际落在 `tsc -b` 上，本地务必跑。

## Mandatory Type Check (强校验)

**所有前端代码变更完成后，必须运行 `tsc -b` 通过后才能视为完成。** 这是发版流水线（`tauri-apps/tauri-action` → `build:ci` → `tsc -b && vite build`）的强校验门禁。

**注意：这个门禁只在发版 tag 时才跑，日常提交与 PR 没有任何 CI 会拦你**（见下方「CI 现状」）。所以本地跑是唯一防线，不跑就等于把问题攒到发版时炸。

```bash
cd frontend && npx tsc -b
```

- 零 error 才算通过；warning 可接受但建议修复。
- 新增/删除 import 时同步检查未使用变量（TS6133）。
- 类型变更时检查跨文件兼容性（TS2322/TS2345 等）。
- 测试文件的类型必须与被测代码的签名严格匹配，不要用 `typeof` 推断具体字面量类型代替 `Record<string, ...>` 等宽泛类型。

## CI 现状（重要）

| Workflow | 触发条件 |
|----------|----------|
| **`pr-check.yml`（日常门禁）** | **PR / push master** —— `tsc -b` + `vitest run` + `check:ipc-registry` + `cargo check --workspace` |
| `ci.yml` | push tag `v*` / 手动 |
| `build.yml`（发版构建） | push tag `v*` / 手动 |
| `docker-web.yml` | push tag `v*` / 手动 |
| `deploy-website.yml` | push master（`website/**`）/ 手动 |
| `publish-plugin-registry.yml` | push master（`plugins/**`） |
| `warm-cache.yml` | push master（依赖变更）/ 每周一 |
| `ghcr-public.yml`、`plugin-submissions.yml` | 手动 / 定时 |

`ci.yml` 只跑 **ubuntu-latest**，内容是 IPC 注册表校验、插件清单与冒烟、部分 crate 测试、前端 build——**不含** `cargo fmt --check` / `cargo clippy` / `eslint` / `vitest`。

**Rust 格式规则**：仓库**没有** `rustfmt.toml`，用的是 `edition = "2024"` 默认 `style_edition`（import 排序为大写类型在前）。2026-09-10 已全量 `cargo fmt --all` 对齐过（93 个文件），`pr-check.yml` 已启用 `cargo fmt --all --check`。

> **不要**改设 `style_edition = "2015"`：代码主体是按 2024 规则写的，改回旧规则会产生 **786 处** diff（比沿用 2024 的 381 处更糟）。

提交前本地至少跑：

```bash
cd frontend && npx tsc -b        # 类型门禁（必须零 error）
cd frontend && npx vitest run    # 1024 个测试，约 2 分钟
cargo fmt --all --check
cargo check --workspace
cargo test
```

> `docs/ARCHITECTURE.md` 第 8 节写「PR 必须通过 ci.yml，含 fmt/clippy/eslint/vitest，覆盖三平台」——**与当前配置不符**，以本表为准。

## Release / Commit Docs Sync（发版与提交文档同步）

**只要涉及发版、打 tag、版本 bump，或用户明确要求「提交 / 发版 / 发布」时，必须同步更新对外文档与官网，不得只改代码或只改 CHANGELOG。**

> **版本事实源是 git tag，不是 `Cargo.toml`。** 发版时 `build.yml` 把 tag 版本（去掉 `v` 前缀）写回 `src-tauri/tauri.conf.json` 与根 `Cargo.toml`，再从 `CHANGELOG.md` 提取对应 `## [x.y.z]` 段落作为 release notes。所以工作区里这两个文件的版本号长期停在旧值（当前 `0.0.5`），**不代表应用当前版本**——查版本看 `CHANGELOG.md` 或 release tag。
>
> 推论：**手动触发 `build.yml` 会用 `Cargo.toml` 里的陈旧版本号**（当前会构建 `v0.0.5`），只发 draft，但 release 名与 tag 会是错的。手动试构建前先确认。

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
- **禁止循环依赖（前端）：** store 与模块双向 import 会打乱 ESM 求值顺序，表现为运行期 store 是 `undefined`（如 `useTerminalStore.subscribe` 报 "Cannot read properties of undefined"），且**让出一个微任务也不够**——要等整条同步加载链走完。需要"反向通知"时用回调注册，参考 `frontend/src/lib/assistantSnapshotSyncBridge.ts`（`modules/assistant` ↔ `stores/terminalStore` 就是这么解开的）。

## 模块现状（原 Development Phases 已作废）

原 Phase 0–5 计划早已走完或被重构，**不再作为进度依据**。当前能力覆盖如下，细节以 `CHANGELOG.md` 与代码为准：

| 域 | 覆盖情况 |
|----|----------|
| 终端 | 多标签 / 分屏、Blocks 输出分组、会话 Plan、tmux 远端会话治理 |
| SSH / SFTP | 连接管理、隧道、跳板机、文件传输、能力探测 |
| 文件 | 本地 / 远端浏览、收藏、跨连接传输 |
| 数据库 | SQL 编辑器、虚拟滚动网格、NL2SQL、库同步；内置引擎 + sidecar（ClickHouse / MongoDB / SQL Server）+ DBX 插件（Oracle / 达梦 / Hive）；方言家族工作台 |
| Docker | 本地 / 远程 Engine / SSH 宿主 / 宝塔 / 1Panel，容器 / 镜像 / Compose / 网络 / 卷 |
| 服务器 | 主机监控；宝塔 / 1Panel（站点、应用、证书、计划任务） |
| 云厂商 | 阿里云、腾讯云——账户 → 能力 → 实例的能力工作台 |
| 协议实验室 | HTTP / WebSocket / MQTT / Serial / gRPC |
| AI | 三条能力线：内置编排器（`ai_chat_stream`）、Agent Router（`:8765`）、OmniMCP（`:12756`） |
| 工作流 / 任务 | 模板、runbook、任务中心与待办、Quick Launcher、可审计执行 |
| 同步 | 团队同步（`sync_key_v2` + 密钥中继）、客户端快照同步 |
| 插件 | L1 声明式 / L2 logic.js·wasm / L3 沙箱 UI；签名安装 + 插件中心 + Studio |
| 安全 | 在场验证（Windows Hello / Touch ID 或短命 token），危险操作按 action+target 一次性消费 |

进行中的变更提案见 `openspec/changes/`；产品需求见 `PRD.md`。

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
