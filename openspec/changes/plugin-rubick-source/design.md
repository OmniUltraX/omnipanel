## Context

插件市场已有多源 registry（官方 `official` + 用户第三方源，`RegistryFile` v2 + ed25519，见 `marketplace-registry` spec）与合并视图（`marketplace-ui`）。DBX 第三方引擎证明了“第三方源”形态可行。Rubick 插件即 npm 包：npm registry API（search + packument + tarball）就是开放的市场协议，无需爬取。toolx 已验证 uTools 系 `features/cmds` 文法可解析（参考实现，不合并）。

约束：Tauri 沙箱无 Node/Electron；签名门禁不可放宽；commands 层只做桥接（业务进 crate）；新增 IPC 走 specta；UI 复用 `components/ui` + `WorkbenchActionButton`，文案走 i18n。

## Goals / Non-Goals

**Goals:**

- 市场多源新增 `rubick`：npm 协议发现 + 合并展示 + 来源标记。
- 外部插件“判定后分级安装”：analyzer 静态 verdict → runnable 转标准包走现有管线 / external-only 外跳。
- converter 输出即标准 `.omni-plugin`：后续升级/禁用/审计零特殊路径。

**Non-Goals:**

- 不执行 Electron/Node preload；不爬 uTools 官方市场；不自动同步整市场。
- 不新增 `kind`；不动 manifest schema；不扩展垫片 API（本期只定白名单，不加新宿主能力）。

## Decisions

### 决策 1：源形态 = curated registry 文件 + 按需 npm 补齐（而非纯 live 搜索）

- 默认内置一份 curated `rubick` registry 文件（schema v2，`artifact.url` = npm tarball，`sha256` 为收录时计算——verify 路径零改动），随官方目录一起更新。
- 搜索框走 npm `/-/v1/search` live 补齐（仅元数据，不下载），结果标注“未收录”。
- 备选（纯 live，无 curated 文件）否决：离线不可用、版本不可 pin、与现有“registry 文件 + 签名/TOFU”信任模型冲突。
- `artifact` 增补可选 `integrity`（npm `dist.integrity` sha512-base64 原样透传）：有则验 integrity，无则验 sha256——npm 原生信任链不断。

```
npm registry ──search/packument──▶ [rubick source adapter]
        │ curated RegistryFile ──▶ merge_registries ──▶ 市场合并视图(badge:第三方·Rubick)
        ▼ tarball(+integrity)
[compat analyzer] ──verdict──▶ runnable→converter→标准.omni-plugin→现有安装管线
                              external-only→外跳(npm名/Rubick安装指引)+compat报告
```

### 决策 2：analyzer 放后端 crate（`omnipanel-plugin-pkg` 新模块），判定规则纯静态

- 取包→解到 tempdir→形状校验（`package.json` 需 `pluginName`+`features`，或 `plugin.json` 同源文法）→ preload 扫描：
  - 黑名单（任一命中即 external-only）：`require('electron')`、`node:` 内建、`child_process`、`__dirname` 敏感 API 清单（v1 固定 12 项，见 spec）。
  - 白名单 `utools.*`：`db*`、`showNotification`、`copyText`、`shellOpenExternal`、`getPath`、`hideMainWindow/showMainWindow`、`setSubInput` 等 14 项（toolx 已验证子集 + L3 桥已有能力）。
- 备选（前端判定）否决：大包下载阻塞 UI，且 analyzer 需复用 Rust 解压/哈希链。
- verdict 缓存：`{npm名@版本 → verdict}` 内存 + 磁盘（随 registry cache），同一版本不重复取包。
- 新 IPC：`plugin_external_analyze(npm, version)`、`plugin_external_convert(npm, version)`（specta，返回 verdict/包路径），commands 层只做参数桥接 + 审计（`plugin.external.analyze/convert`）。

### 决策 3：converter 输出标准包，不留“特殊插件”后门

- features 映射：字符串 cmds → addon `launcher`/`menus`（L1）；`overlays[].entry` → 主 HTML（L3 沙箱既有管线）；`main` 纯静态资源随包。
- preload 一律丢弃（runnable 前提即无 Node 依赖），`entry.ui` 按需生成最小 `ui/main.js`（菜单/overlay 打开器，模板化）。
- 包走 dev 签名 + 清单 `x-origin: rubick:<npm>@<version>`（审计与展示用，不进 schema 必填），来源标“第三方未审核”。
- 备选（新 kind `external`）否决：kind=宿主壳，无壳可挂的新 kind 只会制造空分支；来源维度已有 source 表达。

### 决策 4：UI 在现有市场 pane 上做加法

- 来源筛选 + 第三方 badge（复用 `plugin-center` 既有 chip/row 样式与 `originMetaLabel`）。
- 安装按钮按 verdict 分级：一键转换安装 / 外跳；compat 报告 inline 展示 reasons。
- i18n 中英同次；视觉走 Workbench 系组件，不引入新色块。

## Risks / Trade-offs

- [npm 供应链投毒] → 只读元数据默认；取包验 integrity/sha256；转换显式触发；绝不自动执行包内代码。
- [误判 runnable（静态扫描漏网）] → 白名单默认拒绝（未知 `utools.*` 即 external-only）；沙箱 + 权限闸是第二道网。
- [Rubick/npm 索引漂移] → curated 文件 pin 版本；live 搜索仅补充；拉取失败保留旧缓存（沿用现有源错误语义）。
- [registry 文件体积] → curated 只收录精选（目标 <200 条），全文搜索走 live。

## Migration Plan

1. registry 读取：`RegistryArtifact.integrity` 可选字段 + 验签路径（单测：sha512 integrity 优先、回退 sha256）。
2. `rubick` 源适配 + curated 种子文件（20~30 个纯展示类插件）+ 合并视图来源标记。
3. analyzer + verdict 缓存 + 两条 IPC。
4. converter + 标准包安装闭环（样例包 fixtures）。
5. 市场 UI（badge/筛选/分级按钮/报告）+ i18n + 文档（`docs/plugins/rubick-source.md`）。
6. 全量门禁后合入；回滚：源开关默认关（feature flag 按源 enable），analyzer/converter 为新增独立命令，不影响存量。

## Open Questions

- curated 名单首批收录标准（pure-web 优先？按 npm 周下载排序？）——实现前与用户定 20 个种子。
- converter 生成的 `ui/main.js` 模板是否需要支持 `mainPush/subInput` 语义——v1 先不支持（判 external-only），看需求再扩展。
