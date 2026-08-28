# 清单参考（plugin.json）

清单是插件与宿主之间的唯一装载合同。Zod schema 单源在
`packages/plugin-sdk/src/index.ts`，Rust 侧 `crates/omnipanel-plugin/src/manifest.rs`
与之同步；CI（`npm run check:plugin-manifests`）双向校验仓库一致性。

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 反向域名式唯一标识，如 `omni.engine.clickhouse`。安装包 id 与内置冲突时拒绝安装 |
| `version` | string | ✅ | SemVer；覆盖升级用 |
| `kind` | enum | ✅ | 七选一：`engine` / `panel` / `importer` / `cloud` / `module` / `theme` / `addon` |
| `permissions` | string[] | — | 声明所需权限；缺权调用即失败（见 [permissions-and-levels](./permissions-and-levels.md)） |
| `methods` | object[] | — | L2 网关白名单：`{ name, permissions[] }`；未声明的 method 一律 `UnknownMethod` |
| `entry.logic` | string | — | L2 逻辑包相对路径，仅 `.wasm` / `.js`；禁止 `..` 与绝对路径 |
| `minHostApi` | number | — | 所需最低宿主 API 版本；高于宿主当前版本的包拒绝装载 |
| `platforms` | string[] | — | 缺省全平台；不匹配则不激活、列表中标记不可用原因 |

## contributes（贡献点）

| 键 | 适用 kind | 内容 |
|---|---|---|
| `ui.connectionForm` | engine | `{ engineKey, aliases[], defaultPort, icon, fields[{key,type,label?,optional?}] }`；连接对话框按声明渲染 |
| `ui.workbench` | engine | 树/编辑器/预览/连接信息插槽枚举：`tree: schema\|kv\|collections\|documents\|none` 等 |
| `ui.panelTabs` | panel | Tab id 数组（`overview/websites/apps/certificates/cronjobs/databases`），与宿主插槽取交集 |
| `ui.sidebar` + `ui.moduleKey` | module | 侧栏入口；模块默认 closed |
| `overlays[]` | addon 等 | `{ id, title(i18n key), entry }` → 设置页「打开面板」，L3 沙箱渲染 |
| `ui.home` | 有独立界面、能调起的插件 | `{ show, title, icon, open:{ kind: overlay\|importer\|module, id } }` → 首页启动条资格；钉选由用户决定。`icon` 仅包内相对路径 svg/png |
| `menus[]` | addon | 菜单贡献（`when.hasSelection` 控制显隐） |
| `launcher.prefix` | addon | 快捷启动前缀（如 Everything 的 `es`） |
| `discovery[]` | panel/module | 发现 probe 归属声明 `{ probeId }` |
| `importers[]` | importer | `{ id, title, hint?, fetchMethod, defaultGroup?, defaultTag?, sshAuth?, note?, fields[{key,kind: text\|url\|secret\|checkbox,label,placeholder?,savedHint?,required?,defaultValue?,secretKeyPrefix?}], entry? }`。宿主按此泛化渲染向导；L2 `fetchMethod` 拉目标。`netFetch` 可带 `insecure` 放宽自签证书。样板：`plugins/importer-warpgate/plugin.json` |
| `themes.tokens` | theme | 公开 token 合同；**theme 禁止 JS**，permissions 必须为空 |
| `ai.tools[]` | 任意 | `{ name, description, execKind, moduleKey, crossModule, externalExposed, inputSchema }` |

## 校验规则速查（CI 强制）

- `methods[].name` 非空且不重复；`permissions` 均为合法枚举；
- `entry.logic` 相对路径、仅 `.wasm/.js`；
- `minHostApi` 为正整数；
- theme 包 `js:true` 直接拒绝。

## 完整示例（L1 引擎）

见 `plugins-samples/l1-starter/plugin.json`；
L2 见 `plugins/importer-warpgate/plugin.json`（含 `entry.logic` + `methods`）；
L3 见 `plugins-samples/l3-translator/plugin.json`。
