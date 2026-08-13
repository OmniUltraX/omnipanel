# 局域网 OmniPanel 发现 Implementation Plan

> **For agentic workers:** 按任务顺序实现；步骤用 checkbox 跟踪。REQUIRED: executing-plans 或 subagent-driven-development。

**Goal:** 用 UDP 广播发现同局域网其它 OmniPanel 客户端，弹窗仅打开时扫描；进程运行即可被发现。

**Architecture:** Rust `lan_discovery` 模块：常驻 responder（候选端口 38451–38453）+ 弹窗驱动的 ephemeral scanner；前端 `LanDiscoveryScanDialog` 订阅 `lan-discovery-peers`。身份复用 `auth_device_identity` 的 `device_id` / `device_name` / `os_type`。

**Tech Stack:** Tauri 2 + tokio UDP、serde_json、React Modal、tauri-specta commands

## Global Constraints

- 中文回复；不擅自 git commit / push。
- 不删除原有注释；不写无关 README。
- 前端改完必须 `cd frontend && npx tsc -b` 通过。
- 新命令走 `commands.*` + `OmniError`；双注册 `collect_commands!` / `generate_handler!`；改完 `npm run gen:bindings`。
- 临时测试文件用完删除。

---

### Task 1: 协议解析（纯逻辑 + 单测）

**Files:**
- Create: `src-tauri/src/commands/lan_discovery/protocol.rs`
- Create: `src-tauri/src/commands/lan_discovery/mod.rs`（先 re-export protocol）

**Produces:**
- `CANDIDATE_PORTS: [u16; 3] = [38451, 38452, 38453]`
- `PROBE_INTERVAL_MS = 2000`, `PEER_TTL_MS = 6000`
- `DiscoveryMessage` enum / structs；`parse_message(bytes) -> Option<...>`；`encode_probe` / `encode_announce`
- `should_ignore_announce(local_id, local_ips, peer_id, src_ip) -> bool`
- `prune_stale(peers, now_ms, ttl_ms)`

- [ ] 实现 protocol + `#[cfg(test)]`：合法 probe/announce、坏 JSON、自 id 过滤、过期移除
- [ ] `cargo test -p omnipanel --lib commands::lan_discovery::protocol`（或 crate 名以实际为准）

### Task 2: UDP engine + Tauri 命令 + 启动挂钩

**Files:**
- Create: `src-tauri/src/commands/lan_discovery/engine.rs`
- Modify: `src-tauri/src/commands/lan_discovery/mod.rs`（命令）
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`（mod 已在 commands；collect_commands + generate_handler + setup 启动 responder）
- Manage: `LanDiscoveryHandle`（`app.manage`，勿硬塞进过大的 AppState 除非必要）

**Produces 命令:**
- `lan_discovery_start_scan() -> Result<(), OmniError>`
- `lan_discovery_stop_scan() -> Result<(), OmniError>`
- `lan_discovery_list_peers() -> Result<Vec<LanDiscoveryPeer>, OmniError>`
- `lan_discovery_status() -> Result<LanDiscoveryStatus, OmniError>`
- Event: `lan-discovery-peers` payload `{ peers: LanDiscoveryPeer[] }`（camelCase）

**Peer 字段:** `id, name, ip, version, os, lastSeen`（lastSeen 用 epoch ms，specta 用 f64 或 u64 按项目惯例）

- [ ] engine：responder bind 候选端口；scanner `:0`；probe 广播；announce 单播；emit 变更
- [ ] setup 里 `start_responder(app.handle())`（失败只 warn）
- [ ] version：`env!("CARGO_PKG_VERSION")`；identity：`auth::auth_device_identity` / 内部 load
- [ ] `cargo check -p omnipanel`（或 workspace 成员名）

### Task 3: 前端事件、弹窗、i18n

**Files:**
- Modify: `frontend/src/ipc/events.ts` 增加 `LAN_DISCOVERY_PEERS`
- Create: `frontend/src/components/lanDiscovery/LanDiscoveryScanDialog.tsx`
- Create: `frontend/src/components/lanDiscovery/LanDiscoveryScanDialog.css`（或沿用现有 modal/list class）
- Modify: `frontend/src/i18n/zh-CN.ts`、`en-US.ts`
- Run: `npm run gen:bindings`（根或 frontend）

- [ ] 弹窗 open→start+listen；close→stop+unlisten
- [ ] 列表 / 空态 / responder 失败提示
- [ ] `npx tsc -b`

### Task 4: 入口挂载（最小）

**Files:**
- 找一处低侵入入口（设置页或命令面板）；若短期无合适点，在 `App.tsx` / Shell 用开发期可开关亦可——优先设置「关于/高级」旁按钮打开弹窗。

- [ ] 用户可从 UI 打开扫描弹窗
- [ ] `tsc -b` 再跑一遍

### Task 5: 验证

- [ ] `cargo test` 相关 protocol 测例
- [ ] `cd frontend && npx tsc -b`
- [ ] 不 commit（除非用户要求）
