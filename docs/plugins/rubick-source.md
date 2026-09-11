# Rubick 第三方源与外部兼容

OmniPanel 市场除官方源外，可展示 Rubick 系（npm 包形态，与 uTools 同文 `features/cmds`）第三方插件。**只读元数据默认，绝不自动安装执行包内代码。**

## 形态

| 环节 | 说明 |
|---|---|
| 来源 | `rubick`（curated `plugins/rubick-registry.json` 种子 + 市场打开自动 npm 全量，手动搜索框保留） |
| 展示 | 市场合并展示，来源按 id 直列 chips（官方 / DBX / Rubick / 自定义源），Rubick 条目带分类行（翻译文本 / 开发工具 / 效率工具 / 系统网络 / 其他，启发式） |
| 安装 | 先判定后分级：runnable 一键转换安装；external-only 外跳（对话框可复制包名） |

不新增 `kind`：可转的一律落现有 kind（展示类为 `addon`）；来源维度用 `source_id` 表达。

## verdict 规则

- 形状：`package.json`（`pluginName` + `features`）或 `plugin.json` 同源文法；无 features 且无主入口即不可转（有主入口可转 overlay-only）。
- Node 黑名单（命中即 external-only）：`electron` / `child_process` / `fs` / `vm` 的 require/import 字面、`node:` 前缀、**任意非相对 `require(`**、缺失的 preload 声明文件。
- `utools.*` 白名单（14 项）+ `rubick.*` 一律 external-only（沙箱无对应桥）。
- 页面直调 `fetch`/XHR 不判死：转换自动声明 `net:connect`（安装时用户确认），运行时 prelude 透明代理到受闸桥（成功只给 `{ok:true,status:200}` + 文本 body，非 2xx 走 reject）。
- 误判只会导致外跳，不会导致越权运行（沙箱 + 权限闸是第二道网）。

## 转换产物

- 输出标准 `.omni-plugin`：关键字 cmds → 动态入口菜单（`ui/main.js` 模板），主 HTML → overlay，静态资源拷贝（preload/`package.json`/`node_modules` 排除，单项 ≤512KB）。
- dev 签名 + `x-origin: rubick:<npm>@<version>` + 第三方未审核标；启用/禁用/升级/审计与普通包一致。
- 权限：白名单 utools 能力均不需要清单权限；页内直调网络的自动声明 `net:connect`（安装确认页可见）；其余特权桥（如选区）按正常缺权拒绝并审计。

## compat 垫片（preload 转译）

- 原 preload（含 Node 依赖）一律不执行；analyzer 识别其定义的 `window.*`：全集 ⊆ 已知集时建议垫片（如 `ip-tools-v1`：lanIPv4/wan_no_proxy/wan_has_proxy/locationInfo/confetti），未知全局即 external-only 并点名。
- 垫片随包（`entry.compat`，overlay 渲染紧随 prelude 注入），基于宿主桥实现：内网地址→`network.getLocalIPs`、公网/定位→直调 fetch（走受闸桥）、复制→`clipboard.write`（只写）、撒花→noop。
- 定位语义差异：沙箱无 OS 定位，垫片用 IP 归属回退（市级精度），文档与对话框如实说明，不伪装精度。

## 信任链

1. npm 取包验 `dist.integrity`（sha512，失败即拒不回退）；curated 文件 pin 版本。
2. 转换须用户显式触发；审计 `plugin.external.analyze/convert/search`。
3. Rubick 源条目禁版本直装（tarball 非 `.omni-plugin`），一律走 convert。
4. release 构建拒绝未签名转换包（dev 放行）——第三方未审核语义。

## 命令

- `plugin_external_search_npm(query, max?)`：npm 搜索（仅元数据）。
- `plugin_external_analyze_npm(npm, version)`：拉包验签解包判定。
- `plugin_external_convert_npm(npm, version)`：转换并安装。

## 脚手架

- `node scripts/curate-rubick-seed.mjs "<query>" <max>`：拉取候选条目（含 tarball + integrity）。
- `node scripts/curate-rubick-merge.mjs`：多查询合并去重，输出待人工精选的种子。
- 种子精选原则：用户可理解的工具优先，剔除平台二进制/纯库/脚手架；`externalNpm` 必填且与转换 id 映射一致（`omni.ext.<sanitize(npm)>`）。
