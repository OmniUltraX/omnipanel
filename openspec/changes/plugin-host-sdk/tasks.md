## 1. Runtime 与存储

- [x] 1.1 新增 crate `omnipanel-plugin`：`PluginKind` 七值、`PluginManifest`、权限枚举与校验（`crates/omnipanel-plugin/`）。验证：`cargo test -p omnipanel-plugin`
- [x] 1.2 实现内存 `PluginRegistry`（register/activate/deactivate/list contributions）（`crates/omnipanel-plugin/`）。验证：单元测试覆盖未知 kind 拒绝、缺权失败
- [x] 1.2a 清单支持 `platforms`；OS 不匹配则不 activate（`crates/omnipanel-plugin/`）。验证：单测模拟非 Windows 跳过
- [x] 1.2b `ToolRegistry` 支持按 `plugin_id` 动态登记/卸除 Native 工具，禁用后从清单消失（`crates/omnipanel-mcp/`、`omnipanel-store`）。验证：`cargo test -p omnipanel-mcp`
- [x] 1.3 `ConnectionKind` 增加 `Service`；解析/序列化兼容（`crates/omnipanel-store/src/connection.rs`）。验证：`cargo test -p omnipanel-store`
- [x] 1.4 约定 `externalSource` JSON；读写兼容旧 `cloudSource`（`crates/omnipanel-store/` 或连接 config 助手）。验证：单测新旧字段互转
- [x] 1.5 `DEFAULT_APP_MODULES` 增加 `cloud`；`repair_app_modules` 支持插件补种且 module 默认 closed（`crates/omnipanel-store/src/app_module.rs`）。验证：store 单测

## 2. Tauri 命令

- [x] 2.1 新增 `plugin_list` / `plugin_set_enabled`（`Result<_, OmniError>`），`collect_commands!` 与 `generate_handler!` 双清单一致（`src-tauri/src/commands/`、`lib.rs`）。验证：`npm run gen:bindings` 后 bindings 含新命令
- [x] 2.2 设计并落地第一方 `plugin_invoke` 白名单网关或等价 Host 后端入口（`src-tauri/src/commands/`、`omnipanel-plugin`）。验证：未声明 method 返回错误
- [x] 2.3 发现任务命令骨架 `discovery_run`，进度接入现有后台任务（`src-tauri/src/commands/`、`omnipanel-bg`）。验证：可取消任务；prod 路径注释确认策略

## 3. SDK 包

- [x] 3.1 新增 `packages/plugin-sdk`：清单 Zod/TS 类型、Host API 接口（`packages/plugin-sdk/`）。验证：`tsc` 通过
- [x] 3.2 新增 `packages/plugin-ui`：再导出 Button、TextInput、Dialog、空态；文档注明禁止 import `frontend/src/modules`（`packages/plugin-ui/`）。验证：包可被 frontend 引用
- [x] 3.3 前端 workspace 接入上述包（`frontend/package.json`、Vite alias）。验证：`cd frontend && npx tsc -b`

## 4. Shell 注册表

- [x] 4.1 `MODULE_PATHS` 增加 `cloud`；`appModuleStore` / `DEFAULT_MODULE_STATUS` 对齐（`frontend/src/lib/paths.ts`、`stores/appModuleStore.ts`）。验证：`tsc -b`
- [x] 4.2 侧栏改为按 `getNavVisibleModuleKeys` + 插件图标/文案渲染，去掉唯一硬编码 `navPaths`（`frontend/src/components/shell/Sidebar.tsx`，i18n）。验证：开关模块后侧栏增减
- [x] 4.3 设置页「模块」列出第一方插件模块，module 默认 closed 文案（`frontend/src/modules/settings/`）。验证：手动开关；文案走 i18n
- [x] 4.4 Overlay/warmup 若需保活云模块则更新 `routePanels.ts` / `lazyModules.ts`。验证：云路由懒加载不阻塞启动

## 5. Database 引擎注册表

- [x] 5.1 `omnipanel-db` 以注册表分发 `DbDriver`，收敛 `match db_type` 主路径（`crates/omnipanel-db/src/lib.rs`）。验证：`cargo test -p omnipanel-db`
- [x] 5.2 前端引擎 key 改为 `string` + 注册表；图标别名保留（`frontend/src/modules/database/api.ts`、`connection/engineIcons.ts`）。验证：`tsc -b`；现有 mysql/pg/redis 连接对话框可用
- [x] 5.3 将 Qdrant 迁为 `plugins/db-qdrant` 并在 Runtime 登记（`plugins/db-qdrant/`、database 模块只消费注册表）。验证：Qdrant 连接/列表行为与迁前一致
- [x] 5.4 连接对话框按 `form.fields` 渲染未知引擎（`frontend/src/modules/database/connection/`）。验证：声明式字段可保存；不跨 module import

## 6. Panel 注册表

- [x] 6.1 面板 `serviceType` 改为插件 id，保留 `bt`/`1panel` 别名（`frontend/src/modules/server/panel/serverConnection.ts` 及解析处）。验证：旧连接仍能打开
- [x] 6.2 Server Tab 按 capabilities 渲染，去掉作为唯一分支的 `isOnePanel`/`isBt` 铺开（`frontend/src/modules/server/panel/tabs/`）。验证：1Panel/宝塔现有 Tab 仍在
- [x] 6.3 将 1Panel 适配登记为 `plugins/panel-1panel`（清单 + 现有 client 调用边界）（`plugins/panel-1panel/`、`lib/btpanel` 暂可保留实现）。验证：网站/应用列表手动走通

## 7. Cloud 独立模块

- [x] 7.1 从 `ServerPanel` 拆出云树与 Dock，新建 `frontend/src/modules/cloud/` 路由 `/module/cloud`。验证：Server 不再显示云账户主树
- [x] 7.2 云 Tab 按厂商 capability 渲染；现有 ecs/swas/oss/domains/certs 作为阿里云声明（`modules/cloud/`、`cloudSidebarNav.ts`）。验证：原阿里云列表 API 仍可用
- [x] 7.3 ECS/SWAS 加入 SSH、OSS 加入文件改为写 `externalSource`（`cloudResourceLinks.ts`）。验证：二次加入不重复；反查「已加入」
- [x] 7.4 将阿里云 OpenAPI 客户端边界对齐 `plugins/cloud-aliyun` 清单（`crates/omnipanel-server/src/cloud/`、`plugins/cloud-aliyun/`）。验证：`cargo test` 相关；手动列 ECS
- [x] 7.5 i18n 增加云侧栏与设置文案（`frontend/src/i18n/zh-CN.ts`、`en-US.ts`）。验证：中英切换

## 8. 导入与发现

- [x] 8.1 升格 Navicat 预览为宿主 `ImportPreview` 组件（`packages/plugin-ui` 或 `frontend/src/components/ui/`，database 导入改调用）。验证：Navicat 导入流程不回退
- [x] 8.2 Candidate 类型与 upsert 去重（`omnipanel-plugin` + 前端导入壳）。验证：单测三元组匹配
- [x] 8.3 将 SSH 扫 Docker / 扫面板改为发现总线内核 probe（`docker_scan_ssh_docker_hosts`、`syncPanelsFromSsh.ts` 适配注册）。验证：原一键导入仍可用
- [x] 8.4 新增 `plugins/importer-warpgate`：清单、Token 表单、targets→Candidate 映射（堡垒入口）。验证：清单 CI；无 Token 时可用 mock 夹具单测映射
- [x] 8.5 Warpgate 向导接 ImportPreview + `conn_save` + Vault；命令面板入口（`plugins/importer-warpgate/`、设置或命令）。验证：手动或 mock 导入 SSH+MySQL 草稿；prod 确认路径存在

## 9. 菜单、启动器、主题

- [x] 9.1 ContextMenu 改为贡献表合并；`withGlobalShareMenuItem` 改为内核 addon 登记（`frontend/src/components/ui/ContextMenu.tsx`、`menu/`）。验证：右键仍有分享；可按 `when` 隐藏
- [x] 9.2 选区总线 `host.selection.get()` 聚合 xterm 与 DOM（`frontend/src/lib/`）。验证：终端选区单测或手动
- [x] 9.3 快捷启动前缀改为 provider 注册表；内核注册 `ssh`/`db`（`frontend/src/lib/quickLauncherMatch.ts`）。验证：现有 `ssh+` / `db` 行为不变；vitest 覆盖 parse
- [x] 9.4 冻结公开 token 合同；`themePackId` 进入 settings 与 `appearanceSync`（`tokens.css`、`settingsStore.ts`、`appearanceSync.ts`）。验证：子窗换主题同步
- [x] 9.5 `plugins/theme-default` 收纳现暗/亮 + 终端色板；禁止主题 JS（`plugins/theme-default/`、`terminalTheme.ts` 读包或 CSS）。验证：切换 light/dark 终端对比度不回退

## 10. 联调与门禁

- [x] 10.1 设置页插件列表走 `commands.pluginList`（`frontend/src/modules/settings/`，i18n）。验证：启用/禁用贡献点消失
- [x] 10.2 CI：清单 schema 校验 + `plugins/` 与 `packages/` 纳入 `tsc -b`（`frontend/` 或 workspace）。验证：CI 脚本失败当清单非法
- [ ] 10.3 手动验收清单：云侧栏、Qdrant 仍可用、1Panel Tab、Warpgate mock 导入、启动器 ssh/db、分享菜单、主题同步子窗、缺权 API 失败、prod 扫描确认、Windows 上 Everything 搜索/未运行报错、非 Windows 无该工具

## 11. Everything addon

- [x] 11.1 新增 `crates/omnipanel-everything`：Windows 命名管道优先、失败则 WM_COPYDATA；非 Windows stub（`crates/omnipanel-everything/`）。验证：`cargo test -p omnipanel-everything`；未运行 Everything 时返回明确错误；**不**链接 Everything64.dll
- [x] 11.2 加入 workspace members（`Cargo.toml`）。验证：`cargo build -p omnipanel-everything`
- [x] 11.3 新增 `plugins/addon-everything` 清单：`kind=addon`、`platforms:["windows"]`、工具 `omni_everything_search`、启动器前缀 `es`、外露默认关（`plugins/addon-everything/`）。验证：清单 schema CI
- [x] 11.4 activate 时向 ToolRegistry 登记 Native 工具；查询走 everything crate；`max_results` 封顶；跨模块注入（`crates/omnipanel-mcp/`、插件 activate）。验证：启用后 `mcp`/`builtin` 列表含该工具；禁用后消失
- [x] 11.5 启动器 `es` provider 复用同一查询函数（`frontend/src/lib/quickLauncherMatch.ts` 或 launcher 注册表）。验证：vitest 或手动 `es ext:yml`
- [x] 11.6 i18n：未检测到 Everything、插件设置说明（`frontend/src/i18n/zh-CN.ts`、`en-US.ts`）。验证：中英切换
- [ ] 11.7 手动验收（Windows）：Everything 运行中 AI 能搜到路径；未运行有提示；不自动启动 Everything；结果不含文件内容；设置中可关闭插件

## 12. L2 / L3 宿主插槽

- [x] 12.1 Database Host 按 `contributes.ui.workbench` 选择树/编辑器/连接信息，不再以 `db_type === "redis"` 为唯一门槛（`engineRegistry`、`ConnectionInfoSlot`）。验证：Redis 走 kv 插槽；禁用 `omni.engine.redis` 后芯片与专用树消失
- [x] 12.2 将 Redis 登记为 `plugins/db-redis`（驱动仍在 `omnipanel-db`）。验证：连接对话框 Redis 芯片来自插件
- [x] 12.3 Panel Host Dock Tab 可见集来自插件 `ui.panelTabs` ∩ 宿主插槽（`panelTabSlots`）。验证：1Panel / 宝塔现有 Tab 仍在；禁用面板插件后对应 Tab 消失
- [x] 12.4 L3 模块壳：`plugins/module-nacos`（`kind: module`，默认 AppModule `closed`）+ `/module/nacos` 宿主空壳。验证：设置中打开 Nacos 后侧栏出现；禁用插件后入口消失；不实现完整 Nacos 产品

