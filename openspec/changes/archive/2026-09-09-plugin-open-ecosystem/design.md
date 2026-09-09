## Context

现状（`openspec/changes/plugin-open-platform/tasks.md`）：阶段 A 基本完成（单源清单、前 4 插件真实 activate、网关权限+审计）；阶段 B 完成 L1 链路（`omnipanel-plugin-pkg` pack/verify/extract + `load_installed` + 集成测试）与执行器骨架（`RouterExecutor{Wasm,Js}` + `PluginBridge` + `sync_plugin_logic`）。残留：`pluginRuntimeLoader.ts:20-25 PLUGIN_MODULES` 硬编码 4 id；WASM `run_call` 参数透传占位；L3 `PluginSandboxFrame.tsx` 已有 prelude 桥但宿主侧权限闸 + Overlay 渲染未接通；SDK 未构建发布；签名单 dev key。

约束：Tauri 2.x + React 18 + specta IPC；crate 单向依赖；`src-tauri/commands/` 只桥接；前端模块不互 import；凭据只存 keyring；prod 二次确认不可绕过。

## Goals / Non-Goals

**Goals:**

- 第三方磁盘包与第一方走同一生命周期：清单合并 → 差量 activate/deactivate → 贡献消失/出现。
- L2/L3 最小闭环可用且安全：缺权 trap、越权 bridge 拒绝 + audit、prod 弹窗。
- 开发者可照文档做出包：模板 + 校验 + 调试指南。

**Non-Goals:**

- 在线市场/自动更新；原生 dll/so；放开主 IPC；重型新依赖（wasmtime/QuickJS 复用现有）。

## Decisions

### D1 双源前端装载（静态第一方 + 动态磁盘包），不直接 `import()` 磁盘任意 JS

- crate/commands/frontend 边界：Rust 只下发清单 JSON（已有 `plugin_manifests` IPC）；前端 `pluginRuntimeLoader` 负责解释。
- 第一方：保留静态 `PLUGIN_MODULES`（Vite 可 tree-shake，首屏快）。
- 第三方：磁盘包约定 `ui/main.js` 为 UMD/IIFE，经 `plugin_read_asset`（文本白名单已含 js？需放行 `js` 且 ≤512KB，SVG 仍拒 script）读回后在受限 `Function("definePlugin","host","manifest", code)` 沙箱求值，返回值须为 `{activate,deactivate}`，否则 `unsupported_reason=ui.invalid_entry`。
- 备选（Vite 动态 import blob URL）否决：WebView 下 blob import 语义不稳定，且与 CSP 冲突；Function 求值可控且可 try/catch 隔离单插件失败。
- 联动：`syncModuleLauncherProviders/launcher/importer/discovery` 保持读 Catalog，不感知装载方式。

```
Registry(Rust include_str! + app_data/plugins/<id>/)
  → plugin_manifests IPC (JSON string, 避 Value 递归)
  → Catalog(pluginManifests.ts 合并)
  → syncPluginLifecycles(items)
      ├─ 第一方: PLUGIN_MODULES[id].activate({host,manifest})
      └─ 第三方: read_asset(ui/main.js) → sandboxEval → activate
  → Host(pluginHost.ts: selection/connections.upsert/invoke/overlay)
```

### D2 L2 保持“原生优先 → 实例兜底”，补齐 ABI 与磁盘加载

- crate 边界：`omnipanel-plugin::{executor,manifest,registry}` 定 ABI；`omnipanel-plugin-{js,wasm}` 只做引擎；`commands/plugin.rs: sync_plugin_logic + invoke_plugin_method` 做装配（权限闸在路由前）。
- WASM：`run_call` 改为真透传——`method+args_json` 经 `omni_alloc` 写入客体内存再 `call(ptr,len,ptr,len)`；无 `omni_alloc` 则可读错误（已有语义）。客体返回 `(len<<32)|ptr`，最高位 1 = 错误文本。
- JS：新增 `load_js_from_file` 路径（大小 ≤2MB，单次 10s 中断已有），磁盘包 `entry.logic=.js` 走此路；内存/栈上限不变。
- prod 闸：`PluginBridge::net_fetch/fs` 命中 `env_tag=prod` 经 `TauriProdConfirmer` 60s 弹窗，超时=拒绝（复用 `plugin_bridge.rs:240-268`）。
- 备选（wasi-nn/组件模型）否决：ABI 已定 `memory+call+omni_alloc`，换模型要重写全部客体，本期只打通透传。

### D3 L3 沙箱：已有的 `PluginSandboxFrame` prelude 为准，宿主侧加闸

- frontend 边界：`PluginSandboxFrame`（`sandbox="allow-scripts"` 无 same-origin + srcdoc CSP `default-src 'none'`）不变；新增 `usePluginSandboxBridge` hook 处理 `message` 事件：校验 `__omni+nonce` → 查 manifest 白名单（`permissions[]` + `methods[]`）→ 调 `pluginHost`/IPC → 回 `response/error`。
- 白名单方法即现有 `SandboxRequestMethod` 四种（`selection.get/invoke/netFetch/overlay.hide`），`invoke` 再走后端 `plugin_invoke` 二次闸；越权记 `audit_log action=plugin.bridge.blocked`（新增 IPC `plugin_bridge_audit` 或复用 `plugin_require_permission` 拒绝路径）。
- `PluginOverlayHost` 加分支：若 active 插件 `overlays[].entry=ui/index.html` 且 `plugin_read_asset` 通过（html/htm 白名单已含），则渲染 `PluginSandboxFrame(html)`，宿主壳（标题/关闭）不变。对齐 `components/ui/*` 与 `tokens.css`。
- 联动：选区总线（`ui:selection`）→ Overlay → `net:connect` 即 L3 样板闭环。

### D4 分发：定版 zip + 多公钥 + 权限确认，不做市场

- commands 边界：复用 `plugin_install_from_file/uninstall`；`omnipanel-plugin-pkg` 加 `verify_with_keys(&[pubkey])`（dev key 保留 + 从配置/环境注入正式 key），release 未签名仍 `UnsignedRejected`。
- zip 结构定版：`plugin.json / assets/* / logic.(js|wasm)? / ui/(main.js|index.html)?`；`manifest.minHostApi > HOST_API_VERSION(=1)` 拒绝装载（`manifest.rs:170-176` 已有）；同 id 内置冲突保护（已有）+ 覆盖升级语义。
- 前端设置页：安装 dialog 后加权限确认 step（展示 `permissions[] + methods[][name/permissions/dangerAction]` + 中英 i18n），确认后才调 install；复用 `WorkbenchPanelHeader/WorkbenchActionButton`（见 AGENTS.md）。
- specta：若新增 `plugin_bridge_audit`，经 `collect_commands!` + `bindings.ts` 重新生成，禁止手写命令字符串。

### D5 DevKit：先本地可引用，再谈 npm 发布

- `packages/plugin-sdk` 加 `tsup/tsc` 构建 + `exports`，本期先以 `file:` 本地验证 + 文档化发布流程（`tasks 9.1` 拆两步，避免被 npm 账号阻塞）。
- `scripts/create-plugin.mjs` 新增 `js-logic / wasm-stub / l3-overlay` 三模板至 `plugins-custom/`；`check-plugin-manifests/validate-plugin` 覆盖新字段（`entry.logic/ui`、`overlays`、`minHostApi`）。
- `docs/plugins/` 四篇：清单参考、权限模型、三级梯度、调试指南（dev 未签名包 + `console.error [plugin-runtime]` + audit 查看位）。

## Risks / Trade-offs

- [Risk] `Function` 求值第三方 JS 仍在主 WebView 线程，异常可隔离但性能互相影响 → Mitigation：try/catch 单插件隔离 + 文档声明“重逻辑走 L2/sidecar”，L3 只做展示。
- [Risk] WASM ABI 透传改动引入内存越界 → Mitigation：沿用 `LEN_ERROR_BIT` 编码 + 非法 wasm 拒绝单测 + `dedot` 路径禁锢复用。
- [Risk] 多公钥配置漂移（dev/release 不一致）→ Mitigation：`verify_with_keys` 单测覆盖 dev/release 双路径；正式 key 注入走构建期 env，不落代码。
- [Risk] 第一方迁移回归 → Mitigation：`plugin-host-sdk` 验收清单对照 + `tsc -b`/cargo/vitest/清单 CI 全绿门禁。
- [Trade-off] 本期不做 per-host 授权（`net:connect` 一开即全网，仅 prod 弹窗），文档明示，后续迭代补安装时 host 白名单。

## Migration Plan

1. 先加法不改旧：动态装载/WASM 透传/桥 hook/权限确认均为新增分支，第一方静态路径不动。
2. 样板先行：`plugins-samples/{l1-starter,js-logic-starter,l3-overlay-starter}` + `wasm-stub` 经新链路装载，官方 17 插件行为对照不回退。
3. 回滚：任一分支失败可 feature-gate 关闭（`plugin-wasm` feature 已有；前端动态装载以 `entry` 缺失降级为 L1），不阻塞发布。

## Open Questions

- `plugin_read_asset` 是否放行 `js`：需确认 ≤512KB 文本白名单扩展的安全评审（SVG script 仍拒）。
- 正式签名公钥由谁保管/轮换：本期只留注入位，流程待定。
- per-host 网络授权与 theme CSS 开放是否进下一期：本期明确不做，文档记录为已知限制。
