## Why

当前插件系统是“自嗨式”：17 个第一方插件编译进包（`include_str!` + 前端静态 `import`），第三方只能填 `plugin.json` 声明式表单，无法交付自己的前端逻辑/自定义 UI/重型后端能力。`pluginRuntimeLoader.ts` 硬编码 4 个 id，L2 WASM 参数透传占位，L3 iframe 只有壳无桥，SDK 未发 npm，签名只有单官方 dev key。要做真正的开放生态，必须把“静态编译”改为“动态装载 + 分级执行 + 可分发”。

## 目标

- 去硬编码：任何 `.omni-plugin` 磁盘包的前端 `activate`/`deactivate` 可被动态发现并执行，与第一方同一条生命周期路径。
- L2 真可用：QuickJS `logic.js` 磁盘加载 + wasmtime 参数透传打通 + prod 环境闸 + 超时/内存可观测。
- L3 可用：沙箱 iframe + postMessage 白名单桥（Host API 子集，逐条过权限闸，带 pluginId+nonce）+ Overlay 自定义渲染。
- 可分发：`plugin.json` schema 定版（`minHostApi` 强制检查）、多公钥验签、安装/覆盖升级/卸载、安装时权限确认页。
- 可开发：`@omnipanel/plugin-sdk` 可构建可外部引用、脚手架支持 `engine/module/cloud/panel/importer/addon-theme/l3` 全模板、开发者文档可照做 L1/L2/L3 包。

影响 Phase：插件平台（无独立路由，贯穿 `/settings` 插件页、`/database`、`/server`、module 路由、overlay 全局）。涉及 PRD “开放生态”诉求（PRD.md 插件章节）。

## 非目标（Non-goals）

- 不做在线市场/商店 UI 与自动更新 CDN（本期只做本地 `.omni-plugin` 文件分发 + 本地 registry，联网市场远期）。
- 不做任意原生 `.dll/.so` 动态加载；不放开主 IPC `collect_commands!` 给第三方；Terminal PTY / SSH 协议栈 / Vault 实现仍为内核。
- 不在本期做完整 Nacos 产品或翻译 addon 全功能；L3 本期只打通 1 个最小闭环（选区→Overlay→net）。
- 不改现有 17 个第一方插件行为（只迁移装载路径，行为对照 `plugin-host-sdk` 验收清单不回退）。

## 背景与动机

- `plugin-open-platform` 阶段 A 已完成单源 + 真实 activate + 权限下沉，但阶段 B 的 `7.3/7.4/8.x/9.x` 未做（见 `openspec/changes/plugin-open-platform/tasks.md`）。
- 第三方视角阻塞 Top3：前端入口不认第三方 id、L3 无桥、WASM 半成品。导致“似乎很多功能无法实现”。
- 现在是补齐时机：L1 链路（pack→verify→extract→load_installed）已有集成测试，只需在其上叠加动态前端装载与执行器补齐即可开放。

## What Changes

- **动态装载**：`pluginRuntimeLoader` 从静态 `PLUGIN_MODULES` 改为“静态（第一方）+ 动态（磁盘包 `ui/main.js` 沙箱求值后注册）”双源；`plugin_manifests` IPC 已含已安装清单，前端按 `enabled+activated` 差量 `activate/deactivate`（先卸后启不变）。
- **L2 执行补齐**：Rust `plugin_invoke` 保持“原生网关优先 → L2 实例兜底”；WASM `run_call` 参数透传（JSON→内存 alloc 写入）；QuickJS 磁盘包 `logic.js` 加载（复用现有 JsExecutor，加文件大小/超时限制）；`net.fetch` 命中 `env_tag=prod` 强制弹窗确认，不可绕过；超时/异常透出可读错误 + audit。
- **L3 沙箱桥**：`PluginSandboxFrame` 保持 `sandbox="allow-scripts"` 无 `same-origin`；新增消息白名单（`ui.overlay.show/hide`、`selection.get`、`invoke`、`net.fetch` 经后端闸）+ `pluginId+nonce` 校验；越权拒绝 + `audit_log action=plugin.bridge.blocked`；`PluginOverlayHost` 支持渲染插件 `ui/index.html`（经 `plugin_read_asset` 白名单）。
- **分发与安全**：`.omni-plugin` zip 结构定版（`plugin.json` + `assets/` + 可选 `logic.js/logic.wasm` + 可选 `ui/`）；ed25519 多公钥验签（保留 dev key，新增配置位）；`plugin_install_from_file/uninstall` 复用现有命令，加 `minHostApi` 兼容拒绝 + 内置 id 冲突保护；设置页加权限确认页（安装时展示 `permissions[]+methods[]`）。
- **SDK 与脚手架**：`packages/plugin-sdk` 构建产物可用（`tsc` + `package.json exports`，npm 发布流程文档化但本期可先本地 `file:` 引用验证）；`scripts/create-plugin.mjs` 补 `js-logic/wasm-stub/l3-overlay` 三模板；`docs/plugins/` 补清单参考/权限模型/三级梯度/调试指南。
- **BREAKING**：无。对第一方行为保持兼容；仅新增磁盘包动态路径与 L3 桥消息协议。

## Capabilities

### New Capabilities

- `plugin-dynamic-loader`: 磁盘包前端逻辑动态发现与差量生命周期（去硬编码）。
- `plugin-logic-runtime`: L2 QuickJS/WASM 磁盘装载、参数透传、prod 闸、可观测错误。
- `plugin-sandbox-ui`: L3 iframe 沙箱桥白名单与 Overlay 自定义渲染。
- `plugin-distribution`: 包格式定版、多公钥验签、安装/升级/卸载、权限确认、兼容检查。
- `plugin-devkit`: SDK 构建与引用、脚手架全模板、开发者文档。

### Modified Capabilities

- 无（`openspec/specs/` 为空；既有 `plugin-open-platform` 三 spec 为 change 内 spec，不在此列）。

## Impact

- 前端：`frontend/src/lib/pluginRuntimeLoader.ts`、`pluginManifests.ts`、`pluginHost.ts`、`components/plugin/PluginSandboxFrame.tsx`、`components/ui/overlay/PluginOverlayHost.tsx`、设置页插件安装/权限确认 UI。
- 后端：`src-tauri/src/commands/plugin.rs`（验签多 key、minHostApi、bridge audit）、`crates/omnipanel-plugin-{pkg,js,wasm}`（装载与 ABI）、`crates/omnipanel-plugin/src/{manifest,registry,executor}.rs`。
- 工具：`scripts/{create-plugin,check-plugin-manifests,validate-plugin}.mjs`、`packages/plugin-sdk` 构建、`docs/plugins/*`。
- 依赖：wasmtime/QuickJS 已有 feature，无新增原生依赖；L3 无额外 npm 依赖。

## 成功标准

- 未签名的 L1 包在 dev 可装、release 被拒；篡改一字节验签失败（既有单测保持）。
- 第三方 L1/L2-JS/L3 各 1 个样板包可经“设置页选文件→权限确认→启用→功能出现→禁用消失→卸载”全链路（手动 + 集成测试）。
- 禁用 Everything 后 `es` 前缀消失、启用恢复（`2.1` 验收落定）。
- WASM 回显方法可透传 JSON 参数并返回；缺权调用 trap + audit；prod 主机 `net.fetch` 弹窗确认，超时 60s 拒绝。
- L3 样板可在 Overlay 显示自身 UI；桥越权消息被拒并有 `plugin.bridge.blocked` 审计。
- `cd frontend && npx tsc -b` 零 error；`cargo test -p omnipanel-plugin -p omnipanel-plugin-pkg -p omnipanel-plugin-js -p omnipanel-plugin-wasm` 通过；清单 CI 全绿。
- 第三方按文档从零做出 L1 包（文档可用性验收）。
- 生产环境数据修改一律经环境标签（`env_tag=prod` 二次确认）与 `dangerAction presenceToken`，无绕过路径。
