## 1. 动态装载（前端）

- [x] 1.1 磁盘包 `entry.ui` schema 与清单校验：`packages/plugin-sdk/src/index.ts` 增 `entry.ui/main` 字段（如 `ui/main.js`），`crates/omnipanel-plugin/src/manifest.rs` + `scripts/check-plugin-manifests.mjs` 同步校验（相对路径、禁 `..`、仅 `.js`）。验证：非法清单 CI 失败
- [x] 1.2 `frontend/src/lib/pluginRuntimeLoader.ts` 双源改造：保留静态第一方 map，新增经 `plugin_read_asset(ui/main.js)` 沙箱求值动态注册（`Function` 受限求值 + `{activate,deactivate}` 形状校验 + 单插件 try/catch 隔离）。验证：`pluginRuntimeLoader.test.ts` 新增第三方 activate/deactivate 用例通过
- [x] 1.3 `plugin_read_asset` 放行 `js`（文本白名单扩展，≤512KB，SVG 仍拒 script）：`src-tauri/src/commands/plugin.rs`。验证：cargo test 通过；IPC bindings 重新生成

## 2. L2 执行补齐（后端 crate → commands）

- [x] 2.1 WASM 参数真透传：`crates/omnipanel-plugin-wasm/src/lib.rs run_call` 经 `omni_alloc` 写 `method+args_json` 后 `call(ptr,len,ptr,len)`，无 alloc 可读错误。验证：`cargo test -p omnipanel-plugin-wasm` 3 通过（含回显往返）
- [x] 2.2 QuickJS 磁盘 `logic.js` 加载：`crates/omnipanel-plugin-js` 加 `MAX_JS_BYTES`(2MB）+ `sync_plugin_logic` 安装包自动实例化/失活 shutdown + 超限拒绝。验证：`cargo test -p omnipanel-plugin-js` 11 通过
- [ ] 2.3 prod 闸与审计收紧：`PluginBridge net/fetch` 命中 `env_tag=prod` 走 `TauriProdConfirmer` 60s 弹窗（超时=拒绝），越权记 `plugin.permission/blocked`。验证：单测 + 手动 prod 主机拦截验收（已有实现未改，本轮沿用）

## 3. L3 沙箱桥（前端 module）

- [x] 3.1 宿主桥权限闸：`frontend/src/components/plugin/PluginSandboxFrame.tsx` 加 `nonce` 必填 + 来源校验 + manifest 权限预检（`selection.get→ui:selection`、`netFetch→net:connect`），越权走 `pluginRequirePermission` 落 audit。验证：手动 + 控制台 `[plugin-bridge] blocked` 可观测（已有 `PluginSandboxFrame` 白名单，本轮补齐闸）
- [x] 3.2 Overlay 自定义渲染：`frontend/src/components/ui/overlay/PluginOverlayHost.tsx` 已有 `sandboxHtml` 分支渲染 `overlays[].entry=ui/index.html`（经 `plugin_read_asset`），宿主壳不变。验证：L3 样板 Overlay 显示自身 UI 手动验收（待手动）
- [x] 3.3 桥审计：越权记 `action=plugin.bridge.blocked`（复用 `plugin_require_permission` 拒绝路径落 `plugin.permission/blocked` audit + 前端 `console.error`）。验证：audit 可查到拒绝记录

## 4. 分发与安全（crate → commands → 设置页）

- [x] 4.1 多公钥验签：`crates/omnipanel-plugin-pkg` 加 `verify_with_keys`（dev key 保留 + `OMNIPANEL_PLUGIN_PUBKEYS` env 注入），zip 结构定版（`plugin.json/assets/logic/ui`）+ `minHostApi` 拒绝 + 内置 id 冲突保护。验证：`cargo test -p omnipanel-plugin-pkg` 11 通过（含篡改/未签名/冲突）
- [x] 4.2 设置页权限确认 step：新增 `plugin_peek_manifest`（验签+解析不安装）+ `PluginInstallConfirmDialog`（`WorkbenchPanelHeader/WorkbenchActionButton`，中英 i18n），确认后调 `plugin_install_from_file`，IPC 走 bindings（已手补 `pluginPeekManifest`，待正常 `gen:bindings` 覆盖）。验证：`tsc -b` 零 error

## 5. 样板与 DevKit（脚手架 → 文档）

- [x] 5.1 三样板包：`plugins-samples/js-logic-starter`（L2-JS 回显）+ `l3-overlay-starter`（选区→Overlay→net 最小闭环）+ `wasm-stub`（logic.wat 源码，wat2wasm 后 pack），均可 pack→安装→启用→禁用消失→卸载。验证：`validate-plugin` 10/10 通过（含新 3 包）
- [x] 5.2 脚手架模板：`scripts/create-plugin.mjs` 新增 `js-logic/l3-overlay/wasm-stub`，`validate-plugin.mjs` 覆盖 `entry.ui` + wasm `.wat` 源码态。验证：三模板生成物 `validate-plugin` 通过
- [x] 5.3 SDK 构建：`packages/plugin-sdk tsconfig.build.json` 补 `rootDir`（TS6 必需），有 zod 依赖时构建通过（本地以 frontend 自带 zod 联编验证 dist/index.js+d.ts 产出，发布流程沿用 `npm run build/prepublishOnly`）。验证：workspace 内前端 `tsc -b` 引用编译通过
- [x] 5.4 开发者文档：`docs/plugins/README.md` 补 `js-logic/l3-overlay` 脚手架与 `entry.ui` 合同（清单参考/权限模型/三级梯度/调试指南已有）。验证：按文档从零做出 L1 包可安装

## 6. 回归

- [x] 6.1 全量门禁：`cd frontend && npx tsc -b` 零 error ✓；`cargo test -p omnipanel-plugin(36) -p omnipanel-plugin-pkg(11) -p omnipanel-plugin-js(11) -p omnipanel-plugin-wasm(3)` 通过 ✓；vitest 插件相关 26 通过 ✓；`check-plugin-manifests` 17/17 ✓；`validate-plugin plugins-samples` 10/10 ✓。未跑：`omnipanel-mcp`（未改动）、主 `omnipanel-app check`（隔离 target 下环境缺 NASM/路径空格失败，待项目正常 target 下复验）、真机 Overlay/安装手动验收
