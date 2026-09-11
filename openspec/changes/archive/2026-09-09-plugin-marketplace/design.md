## Context

现状：`src-tauri/commands/official_catalog.rs` 已有单源目录（GitHub releases 硬编码 URL、内存+磁盘缓存、静默刷新节流、bundled 种子回退）、下载+sha256+经 `install_plugin_from_path`（dev/正式验签）安装链路；前端插件中心已有市场列表/安装/更新按钮骨架。但缺：版本比较（只有字符串版本号透传）、第三方源、依赖、原子回滚、发布工具。约束：commands 只桥接、crate 单向依赖、specta 生成 bindings、凭据只存 keyring、prod 二次确认。

## Goals / Non-Goals

**Goals:**

- 静态文件协议的多源市场：官方默认源 + 用户自加源，开箱可浏览/安装/更新第三方插件。
- 版本与依赖的完整语义：semver、更新判定、装指定版本、依赖解决与 guard。
- 安装原子化：失败回滚到 last-good，全程 audit。
- 发布者闭环：一条 CLI 从源码目录到可托管的 registry 片段。

**Non-Goals:**

- 中央市场服务端、评分评论、付费、私有审核流。
- 第一方 bundled 行为不变；执行器/L2/L3 不动。

## Decisions

### D1 Registry v2 为静态 JSON，签名与包签名同根

- crate 边界：`omnipanel-plugin-pkg` 新增 registry 模块（解析/验签 registry.json + signature 分离文件或内嵌 `signature` 字段，ed25519，与包签名同算法同 key 体系，复用 `verify_with_keys` + env 注入）。
- 源配置 `{id, url, publicKeys[], authTokenRef?}` 存 `omnipanel-store`（token 只存 keyring，库内 credential_ref）；官方源内置不可删、可禁用。
- v1 兼容读：无 `versions[]` 的条目视为单 version；`schemaVersion` 缺省按 1 解析。
- 备选（中央服务/GraphQL）否决：静态文件 + GitHub releases 即可托管，零运维，与现有官方目录同构。

```
发布者: 源码目录 → pack → sign → registry 片段 → 静态托管(HTTPS)
客户端: 源配置 → 拉取 registry.json → 验签 → 合并多源 → 版本解决 →
        依赖计划 → 用户确认 → 原子安装 → audit
```

### D2 版本解决用 semver crate（已在依赖树），规则抄 npm 化简版

- crate 边界：resolver 纯函数放 `omnipanel-plugin`（无 IO，单测友好）：`max_satisfying(versions, req)`、`update_available(installed, versions, host_api)`。
- `versionReq` 语法：`^x.y.z`（缺省）、`>=`、`=` 精确；无效约束安装时直接报错（CI 也校验）。
- minHostApi 过滤先于版本选择；不兼容版本在 UI 灰显原因，不直接隐藏（可诊断）。
- 备选（自写比较）否决：semver 已在树内，行为标准。

### D3 依赖只允许 addon→任意、engine/cloud/panel/module/importer 之间禁环

- manifest 新增 `dependencies[]`（SDK/CI/Rust 三端校验：id 反向域名、req 合法、禁自依赖）。
- resolver BFS 展平：缺件/低版本进安装计划；环 → 报错并列出环路；同一 id 多约束取交集，无交集 → 冲突报错。
- commands 边界：`plugin_resolve_plan` 只计算不安装；安装仍走现有 `install_plugin_from_path` 逐个执行（复用验签/审计）。
- 卸载 guard：被其它已安装插件依赖时拒绝并指名；禁用不拦截（只影响可用性，重启可恢复）。
- 联动：AI 工具 `sync_native_plugin_tools` 全量重建已覆盖依赖增减，无需改动。

### D4 原子安装 = staging + swap + last-good

- `install_plugin_from_path` 改为：解压到 `app_data/plugins/.staging/<id>/` → 验签/解析 → `rebuild` 预检 → rename swap（旧目录移 `.last-good/<id>/`，新目录就位）→ `rebuild_and_sync`；任一步失败恢复 last-good 并记 `plugin.rollback` audit。
- 失败语义：安装命令返回错误时，磁盘状态保证可用（旧版仍在），内存 registry 以 rebuild 结果为准。
- 备选（备份 zip）否决：目录 rename 原子且无需二次解压。

### D5 发布 CLI 复用 pack，registry 生成脚本升级 v2

- `pack --bin publish`：pack + dev/正式签名 + 输出可直接合并的 registry JSON 片段（含 sha256/size/changelog 参数）。
- `generate-plugin-registry.mjs` 升级：扫描制品目录生成 v2 registry + 可选签名（读本地 key）。
- `docs/plugins/publishing.md`：GitHub releases 静态托管模板 + 自定义源接入 + token 配置。

### D6 市场 UI 在现有插件中心上加，不另起路由

- frontend 边界：`modules/plugins/` 内加 Updates 区（一键全更、逐项 changelog 展开）、源管理对话框（增/删/禁用/测连通）、依赖确认框（复用权限确认框模式 `WorkbenchPanelHeader/WorkbenchActionButton`）。
- IPC 新增（specta + bindings 重新生成，禁止手写）：`plugin_registry_sources_{list,add,remove,set_enabled,test}`、`plugin_resolve_plan`、`plugin_install_version`、`plugin_check_updates`、`plugin_update_all`。返回体复用 `PluginListItem`/`OfficialCatalogPlugin` 扩展字段（`updateAvailable/changelog/registryId`），不另起大 DTO。
- 联动：MarketPane 现有 `installingMarketId`/`catalogRefreshing` 状态机复用；更新数 badge 走现有 toolbar（不新增全局通知通道）。

### D7 SDK 发版与版本策略文档化，HOST_API 按"加法兼容"演进

- `packages/plugin-sdk` 版本号与 `HOST_API_VERSION` 对齐记录进 `docs/plugins/sdk-release.md`；`minHostApi` 即兼容闸，HOST_API 只增不改既有语义（破坏性变更时递增并写迁移说明）。
- npm 发布流程文档化（构建/发版命令/registry），本期先做到"可发版"（CI 可跑），账号归属由你定。

## Risks / Trade-offs

- [Risk] 第三方源投毒（恶意 registry 指向篡改包）→ Mitigation：registry 签名验签 + 包签名双层；TOFU 后 pin key，换 key 需用户确认；包验签失败拒绝安装。
- [Risk] 依赖地狱（深链/大版本冲突）→ Mitigation：BFS 上限深度 + 冲突可读报错；addon 为主场景，engine 等重 kind 依赖从严提示。
- [Risk] swap 期间崩溃导致 staging 残留 → Mitigation：启动时清理 `.staging`；last-good 只在成功后清理。
- [Risk] 静默更新检查耗流量/打扰 → Mitigation：复用 15s 节流 + 仅 WiFi？（桌面不区分）→ 改为每日一次 + 手动刷新；默认开、可关。
- [Trade-off] 私有源只支持 bearer token，不做 OAuth/细粒度 ACL（远期）。

## Migration Plan

1. 先加法：v2 解析/registry 源管理/新 IPC 与旧链路并存；官方源行为不变。
2. 再切换：市场 UI 切多源合并列表；安装路径切 staging+swap（先对下载安装生效，文件安装随后）。
3. 回滚：任一后端分支失败可单独 revert（registry 解析、resolver、swap 三块正交）；前端 UI 按源开关降级为官方源。

## Open Questions

- 官方 registry 私钥由谁保管、轮换周期（本期先留多 key 位 + 文档，流程待定）。
- 更新检查默认开启与否（倾向默认开+可关，需你拍板）。
- npm scope 归属（`@omnipanel/*` 组织谁持有）。
