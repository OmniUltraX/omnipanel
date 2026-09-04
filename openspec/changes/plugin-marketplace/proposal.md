## Why

插件能写出来，但**到不了用户手里**：官方目录写死单个 GitHub URL（`official_catalog.rs:23-24`），无第三方源；`to_catalog_items` 只标已安装/版本号字符串，无 semver 比较，"有更新"都算不出来；manifest 压根没有 `dependencies` 字段；安装是原地覆盖，失败无回滚；`@omnipanel/plugin-sdk` 没发 npm。第三方交付 = 传文件，这不是生态。

## 目标

- 多源 registry：官方默认源 + 用户自加第三方源（静态 JSON，任何 HTTPS 主机可托管）；registry 本体签名验签 + key 轮换。
- 完整版本语义：semver 解析/比较/"有更新"判定/装指定版本/minHostApi 过滤。
- 依赖：manifest 声明、resolver（BFS + 版本约束 + 环/冲突报错）、缺件自动装（需用户确认）、卸载/禁用 guard。
- 原子安装与回滚：staging → 验签 → swap，保留 last-good，失败恢复。
- 发布流：`publish` CLI（一键 pack + 签名 + registry 条目生成）+ 静态托管文档 + 源认证（token）。
- 市场 UI：更新区（一键全更）、源管理、changelog、依赖确认。
- SDK 发版：npm 发布、版本策略、`HOST_API_VERSION` 演进文档。

影响 Phase：插件平台（`/settings` 插件中心、安装链路）；PRD 开放生态诉求。不碰执行器/L2/L3。

## 非目标（Non-goals）

- 不做中央托管的市场服务端（registry 是静态文件协议，谁都能托管；官方只维护默认源）。
- 不做评分评论、付费、私有审核流；私有源只给 token 认证。
- 不改第一方 bundled 行为（只读种子 + 冲突保护不变）。
- Terminal PTY / SSH / Vault 实现仍为内核；生产环境数据修改仍走 `env_tag=prod` 二次确认 + audit。

## 背景与动机

- `plugin-open-ecosystem` 已让第三方"做得出插件"（translate-float 为证）；`official_catalog.rs` 已有目录缓存/静默刷新/sha256/签名安装链路——本期在其上补"版本+依赖+信任+发布"的完整闭环，而非另起炉灶。
- semver crate 已在依赖树（构建日志可见 `semver v1.0.28`），无需引入新重型依赖。

## What Changes

- **Registry v2**：`schemaVersion=2`，`versions[]`（多版本 + changelog + minHostApi + artifact{url,sha256,size}），顶层 `signature`（registry 签名）；源配置 `{url, publicKeys[], authTokenRef?}` 存设置；TOFU + pin + 轮换。
- **版本解决**：`semver` 解析比较；`update-available`（registry 最新 compatible > installed）；`install-version(plugin_id, version)`；不兼容版本灰显原因。
- **依赖**：manifest 新增 `dependencies[]`（`{id, versionReq}`，SDK/CI/Rust 三端校验）；resolver 输出安装计划；UI 展示计划并确认；卸载被依赖保护。
- **原子安装**：`install_plugin_from_path` 改 staging+swap；失败（验签/解压/sync 任一步）恢复 last-good；audit 记 `plugin.install/rollback`。
- **发布**：`cargo run -p omnipanel-plugin-pkg --bin publish`（pack→签名→输出 registry 片段）；`generate-plugin-registry.mjs` 升级 v2；静态托管文档（GitHub releases 模板）。
- **更新检查**：复用静默刷新节流；新增"可更新数" + 一键全更；失败单包回滚不影响其它。
- **SDK**：`npm publish` 流程 + 版本号与 `HOST_API_VERSION` 对齐策略文档。
- **BREAKING**：无。对 v1 registry/包保持读取兼容（v1 条目视为单 version）。

## Capabilities

### New Capabilities

- `marketplace-registry`: 多源 registry、v2 schema、签名验签、缓存与静默刷新。
- `version-resolution`: semver 比较、更新判定、装指定版本、兼容过滤。
- `plugin-dependencies`: 声明、解决、缺件确认安装、卸载 guard。
- `atomic-install`: staging/swap、last-good 回滚、失败恢复。
- `publish-flow`: publish CLI、静态托管、源认证、信任轮换。
- `marketplace-ui`: 更新区、源管理、changelog、依赖确认 UI。
- `sdk-release`: npm 发版、版本策略、HOST_API 演进。

### Modified Capabilities

- 无（`openspec/specs/` 为空）。

## Impact

- 后端：`crates/omnipanel-plugin-{pkg,manifest/registry}`、`src-tauri/commands/{official_catalog→marketplace,plugin}.rs`；新增 `semver` 直接依赖（已在树内）。
- 前端：插件中心（更新区/源管理/changelog/确认框）、`plugin-sdk` manifest schema（`dependencies`）、i18n 中英。
- 工具文档：`publish` bin、`generate-plugin-registry.mjs` v2、`docs/plugins/publishing.md`、SDK 发版文档。
- 数据：registry 缓存文件格式扩展（`.official-registry-cache.json` 兼容读）；`plugin_settings` 不动。

## 成功标准

- 第三方按文档发布静态源并被客户端添加、浏览、安装、更新，全程无 manual 传文件。
- registry 被篡改（改一字节）验签失败并拒绝；key 轮换后旧签名包按策略（宽限/拒绝）处理且有单测。
- 依赖缺件时 UI 列出安装计划并经确认后一次装齐；环依赖/版本冲突给出可读错误。
- 更新失败自动回滚到上一版并有 audit；`cargo test` 相关包全过；`tsc -b` 零 error。
