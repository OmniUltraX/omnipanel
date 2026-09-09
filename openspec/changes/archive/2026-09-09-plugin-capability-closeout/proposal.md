## Why

市场、投稿、原子安装、AI Dock 已经收口，但插件生态还停在「开发者本机」。发行版没有 `plugins-custom`，主题 kind 是空壳，面板/云仍靠第一方实现，L3/prod 闸没钉死验收，SDK 没真正发 npm。若不一次记账、按批次做完，每次都会重新盘「还差什么」。

## 目标

把当前已识别的薄点做成**一份可勾选总账**，按批次做完即视为插件能力本轮收口，中途不再重开调研。

1. **发行版工作台**：工程根改到用户数据目录，打包用户也能新建 / 编辑 / 校验 / 打包 / 安装。
2. **主题真正可用**：启用 `kind=theme` 即把 tokens 应用到 UI 与终端色板。
3. **面板清单驱动切片**：至少一个页签由 `panelTabs` + 通用壳渲染；附第三方 panel 样板。
4. **云 L2 薄样板**：一个 `kind=cloud` 能力走 JS `logic.js` + 通用能力槽，不重写阿里云/腾讯云 crate。
5. **运行时验收钉死**：L3 Overlay 真机 + `env_tag=prod` 联网二次确认；官方目录未签策略对照 release。
6. **沙箱合同冻结**：第三方 `ui/main.js` 继续 `Function` 沙箱，补测试与文档边界，不升级成 iframe 应用框架。
7. **SDK 可对外引用**：`@omnipanel/plugin-sdk` 构建/pack 进 CI；账号就绪则 `npm publish`。
8. **AI 脚手架账本**：规格改为 Dock + `omni_studio_*`；落 `plugin.ai_scaffold` 审计（摘要不落原文）。

影响 Phase：插件平台（`/plugins` 市场与工作台、设置主题、`/server` 面板、云工作台）。生产环境网络/读盘仍走 `env_tag=prod` 二次确认 + audit。

## 非目标（Non-goals）

- 不做第八种 `PluginKind`，不做 LSP / Git / 通用 IDE。
- 不把 `plugins` 塞进 `ModuleKey`；工作台现场继续独立 snapshot。
- 不把阿里云 / 腾讯云 / 1Panel / 宝塔实现迁出原生 crate。
- 不把第三方 UI 升级成完整 iframe 应用或任意动态 `import()`。
- 不做中央市场服务、评分、付费；Warpgate 迁 WASM、launcher 残余硬编码不在本 change（另账）。
- 不改第一方 bundled 冲突保护；凭据仍只走 keyring。

## 背景与动机

`plugin-marketplace` / `plugin-ide` / `plugin-open-ecosystem` / `studio-ai-dock` 任务已勾完。上次调研留下的 8 条薄点是本 change 的全部范围；做完即停，不在过程中扩 scope。

`studio-ai-dock` 曾写「发行版无源码树时失败即可」——本 change **推翻该条**，改为用户数据目录工程根。

## What Changes

- Studio 工程根：`app_data/plugin-projects/`（开发态可仍扫描仓库 `plugins-custom/` 作兼容）；禁锢与脚本白名单不变。
- 主题 Host：读已启用 theme 插件的 `contributes.themes.tokens`，写入 CSS 变量与终端 palette；内置 `omni.theme.default` 改为走同一路径。
- 面板 Host：通用页签壳消费 `panelTabs` + `formFields`；样板 `plugins-samples/panel-starter` 可装可开。
- 云 Host：样板 `plugins-samples/cloud-l2-starter` 声明一条 capability，L2 `invoke` 填通用详情槽。
- 验收清单进任务并必须勾完（Overlay、prod 闸、官方目录）。
- 沙箱：越权/非法入口单测 + `docs/plugins` 一节边界说明。
- SDK：CI `npm pack`；`docs/plugins/sdk-release.md` 保持账号待定则 dry-run 即完成。
- 审计：`plugin.ai_scaffold`；plugin-ide AI 规格与 Dock 对齐。
- **BREAKING**：无对外包格式破坏。发行版工作台从「不可用」变为「可用」，属加法。

## Capabilities

### New Capabilities

- `studio-user-projects`: 发行版工程目录、兼容源码树、工具链缺失引导。
- `plugin-theme-apply`: 启用 theme 插件应用 tokens（UI + 终端）。
- `panel-manifest-host`: 清单驱动面板页签切片 + 第三方样板。
- `cloud-l2-sample`: 一条云能力的 L2 样板闭环。
- `plugin-runtime-acceptance`: Overlay / prod 闸 / 官方目录验签策略验收合同。
- `plugin-ui-sandbox-contract`: 第三方 UI `Function` 沙箱边界冻结。
- `sdk-npm-ready`: SDK 构建、pack、发版就绪。
- `studio-ai-audit`: Dock 脚手架规格 + `plugin.ai_scaffold` 审计。

### Modified Capabilities

- 无（`openspec/specs/` 为空；既有 change 的 delta 不在此合并）。

## Impact

- 后端：`src-tauri/src/commands/plugin_studio.rs`（工程根解析）、可能 `omnipanel-store` 记工程根；主题无新 IPC 或只加只读「当前 theme tokens」。
- 前端：`modules/studio`、主题应用（`tokens.css` / `terminalTheme.ts`）、`modules/server/panel`、云工作台 Host、`pluginRuntimeLoader` 测试、i18n 中英。
- 样板：`plugins-samples/panel-starter`、`cloud-l2-starter`。
- 文档：只改已有 `docs/plugins/` 对应小节，不另开一堆 md。
- UI：工作台 / 设置 / 面板继续 `WorkbenchPanelHeader` + `WorkbenchActionButton`。

## 成功标准

- 安装包（无仓库源码）打开工作台可新建 JS 逻辑插件、校验、打包、本地安装。
- 禁用默认主题、启用样板 theme 后，UI 强调色或终端色板可见变化；再启默认主题恢复。
- 样板 panel / cloud-l2 可从市场或本地安装后出现对应槽，不写插件 ID 特判。
- prod 主机上 L2/L3 `net:connect` 取消则不发网，audit 可查；L3 Overlay 样板能显示自身 HTML。
- `tsc -b` 零 error；相关 cargo / vitest / `check-plugin-manifests` / `validate-plugin` 全绿。

## 批次（执行顺序，一次只做一批）

| 批次 | 内容 | 勾完即停 |
|------|------|----------|
| 0 | AI 脚手架规格 + `plugin.ai_scaffold` 审计 | 账本与实现一致 |
| 1 | 发行版工作台（用户工程目录） | 无源码树也能写插件 |
| 2 | 主题应用 | theme kind 不再是空壳 |
| 3 | Overlay / prod 闸 / 官方目录验收 | 安全合同钉死 |
| 4 | 面板清单驱动切片 + 样板 | 第三方 panel 能开一页 |
| 5 | 云 L2 一条能力样板 | 第三方 cloud 有仿写对象 |
| 6 | UI 沙箱合同冻结 | 边界写清，不升 iframe |
| 7 | SDK pack / 发版就绪 | 外部工程可引用类型 |

做完批次 7，本 change 归档。中途发现的新想法另开 change，不塞进这份总账。
