## 1. 清单与版本地基（后端 crate）

- [ ] 1.1 manifest `dependencies[]` 三端落地：`packages/plugin-sdk/src/index.ts` zod（id 反向域名 + req 合法 + 禁自依赖）+ `crates/omnipanel-plugin/src/manifest.rs` Rust 校验 + `scripts/check-plugin-manifests.mjs` + `validate-plugin.mjs`。验证：非法依赖 CI 失败
- [ ] 1.2 semver resolver 纯函数：`crates/omnipanel-plugin/src/` 新增 `resolve.rs`（`max_satisfying` / `update_available` / BFS 依赖展平 / 环与冲突报错），`semver` 加直接依赖。验证：`cargo test -p omnipanel-plugin` 新增用例通过
- [ ] 1.3 registry v2 解析验签：`crates/omnipanel-plugin-pkg/src/registry.rs`（v2 schema + v1 兼容读 + ed25519 验签复用 `verify_with_keys`）。验证：篡改 registry 单测拒绝；v1 单测可读

## 2. 源管理与信任（后端 crate → commands）

- [ ] 2.1 源配置存储：`crates/omnipanel-store` 源表（url/keyring token ref/启用）+ key pin（TOFU 存 key，变化挂起）。验证：`cargo test -p omnipanel-store` 通过
- [ ] 2.2 多源拉取合并：`src-tauri/src/commands/official_catalog.rs` 扩展多源（官方内置不可删、可禁用）+ 缓存沿用现有节流。验证：双源合并单测；断网回退种子
- [ ] 2.3 新 IPC（specta + bindings 重新生成，禁止手写）：`plugin_registry_sources_{list,add,remove,set_enabled,test}`、`plugin_resolve_plan`、`plugin_install_version`、`plugin_check_updates`、`plugin_update_all`，`src-tauri/src/lib.rs` 两处 `collect_commands!` 登记。验证：`gen:bindings` 产物含新命令；`tsc -b` 通过

## 3. 原子安装与回滚（后端）

- [ ] 3.1 staging+swap：`src-tauri/src/commands/plugin.rs::install_plugin_from_path` 改 staging 解压 → 预检 → rename swap（旧版移 `.last-good/`）→ 任一步失败恢复 + `plugin.rollback` audit；启动清 `.staging`。验证：预检失败单测回滚到旧版；audit 可查
- [ ] 3.2 更新编排：`plugin_update_all` 逐包更新（单包失败回滚不影响其它）+ 更新数统计。验证：三包一败的集成单测

## 4. 发布流（工具文档）

- [ ] 4.1 `publish` bin：`crates/omnipanel-plugin-pkg/src/bin/publish.rs`（pack→签名→registry 片段含 sha256/size/changelog 参数）。验证：对 `plugins-samples/translate-float` 实出片段
- [ ] 4.2 `generate-plugin-registry.mjs` 升级 v2 + 可选签名；`docs/plugins/publishing.md`（GitHub releases 托管模板 + 自定义源接入 + token 配置）。验证：按文档从零托管源并被客户端添加安装

## 5. 市场 UI（前端 module）

- [ ] 5.1 更新区：`frontend/src/modules/plugins/` 新增 Updates 区（badge 数、changelog 展开、单项更新、一键全更），复用 `installingMarketId` 状态机；文案走 i18n 中英，按钮用 `WorkbenchPanelHeader/WorkbenchActionButton`，不跨 module import。验证：vitest 新增用例；手动全更含一败场景
- [ ] 5.2 源管理对话框 + 依赖确认框（复用权限确认框模式）。验证：增/删/禁用/测连通手动验收；依赖计划确认框 vitest

## 6. SDK 发版

- [ ] 6.1 `docs/plugins/sdk-release.md`（构建/发版命令、版本号与 `HOST_API_VERSION` 对齐表、演进规则）+ `packages/plugin-sdk` CHANGELOG 起版。验证：按文档走完一次发版演练（dry-run 可接受，账号待定）

## 7. 回归

- [ ] 7.1 全量门禁：`cd frontend && npx tsc -b` 零 error；`cargo test -p omnipanel-plugin -p omnipanel-plugin-pkg -p omnipanel-store` 通过；vitest 插件/AI 相关通过；`check-plugin-manifests` 全绿；官方源行为对照不回退（bundled 拒绝下载、冲突保护）
