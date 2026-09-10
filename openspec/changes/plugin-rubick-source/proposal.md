## Why

OmniPanel 插件市场当前只有官方源与 DBX 第三方引擎，插件供给完全依赖自建。要“链接外部生态的市场”：uTools 官方市场无开放 API（仅账号/支付服务端接口，不可拉目录），而 Rubick（MIT、~10k star、与 uTools 同文的 features/cmds 指令文法）的插件即 npm 包——npm registry 本身就是开放的市场 API（已实测 `/-/v1/search` 直出可用）。用 Rubick 源补长尾供给，是合法、干净、架构对口的最小路径。

## 目标

- 市场新增 `rubick` 第三方源：npm 协议拉取插件元数据，市场合并视图展示并标注来源。
- 外部插件安装走“判定后分级”：compat analyzer 静态判定（pure-web 可转 vs 需外部运行），可转的 converter 打成标准 `.omni-plugin`（dev 签名 + 第三方未审核标）走现有安装管线，转不了的外跳。
- 不新增 `kind`：来源维度与运行维度正交，可转的一律落到现有 kind（展示/启动条类为 `addon`）。

## 非目标（Non-goals）

- 不执行 Electron/Node preload（Tauri 沙箱内无 Node 运行时）；不做 uTools 官方市场爬取。
- 不自动安装/同步整市场；不放宽签名门禁（转换包不进官方源）。
- 本期不做 converter 白名单之外的 API 垫片扩展（随 uTools/Rubick 漂移长期小火）。

## What Changes

- `RegistrySource` 新增 `rubick`：index 拉取（npm search API 或 curated registry 文件二选一，默认 curated 文件 + 按需 npm 补齐）、artifact 指向 npm tarball（含 integrity 哈希校验）、合并进市场视图并带来源标记。
- 新增 compat analyzer（后端）：tarball 取包 → 形状校验（package.json `pluginName/features` 或 plugin.json）→ preload 静态扫描（Node 内建黑名单 + `utools.*` 白名单）→ `verdict { runnable | external-only, reasons[] }`，结果缓存。
- 新增 converter：runnable 包的 features/cmds → 插件清单（keywords→launcher provider/菜单，overlays entry→主 HTML），打包为标准 `.omni-plugin`。
- 市场 UI：第三方 badge、来源筛选、分级安装按钮（一键转换安装 / 外跳）、compat 报告展示。
- 信任链：npm 取包验 integrity；转换须用户显式触发；转出包标第三方未审核并写审计；token 不涉及（公开读）。

## Capabilities

### New Capabilities

- `rubick-source`: npm 协议的第三方市场源（拉取、合并、来源标记、integrity 校验）。
- `external-compat`: 外部插件兼容判定与转换（analyzer verdict + converter 打包）。

### Modified Capabilities

- `marketplace-registry`: registry artifact 支持 npm tarball 类型（含 integrity 字段语义）。
- `marketplace-ui`: 第三方来源展示（badge/筛选）与分级安装入口。

## Impact

- Rust：`omnipanel-plugin-pkg`（registry 读取 npm artifact）、`src-tauri` marketplace 命令（新源 + analyzer/convert 命令）、`omnipanel-plugin`（外部清单解析，不动 manifest schema）。
- 前端：插件中心市场 pane（badge/筛选/分级按钮/compat 报告）、i18n 中英。
- 依赖：复用现有 reqwest/解压/签名链；toolx 的 manifest 解析与 asar 逻辑作为参考实现，不整仓合并。
- 影响 Phase：插件平台（Phase 1 生态扩展）；不碰数据库/终端/SSH 等模块路由；无生产环境写操作，不触发 env_tag 确认（npm 拉取为公开读）。

## 成功标准

- 市场出现 Rubick 源插件并正确标注来源；断网/篡改 tarball 时拒绝并有明确错误。
- pure-web 样例（如 features-only 插件）一键转换安装后，出现在对应入口且启用/禁用跟随生命周期。
- Node 强依赖样例被判 external-only，给出原因 + 外跳，不安装。
- `tsc -b` / 相关 cargo test / vitest / `check:plugin-manifests` 全绿。
