# 清单参考（plugin.json）

清单是插件与宿主之间的唯一装载合同。Zod schema 单源在
`packages/plugin-sdk/src/index.ts`，Rust 侧 `crates/omnipanel-plugin/src/manifest.rs`
与之同步；CI（`npm run check:plugin-manifests`）双向校验仓库一致性。

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 反向域名式唯一标识，如 `omni.engine.clickhouse`。安装包 id 与内置冲突时拒绝安装 |
| `version` | string | ✅ | SemVer；覆盖升级用 |
| `displayName` | string | — | 侧栏 / 插件中心显示名；缺省回退宿主 i18n 或 id |
| `kind` | enum | ✅ | 七选一：`engine` / `panel` / `importer` / `cloud` / `module` / `theme` / `addon` |
| `permissions` | string[] | — | 声明所需权限；缺权调用即失败（见 [permissions-and-levels](./permissions-and-levels.md)） |
| `methods` | object[] | — | L2 网关白名单：`{ name, permissions[] }`；未声明的 method 一律 `UnknownMethod` |
| `entry.logic` | string | — | L2 逻辑包相对路径，仅 `.wasm` / `.js`；禁止 `..` 与绝对路径 |
| `entry.driver` | string | — | sidecar 可执行文件相对路径（`runtime=sidecar` 时必填）；`.js/.mjs→node`，`.jar→java -jar`，其它直接执行。协议见 [sidecar-dbx](./sidecar-dbx.md) |
| `runtime` | enum | — | `inproc`（第一方）/ `sidecar`（第三方引擎用这个） |
| `minHostApi` | number | — | 所需最低宿主 API 版本；高于宿主当前版本的包拒绝装载 |
| `platforms` | string[] | — | 缺省全平台；不匹配则不激活、列表中标记不可用原因 |

## contributes（贡献点）

| 键 | 适用 kind | 内容 |
|---|---|---|
| `ui.connectionForm` | engine | `{ engineKey, aliases[], defaultPort, icon, fields[{key,type,label?,optional?}] }`；连接对话框按声明渲染 |
| `ui.workbench` | engine | 树/编辑器/预览/连接信息插槽枚举：`tree: schema\|kv\|collections\|documents\|none` 等 |
| `ui.panelTabs` | panel | Tab id 数组（`overview/websites/apps/certificates/cronjobs/databases`），与宿主插槽取交集 |
| `methods` | panel | L2 白名单：`testConnection` / `listDatabases` / `createDatabase` / `deleteDatabase`；阶段 A 由插件 `activate()` 登记进程内 driver |
| `ui.sidebar` + `ui.moduleKey` | module | 侧栏入口；模块默认 closed |
| `module.capabilities[]` | module | Host 工作台：`id` / `label?` / `columns` / `actions[{id,method?,target?,label?,toggle?}]` / `listMethod?` / `getMethod?` / `itemKey?` / `detail?`（`none`\|`editor`\|`form`\|`kv`\|`children`\|`logs`\|`metrics`\|`facts`\|`tree`）/ `formFields?` / `historyMethod?` / `childColumns?` / `childListMethod?` / `language?` / `valueKey?`。未知 id 同样走通用壳。完整合同见 [README](./README.md) |
| `cloud.capabilities[]` | cloud | Host 云工作台：`id` / `label?` / `scope` / `columns` / `actions` / `detailSlots` |
| `cloud.regions[]` | cloud | 连接对话框地区预置 `{ id, label? }`；空则第一方用内置列表 |
| `module.probe` | module | 通用 HTTP 扫描：`ports`、`healthPath`、`contextPath`；配合 `discovery: [{ probeId: "module-http" }]` |
| `overlays[]` | addon 等 | `{ id, title(i18n key), entry }` → 设置页「打开面板」，L3 沙箱渲染 |
| `ui.home` | 有独立界面、能调起的插件 | `{ show, title, icon, open:{ kind: overlay\|importer\|module, id } }` → 首页启动条资格；钉选由用户决定。`icon` 仅包内相对路径 svg/png |
| `menus[]` | addon | 菜单贡献（`when.hasSelection` 控制显隐） |
| `launcher.prefix` | addon | 快捷启动前缀（如 Everything 的 `es`） |
| `discovery[]` | panel/module | 发现 probe 归属声明 `{ probeId }` |
| `importers[]` | importer | `{ id, title, hint?, sourceKind?: instances\|dockerConnections, fetchMethod?, scanners?, defaultGroup?, resourceKinds?, defaultTag?, sshAuth?, note?, fields[…], entry? }`。`instances`（默认）由宿主画实例表单，L2 `fetchMethod` 拉目标；`dockerConnections` 左侧列出已有 Docker 连接，宿主按 `scanners[]` 扫描。`resourceKinds` 声明会写入的资源类型，设置里按类型各选分组。样板：`plugins/importer-warpgate`、`plugins/importer-docker-db` |
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
