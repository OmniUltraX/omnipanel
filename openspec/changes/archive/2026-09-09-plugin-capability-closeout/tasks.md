一次只做一节。勾完再开下一节。新想法另开 change，不往这里塞。

前端：文案走 i18n 中英；IPC 走 `commands.*` + `unwrapCommand`；`npm run gen:bindings`；不跨 module import；按钮用 `WorkbenchPanelHeader` / `WorkbenchActionButton`。做完前端跑 `cd frontend && npx tsc -b`。

## 0. AI 脚手架账本（studio-ai-audit）

- [x] 0.1 点「按描述生成」时写 audit `plugin.ai_scaffold`（prompt sha256+len，不落原文）：`src-tauri/src/commands/plugin_studio.rs` 或现有 audit 桥。验证：单测摘要不含原文
- [x] 0.2 对齐文案与 `openspec/changes/plugin-ide/specs/plugin-ai-scaffold/spec.md` 叙事（主路径是 Dock + `omni_studio_*`，oneshot 不是脚手架）。验证：工作台按钮仍走 `askAiFromSurface`；`tsc -b`

## 1. 发行版工作台（studio-user-projects）

- [x] 1.1 工程根解析：`app_data/plugin-projects/` 为主，开发态并集 `plugins-custom/`；新建只写用户目录。`src-tauri/src/commands/plugin_studio.rs`。验证：越界单测仍拒绝；无 `repo_root` 时 list 不报「仅源码」
- [x] 1.2 `StudioProject` 增 `location: "user" | "repo"`；`collect_commands!` 双处已有命令则只改返回体；`npm run gen:bindings`。验证：bindings 含字段
- [x] 1.3 validate/pack 走应用内 Rust（清单校验 + `omnipanel-plugin-pkg`），不再 `cargo run` / 仓库 node 脚本。`plugin_studio.rs` run 白名单。验证：无 cargo 时 JS 工程可打包单测或手动
- [x] 1.4 前端列表标注来源、空态去掉「仅源码」误导：`frontend/src/modules/studio/`、`i18n/locales/{zh-CN,en-US}/plugins.ts`。验证：vitest 或手动；`tsc -b`
- [x] 1.5 `omni_studio_*` 描述与实现改扫用户目录（开发态并集）：`builtin_tool_spec.rs`、`frontend/src/modules/studio/ai/mcpTools.ts`。验证：cargo test studio_；vitest store/tools

## 2. 主题应用（plugin-theme-apply）

- [x] 2.1 SDK/Rust/CI 确认 `contributes.themes.tokens` 为资源路径（默认 `tokens.json`）：`packages/plugin-sdk`、`crates/omnipanel-plugin/src/manifest.rs`、`scripts/check-plugin-manifests.mjs`。验证：非法路径 CI 失败
- [x] 2.2 前端读已启用 theme 的 tokens（`plugin_read_asset`），写入 CSS 变量；失败回落内置 default。新小模块或 `frontend/src/lib/` 主题应用，不跨 module import。验证：vitest 解析非法 JSON 不抛
- [x] 2.3 `frontend/src/modules/terminal/terminalTheme.ts` 改为读应用后的 palette，去掉静态 import `plugins/theme-default/tokens.json`。验证：手动切启用 theme 终端色变；`tsc -b`
- [x] 2.4 多 theme 单活（最近启用）。验证：先后启用 A/B，生效 B

## 3. 运行时验收（plugin-runtime-acceptance）

- [x] 3.1 手动：L3 overlay 样板浮层显示自身 HTML；越权桥有 `[plugin-bridge] blocked` 或 audit。修发现的 bug 于 `PluginSandboxFrame.tsx` / `PluginOverlayHost.tsx`
- [x] 3.2 手动：prod 主机 L2/L3 联网取消=不发网，audit `plugin.permission/blocked`。缺口补 `plugin_bridge.rs` / `pluginConfirm.ts` 单测（超时=拒绝）
- [x] 3.3 手动：release 官方未签目录可浏览；未签 `.omni-plugin` 安装被拒。对照 `verify_registry_allow_unsigned`。验证：市场不再误报 `all sources unavailable`（官方源）

## 4. 面板清单切片（panel-manifest-host）

- [x] 4.1 未知 `panelTabs` id 走通用壳（表单 + `plugin_invoke`）：`frontend/src/modules/server/panel/`，复用 module `GenericCapabilityPane` 模式但**不 import studio/plugins 模块**（抽已有公共层或 panel 内复制最小壳）。验证：vitest 未知 id 映射到通用壳
- [x] 4.2 样板 `plugins-samples/panel-starter`（自定义 tab + echo method）+ `create-plugin` 配方可选。验证：`validate-plugin` 通过；`check-plugin-manifests`
- [x] 4.3 安装启用样板后服务器面板出现该 tab，换 id 仍可用（无 ID 特判）。验证：手动；`tsc -b`

## 5. 云 L2 样板（cloud-l2-sample）

- [x] 5.1 样板 `plugins-samples/cloud-l2-starter`：`kind=cloud` + 一条 capability + `logic.js` 只读列表。验证：`validate-plugin` 通过
- [x] 5.2 云工作台按清单登记能力槽，禁用消失；**不改** `omnipanel-cloud-*`。`frontend` 云 Host / capability 消费处。验证：vitest 或手动；无样板 id 硬编码（grep）

## 6. UI 沙箱合同（plugin-ui-sandbox-contract）

- [x] 6.1 `pluginRuntimeLoader.test.ts` 补：非法 activate、隔离失败、超体积（若可测）。`frontend/src/lib/pluginRuntimeLoader.ts`
- [x] 6.2 `docs/plugins/README.md` 一小节：Function 沙箱 vs Overlay iframe，不另开文档。验证：对照 D6

## 7. SDK 发版就绪（sdk-npm-ready）

- [x] 7.1 CI 增加或对齐 `packages/plugin-sdk` 的 `npm run build && npm pack --dry-run`。验证：CI 绿
- [x] 7.2 对照 `docs/plugins/sdk-release.md` 与 `HOST_API_VERSION`；无 npm 账号则本任务视为完成。验证：文档一行不矛盾

## 8. 回归

- [x] 8.1 `cd frontend && npx tsc -b` 零 error；相关 vitest；`cargo test -p omnipanel-plugin -p omnipanel-plugin-pkg`；`check-plugin-manifests`；`validate-plugin plugins-samples`（含新样板）。验证：全绿
