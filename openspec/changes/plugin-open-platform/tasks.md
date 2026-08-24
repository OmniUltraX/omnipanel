## 1. 单源注册表（阶段 A 前置）

- [x] 1.1 第一方清单前端单源：新增 `frontend/src/lib/pluginManifests.ts`（直接 import `plugins/*/plugin.json`，集中 legacy 别名映射）；`plugin_manifests` IPC 移至阶段 B 与安装流程（5.x）一并落地。验证：`check-plugin-manifests` 目录双向校验 + 宿主直连 import 扫描通过
- [x] 1.2 Catalog 查询 API（`listPluginManifests(kind)` / `getPluginManifest(id)` / `manifestPanelTabIds`）+ vitest。验证：vitest 覆盖 kind 分布与别名解析
- [x] 1.3 `engineRegistry.ts` 改读目录，删除对 `plugins/db-*/src/index` 的 import 与 `ENGINE_PLUGIN_MANIFESTS`。验证：`tsc -b` 零 error；既有 engineWorkbench 测试不回退
- [x] 1.4 `panelTabSlots.ts` / `cloudCapabilities.ts` / `panelPlugin.ts` 改读目录；删除手写 manifest 表、`ALIYUN_CLOUD_TABS`/`PANEL_*_CAPS` 消费（云 Tab 与面板能力从 manifest `panelTabs` 读取）。验证：panelPlugin/cloudRegionDiscovery 测试不回退
- [x] 1.5 `pluginModuleRegistry.ts` 改读目录，删除 nacos 直接 import。验证：kind=module 泛化遍历，vitest 通过
- [x] 1.6 插件逻辑登记桥接：新增 `pluginRuntimeLoader.ts`（唯一合法 import 插件逻辑源的宿主模块）+ `panelProbeRegistry` / `importerContributionRegistry`；`panelDiscovery.ts` / `WarpgateImportDialog.tsx` / `importDockerFromSsh.ts` 改走注册表。验证：`pluginRuntimeLoader.test.ts` 通过；CI 白名单仅两个桥接文件

## 2. 贡献点泛化消费（阶段 A）

- [ ] 2.1 launcher：`quickLauncherMatch.ts` 的 ssh/db/es 硬编码 register 迁移——内核保留 ssh/db，es 由 addon-everything 的 activate 注册；前缀列表随 activated 状态增减。验证：禁用 Everything 后 `es` 前缀不可用，启用恢复
  - 进度：内核 es 硬编码已删（`QUICK_LAUNCH_COMMAND_PREFIXES = ["ssh","db"]`）+ `unregisterLauncherProvider`；es 登记迁入 addon-everything activate；vitest 更新为「未激活→plain / 激活→es / 卸除→plain」
- [ ] 2.2 importer：命令面板/导入入口从 manifest `contributes.importers[].entry` 读取 Warpgate 入口。验证：禁用插件后命令面板无 Warpgate 项
  - 进度：CommandPalette / 设置页入口已按 `isPluginActivated(PLUGIN_ID_WARPGATE)` 门控；entry 字段泛化渲染随阶段 B 第三方 importer 一并做
- [ ] 2.3 discovery probe 注册表：`ssh-panel` probe 归属 panel-* 插件声明；prod 主机过滤与取消联动行为不变。验证：既有 cloudRegionDiscovery/discoveryBus 测试通过
  - 进度：`panelProbeRegistry` + panel-* activate 登记 mapper 已落地；probe 任务编排归阶段 B 泛化
- [x] 2.4 menus：share addon 登记迁入内核 addon 的 activate；`menuContributions` 支持 `when` 已有能力不变。验证：右键分享仍在，可按选区显隐
  - 实现：`mergeContributedMenuItems` 泛化为合并全部可见贡献（不再只认 share id）+ `unregisterMenuContributions(pluginId)`

## 3. activate 生命周期合同（阶段 A）

- [x] 3.1 `packages/plugin-sdk` 增加 `definePlugin` / `PluginActivateContext` / `PluginModule` 类型。验证：`tsc -b`
- [x] 3.2 `frontend/src/lib/pluginRuntimeLoader.ts`：静态 import map（第一方，唯一合法桥接）+ 差量 activate/deactivate（先卸后启，惰性 Host 工厂）；`pluginRuntimeStore.reload` 驱动同步。验证：vitest 模拟 toggle 观察登记/卸载（pluginRuntimeLoader.test.ts）
- [x] 3.3 `addon-everything` 改造为 `definePlugin`：activate 内注册 es provider；panel-*/warpgate 同步改造。验证：宿主消费方零插件 ID 特判；CI 白名单仅清单目录 + Loader
- [x] 3.4 AI 工具泛化：`sync_native_plugin_tools` 全量重建 PluginToolHub，遍历 activated manifests 的 ai.tools，executor 统一经 `(plugin_id, tool.name)` 网关分发；Everything handler 在 `register_builtin_invoke_handlers` 编译期登记；`commands/plugin.rs` 不再有按插件 ID 的 invoke 特判。验证：`cargo check -p omnipanel-app` 通过；启用/禁用后工具随 contributions 增减

## 4. 权限下沉与 audit（阶段 A）

- [x] 4.1 manifest schema 增补可选 `methods[]`（name + permissions 注解）：Rust `PluginMethodDecl`（唯一性/非空校验）+ SDK Zod `pluginMethodSchema` + CI 校验脚本；addon-everything 清单声明 `omni_everything_search`。验证：构造非法清单 `check:plugin-manifests` 失败；`cargo test -p omnipanel-plugin`
- [x] 4.2 `plugin_invoke` 网关：先查清单 `methods[]` 白名单（未激活按 UnknownMethod 拒绝），再逐项权限强制，最后经异步 `InvokeGateway` 分发；InvokeGateway handler 改异步（可包 spawn_blocking / 未来 WASM）。验证：`cargo check -p omnipanel-app`；invoke.rs 单测覆盖未知方法/异步 handler
- [x] 4.3 审计复用现有 `audit_log`：`plugin_invoke` 成败记 action=plugin.invoke（args 只存 sha256+len 摘要，不落原文），`plugin_require_permission` 拒绝记 action=plugin.permission/blocked。验证：编译通过；摘要函数单测随 commands 层联调
- [ ] 4.4 全量门禁：`cd frontend && npx tsc -b` 零 error；`cargo test -p omnipanel-plugin -p omnipanel-store -p omnipanel-mcp` 通过；vitest 相关用例通过
  - 进度：tsc 零 error ✓；omnipanel-plugin 14 ✓、omnipanel-mcp 40 ✓；store 未改动；vitest 全量 742 ✓（本批前）

## 5. 包格式与安装（阶段 B）

- [ ] 5.1 定义 `.omni-plugin` 打包规范文档（zip 结构、规范化字节流、signature.ed25519）+ 打包/验签 Rust 工具函数 crate（如 `omnipanel-plugin-pkg`）。验证：打包→篡改一字节→验签失败单测
- [ ] 5.2 `plugin_install_from_file` / `plugin_uninstall` 命令：解压到 `app_data/plugins/<id>/`、验签、合并进 registry；first_party 拒绝卸载。验证：集成测试装载样例包；重复安装覆盖升级
- [x] 5.3 设置页：dialog 插件选 .omni-plugin 安装入口、「已安装」来源标签、卸载按钮（danger），i18n 中英 + 样式。验证：tsc -b 零 error；手动装/卸待验收
[x] 5.4 dev 开关：erify_file_dev 内部 cfg!(debug_assertions) 分流——release 走严格 verify_file（未签名=UnsignedRejected），dev 放行未签名但错签名仍拒。验证：unsigned_rejected_on_release_path_but_allowed_in_dev 单测

## 6. L1 开放验收（声明式第三方）

- [x] 6.1 样板第三方 L1 包：plugins-samples/l1-starter（engine 表单 + workbench 降级 + ai.tools 元数据，零代码）；新增 plugin_manifests IPC（manifest 以 JSON 字符串传输规避 Value 递归内联），前端 Catalog 运行期合并已安装清单（IPC 失败保留上次结果）；集成测试覆盖 打包→验签→解压→load_installed→Registry 贡献点→禁用消失→内置 id 冲突保护 全链路。验证：pkg 链路测试 2 通过；store 合并单测通过；CLI 实打包验证
- [x] 6.2 脚手架：scripts/create-plugin.mjs <name> [engine|theme] 生成 L1 模板（清单+README）至 plugins-custom/（已 gitignore）；pack CLI（cargo run -p omnipanel-plugin-pkg --bin pack）。验证：生成物实打包 dev 签名通过；端到端装载由 6.1 链路测试覆盖

## 7. L2 WASM 执行（阶段 B）

- [x] 7.1 执行器抽象 + wasmtime 实现（骨架）：crates/omnipanel-plugin/src/executor.rs 定义 PluginLogicExecutor/PluginLogicInstance trait + DisabledExecutor 占位；新 crate omnipanel-plugin-wasm（feature plugin-wasm 门控，未启用时 instantiate 给可读错误）；WasmHostBridge trait 预留 net/fs/upsert/invoke 能力桥。验证：mock 回显/wat 客体 ABI 往返/非法 wasm 拒绝 共 4 单测；双 feature 配置 cargo check 通过- [x] 7.2 逻辑包装载：manifest 增补可选 entry.logic（Rust/SDK Zod/CI 三端校验：相对路径、禁 ..、仅 .wasm）；sync_plugin_logic 差量生命周期挂入 rebuild/set_enabled——activated 且声明 logic 的安装包自动实例化，失活 shutdown 移除；plugin_invoke 路由改为「原生网关优先 → L2 实例兜底」，权限闸在路由前已强制。验证：cargo check 双配置通过；端到端实例化待 7.4 样板联调- [ ] 7.3 prod 闸：env_tag=prod 时 net/ssh host functions 强制二次确认（复用 ExecutionEngine），不可配置绕过。验证：prod 主机扫描被拦截
- [ ] 7.4 L2 样板：Warpgate 远程拉取（当前 mock 的真实化候选）迁为 wasm 逻辑包。验证：真实 token 拉取 targets→candidates 闭环

## 8. L3 沙箱 UI（阶段 B）

- [ ] 8.1 沙箱 iframe 方案落地（origin/CSP 默认拒外联）+ postMessage 桥（消息白名单=Host API 子集，逐条过权限闸，带 pluginId+nonce）。验证：桥消息越权被拒并有 audit
- [ ] 8.2 overlay 支持插件自定义内容渲染路径（宿主壳不变）。验证：L3 样板在 Overlay 显示自身 UI
- [ ] 8.3 L3 样板：翻译 addon 最小可用（选区总线 → Overlay → net:connect）。验证：design 闭环 E 走通

## 9. SDK 交付与联调（阶段 B）

- [ ] 9.1 `@omnipanel/plugin-sdk` / `@omnipanel/plugin-ui` 构建 + npm 发布流程；manifest 增加 `minHostApi` 兼容检查。验证：外部工程按 README 引用类型可编译
- [ ] 9.2 开发者文档：清单参考、权限模型、三级梯度说明、调试指南。验证：按文档从零做出 L1 包
- [ ] 9.3 全量回归：官方 10 插件行为对照 plugin-host-sdk 验收清单不回退；`tsc -b` / cargo test / vitest / 清单 CI 全绿
