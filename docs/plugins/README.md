# OmniPanel 插件开发指南

第三方按 `plugin.json` 声明能力，Host 用固定壳渲染。**不按插件 ID 特判。** Nacos / 阿里云 / 腾讯云只是第一方样板。

字段枚举与 schema 单源：`packages/plugin-sdk/src/index.ts`。

| 文档 | 内容 |
|---|---|
| [本文](./README.md) | 七种 kind、Host 合同、脚手架与校验 |
| [manifest-reference.md](./manifest-reference.md) | 清单字段表 |
| [sidecar-dbx.md](./sidecar-dbx.md) | Engine sidecar 协议 |
| [permissions-and-levels.md](./permissions-and-levels.md) | 权限与 L1 / L2 / L3 |
| [packaging-and-install.md](./packaging-and-install.md) | 打包、签名、安装 |
| [debugging.md](./debugging.md) | 排错与日志 |

```bash
node scripts/create-plugin.mjs <name> engine          # 数据库引擎（空壳）
node scripts/create-plugin.mjs <name> engine-sidecar  # 数据库引擎（DBX sidecar）
node scripts/create-plugin.mjs <name> module          # 中间件工作台（Nacos / Consul / Kafka / ZooKeeper…）
node scripts/create-plugin.mjs <name> cloud           # 云厂商
node scripts/create-plugin.mjs <name> panel           # 服务器面板
node scripts/create-plugin.mjs <name> importer        # 导入向导
node scripts/create-plugin.mjs <name> addon           # 启动条 / Overlay
node scripts/create-plugin.mjs <name> theme           # 主题
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/<name> <name>.omni-plugin
```

安装：设置 → 插件 → 「安装本地插件」。与内置同 id 的包会被拒绝覆盖。

---

## 七种身份（`kind`）

| kind | 进哪套 Host | 你要声明什么 |
|---|---|---|
| `engine` | 数据库工作台 | `ui.connectionForm` + `ui.workbench`（tree / editor / preview） |
| `module` | 模块工作台 | `module.capabilities[]` + L2 `logic.js` |
| `cloud` | 云工作台 | `cloud.capabilities[]`；第一方走 crate，其它走 L2 |
| `panel` | 服务器面板 | `ui.panelTabs` + L2（`testConnection` / `list*`；第一方 1Panel/宝塔走进程内 driver） |
| `importer` | 导入向导 | `importers[]` + L2 `fetchMethod` |
| `theme` | 主题 | `themes.tokens`，禁止 JS |
| `addon` | Overlay / 菜单 / 启动条 | `overlays` / `menus` / `launcher` |

顶层必填：`id`（反向域名，如 `omni.module.consul`）、`version`、`kind`。建议写 `displayName`。

L2 要声明 `entry.logic`（`.js` / `.wasm`）和 `methods[]` 白名单。未声明的 method 一律 `UnknownMethod`。

---

## 三级开放

- **L1**：只写 `plugin.json`。表单、workbench 槽、主题、菜单、AI 工具元数据。
- **L2**：`globalThis.call(method, argsJson)` 返回 JSON 字符串。IO 只走 `host.*`。
- **L3**：`overlays[].entry` 指向 HTML，iframe 沙箱 + postMessage 白名单。

### `host.*`（QuickJS）

| API | 权限 | 说明 |
|---|---|---|
| `host.ping()` | — | 管道自检 |
| `host.hmac(specJson)` | — | `{ alg: "sha256"\|"sha1", key, data, encoding: "hex"\|"base64" }`，签厂商 API |
| `host.netFetch(specJson)` | `net:connect` | `{ url, method?, headers?, body? }`，prod 目标要确认 |
| `host.fsRead(path)` | `fs:read` | 仅插件自己的安装目录 |
| `host.vaultGet/Has/Put/Delete(key)` | `vault:read` | 命名空间 `plugin:{id}:{key}` |
| `host.connectionUpsert(json)` | `connections:write` | 候选 `pluginId` 必须是自己 |
| `host.stateGet/Set` | — | 插件私有状态 |
| `host.invoke(method, argsJson)` | 该方法声明的权限 | 调本插件其它 method |

写方法若清单带 `dangerAction`，前端会走确认令牌；插件不能自签。

---

## Host 保证 / 插件禁止

装包后主路径能跑，靠的是 Host 注入与固定壳，不是插件去猜第一方实现。

| Host 保证 | 插件禁止 |
|---|---|
| Panel：`plugin_invoke` 前注入 `apiKey`（存盘后从 `panel-key-{id}` 回源） | `vaultGet` 读 `panel-key-*` / 云 AK；插件 vault 只有 `plugin:{id}:*` |
| Cloud：后端 `cloud_plugin_args` 注入 AccessKey | 自己拼阿里云 / 腾讯云 crate |
| Module：`pluginSecretPut` + `host.vaultGet(connectionId)` | 读其它插件的 vault 命名空间 |
| 按清单槽渲染固定壳；入口按已激活插件列出 | 按插件 ID 特判；第三方路径调用 `createOnePanelClient` / `createBtPanelClient` |
| 写操作走 `dangerAction` + `consume_grant` | 插件自签确认令牌 |
| Engine sidecar：`entry.driver` + `engineKey` 进启动表 | 第三方写 inproc Rust（Rust 只以 sidecar 进程进来） |

七种 kind 同一条交付标准：出现在对的入口、凭据回源后仍能调、至少一读一写（theme 只读；addon 启动条算 L1）、调用栈不进第一方面板客户端。

```js
var sig = host.hmac(JSON.stringify({
  alg: "sha256",
  key: args.accessKeySecret,
  data: stringToSign,
  encoding: "hex"
}));
var resp = host.netFetch(JSON.stringify({
  url: "https://example.com/api",
  method: "GET",
  headers: { Authorization: "hmac " + sig }
}));
```

---

## Module 工作台

`kind=module`。侧栏按 `capabilities[]` 出树；工作台只认下面 **9 种壳**，用 `detail` 选择。选壳，不要为新产品写专用 React。

| `detail` | 壳 | 适用 |
|---|---|---|
| `none` | 一张表 + 行内/工具栏动作 | 命名空间、集群节点、Topic 列表 |
| `editor` | 左表 + 右代码编辑器 + 可选历史 | 配置中心、脚本 |
| `form` | 左表 + 右字段表单 | 用户、权限、结构化元数据 |
| `kv` | 左表 + 右值编辑器 | Consul KV、扁平配置项 |
| `children` | 左表 + 右子表 | 服务 → 实例、Topic → 分区 |
| `logs` | 全宽日志表（默认时间/级别/内容） | 审计、运行日志、消费积压 |
| `metrics` | 全宽指标卡片 | `{ id, label?, unit?, points:[{ tsMs, value }] }` |
| `facts` | 全宽键值事实 | `{ facts: { k: v } }` 或 `{ items:[{ key, value }] }` |
| `tree` | 左树（可懒加载）+ 右编辑器或字段 | ZooKeeper / etcd / 目录型 KV |

Nacos 四个槽也走这套：`namespace=none`、`config=editor`、`discovery=children`、`cluster=none`。

常见产品怎么拆：

| 产品 | 建议 capabilities |
|---|---|
| Nacos | `none` + `editor` + `children` |
| Consul | `children`（服务）+ `kv` 或 `tree` |
| Kafka | `none`（Topic）+ `children`（分区/消费者）+ `logs`（消息） |
| ZooKeeper / etcd | `tree` + 可选 `facts` |
| Vault | `tree` 或 `kv` + `form`（策略） |
| Prometheus | `metrics` + `logs` |

### 清单字段

```json
{
  "id": "config",
  "label": "配置",
  "detail": "editor",
  "language": "yaml",
  "valueKey": "content",
  "listMethod": "listConfigs",
  "getMethod": "getConfig",
  "historyMethod": "listConfigHistory",
  "itemKey": "group,dataId",
  "columns": [{ "key": "dataId", "label": "Data ID" }, { "key": "group" }],
  "formFields": [{ "key": "dataId" }, { "key": "group" }],
  "childColumns": [],
  "childListMethod": "listInstances",
  "childItemKey": "ip,port",
  "actions": [
    { "id": "create", "method": "publishConfig", "target": "toolbar", "label": "新建" },
    { "id": "publish", "method": "publishConfig", "target": "editor", "label": "发布" },
    { "id": "delete", "method": "deleteConfig", "target": "editor", "label": "删除" },
    { "id": "rollback", "method": "rollbackConfig", "target": "history", "label": "回滚" },
    { "id": "update", "method": "updateItem", "target": "row", "label": "编辑" },
    { "id": "toggle", "method": "updateInstance", "target": "child", "toggle": "enabled" }
  ]
}
```

- `listMethod` 缺省 `listItems`。参数：`{ capabilityId, namespaceId, keyword, parentId }`，返回数组或 `{ items }`。
- `itemKey` 可用逗号表示复合键。
- `actions[].target`：`toolbar` / `row` / `editor` / `child` / `history`。
- `actions[].toggle`：调用前把该布尔字段取反（启停）。
- `formFields`：新建弹窗，以及 `detail=form` 的右侧表单。
- `language`：`yaml` / `json` / `text` / `sql` / `ini` / `shell` / `python`，缺省 yaml。
- `valueKey`：`getMethod` 结果里的正文键，缺省 `content`（也认 `value`）。
- 空 `itemKey` / `public` 行禁止删除类动作。

连接表单：`ui.connectionForm.fields[]`（`host` / `port` / `password` 等）。探测：`module.probe` + `discovery: [{ probeId: "module-http" }]`。

### L2 返回形状

```js
// listItems / childListMethod
{ items: [{ id, name, ...columns }] }

// getMethod（editor / kv / tree）
{ content: "...", ... }

// historyMethod
{ items: [{ nid, lastModified }] }

// logs（可不写 columns，默认 timestamp / level / message）
{ items: [{ timestamp, level, message }] }

// metrics
{ items: [{ id: "cpu", label: "CPU", unit: "%", points: [{ tsMs: 1, value: 12 }] }] }

// facts
{ facts: { version: "1.0", auth: "basic" } }

// tree：嵌套、扁平 parentId、或懒加载均可
{ items: [{ id: "/app", label: "app", children: [{ id: "/app/db", name: "db", leaf: true }] }] }
{ items: [{ id: "root", name: "root", hasChildren: true }, { id: "child", parentId: "root", leaf: true }] }
// 懒加载：展开空文件夹时 Host 再调 childListMethod({ parentId })
{ items: [{ id: "/app", name: "app", hasChildren: true }] }
```

`listItems` 按 `capabilityId` 分发即可，不必为每个槽各写一个方法（当然也可以用 `listMethod` 分开）。

```js
function listItems(args) {
  if (args.capabilityId === "topics") return { items: listTopics(args) };
  if (args.capabilityId === "audit") return { items: listAudit(args) };
  return { items: [] };
}
function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}
globalThis.call = call;
```

---

## Cloud 工作台

`kind=cloud`。连接对话框按已激活的 cloud 插件列厂商。

能力：`cloud.capabilities[]`（`id` / `label` / `scope` / `columns` / `actions` / `detailSlots`）。可选 `cloud.regions[]` 给连接框预置地区。

`detailSlots`：`overview` / `metrics` / `rules` / `logs` / `security` / `records` / `members` / `backups`。

L2 方法（宿主注入 `connectionId`、`accessKeyId`、`accessKeySecret`、`region`、`regions`）：

| 方法 | 返回 |
|---|---|
| `testAccount` | 字符串或 `{ message }` |
| `listRegions` | `{ items:[{ regionId, localName? }] }` |
| `getAccount` | `{ accountId, displayName }` |
| `listResources` | `{ items:[{ id, name, capability, regionId, status, fields }] }` |
| `getResource` | 详情对象 |
| `invokeAction` | `{ ok }` |
| `getMetrics` | `{ items:[{ id, label, unit, points }] }` |
| `queryLogs` | `{ items, nextToken? }` |

`omni.cloud.aliyun` / `omni.cloud.tencent` 走 Rust crate；其它带 `.` 的 `pluginId` 走 L2。签厂商 API 用 `host.hmac`。服务端没有插件运行时，第三方云调用不会在服务端落地。

---

## Engine 工作台（含 Redis）

`kind=engine`。**不要**用 module 的 9 种壳去模拟数据库。声明 `ui.workbench`：

| 槽 | 取值 |
|---|---|
| `tree` | `schema` / `graph` / `keyspace` / `kv` / `collections` / `documents` / `none` |
| `editor` | `sql` / `cypher` / `cql` / `redis` / `none` |
| `preview` | `grid` / `key` / `points` / `document` / `none` |
| `connectionInfo` | `sql` / `redis` / `none` |

Redis 样板：`tree=kv` + `editor=redis` + `preview=key`。MySQL 样板：`schema` + `sql` + `grid`。

第三方引擎走 sidecar（**不用写 inproc Rust**，Rust 以独立进程形态进来）：

```bash
node scripts/create-plugin.mjs my-db engine-sidecar
node scripts/check-dbx-agent.mjs plugins-custom/my-db/bin/agent.mjs
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/my-db my-db.omni-plugin
```

协议全文见 [sidecar-dbx.md](./sidecar-dbx.md)；Node 参考 agent 开箱可跑，
Rust 参考在 `src-agent-rs/`（`cargo build --release` 后把产物拷为 `bin/<engine>` 并改 `entry.driver`）。
拉起规则：`.js/.mjs→node`，`.jar→java -jar`，其它（含 Rust 产物）直接执行。

---

## Panel 工作台

`kind=panel`。连接对话框按已激活的 panel 插件列厂商；`serviceType` 存插件 id。

**页签 / 监控 / 缓存 / 测连只认 `getPanelDriver(serviceType)`**，不按插件 ID 分叉，也没有 `else` 默认宝塔。第一方 1Panel / 宝塔在 `activate` 里登记进程内 TS driver；其它 id 走 L2 `plugin_invoke`（只挂清单 `methods[]` 里声明的方法）。

### 别人怎么接入新面板

```bash
node scripts/create-plugin.mjs my-panel panel
# 编辑 plugins-custom/my-panel/plugin.json：kind=panel，ui.panelTabs + methods[] + entry.logic
# 编辑 logic.js：testConnection / list* / create* / getDashboard
# IO 只走 host.netFetch / host.hmac；空 apiKey 必须拒绝（Host 会注入）
node scripts/validate-plugin.mjs plugins-custom/my-panel
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/my-panel my-panel.omni-plugin
```

设置 → 插件 → 「安装本地插件」。启用后出现在「添加面板」。测连、列表、通用表单新建、行内启停/删除、监控卡片、应用安装确认走 Host 固定壳。样板见 `plugins-samples/panel-starter`。

`ui.panelTabs` 与宿主槽取交集：`overview` / `websites` / `apps` / `certificates` / `cronjobs` / `databases`。未声明的槽不出现。第三方页签升成和 Module 同构的槽声明（第一方仍可只写 `{ "id" }`）：

```json
{
  "id": "websites",
  "listMethod": "listWebsites",
  "formFields": [{ "key": "name", "label": "名称" }, { "key": "domain", "label": "域名" }],
  "actions": [
    { "id": "create", "method": "createWebsite", "target": "toolbar" },
    { "id": "delete", "method": "deleteWebsite", "target": "row" }
  ]
}
```

新建开门：**有 `formFields` → `PluginFormDialog`**；否则若已登记进程内 driver 且有 `create*` → 第一方富弹窗。行内启停/删除看 `typeof driver.setWebsiteStatus === "function"` 等，不看插件 ID。

### Host 壳能实现 / 不会自动给

| 能 | 不能（要 overlays 或将来进第一方 in-proc） |
|---|---|
| 建连入口、页签出现、测连（注入 apiKey） | 1Panel 式 PHP 版本 / 网站编辑弹窗 |
| 列表、通用表单新建、行内启停/删除 | 宝塔应用商店同步细节、图标拉取策略之外的定制 |
| 监控卡片（`getDashboard` 归一化：`hostname` / `cpuCores` / `currentInfo`） | 网站日志 / 配置 / 证书子窗、SFTP |
| 应用安装确认（`installApp`） | 像素级克隆宝塔 / 1Panel 控制台 |

主路径能用，不是厂商后台的像素级克隆。和 Module 九种壳同一纪律。第三方**不要**写 inproc Rust，也不要调用 `createOnePanelClient` / `createBtPanelClient`。

L2 入参由 Host 注入 `address` / `apiKey` / `connectionId`。存盘后前端内存里没有明文密钥，Host 会用 `connectionId` 从 `panel-key-*` 回源再塞进 `apiKey`。插件 **不要** 用 `host.vaultGet` 读面板主密钥——插件 vault 只是 `plugin:{id}:*`，和连接密钥隔离。点名 `panelTabs` 就必须实现对应 `list*`，否则 `validate-plugin` 不通过。

| 方法 | 额外入参 | 返回 |
|---|---|---|
| `testConnection` | — | `{ ok, hostname? }` 或 `true` |
| `listDatabases` | — | `{ items:[{ id, name, username?, type?, remark? }] }` 或数组 |
| `createDatabase` | `name` / `dbUser` / `password` / `charset?` / `remark?` | `{ ok }` |
| `deleteDatabase` | `id` / `name` / `dbUser` / `type?` | `{ ok }` |
| `listWebsites` | `search?` / `groupId?` | `{ items:[{ id, name, domain?, status?, path?, type? }] }` |
| `setWebsiteStatus` | `id` / `siteName?` / `operate`=`start`\|`stop` | `{ ok }` |
| `deleteWebsite` | `id` / `siteName?` | `{ ok }` |
| `listCertificates` | — | `{ items:[{ id, domain?, status?, expire?, hash? }] }` |
| `deleteCertificate` | `id?` / `hash?` | `{ ok }` |
| `listCronjobs` | — | `{ items:[{ id, name, schedule?, status?, type? }] }` |
| `setCronjobStatus` | `id` / `enabled` | `{ ok }` |
| `runCronjob` | `id` | `{ ok }` |
| `deleteCronjob` | `id` | `{ ok }` |
| `listApps` | — | `{ items:[{ id, name, key, type?, icon?, installed?, versions? }] }` |
| `listInstalledApps` | — | `{ items:[{ id, name, appKey?, status?, version? }] }` |
| `createWebsite` | `formFields` 键值 | `{ ok }` |
| `createCertificate` | `formFields` 键值 | `{ ok }` |
| `createCronjob` | `formFields` 键值 | `{ ok }` |
| `getDashboard` | `currentOnly?` | 归一化仪表盘（`hostname` / `cpuCores` / `currentInfo`） |
| `installApp` | `key` / `name` / `version?` | `{ ok }` |
| `uninstallApp` | `key` / `id?` | `{ ok }` |

写操作建议带 `dangerAction`（如 `panel.website.delete`）。脚手架默认只声明 `overview` + `databases`；样板 `panel-starter` 点名全部槽，并用 `host.netFetch` / `host.stateGet` fixture 证明列表非空。

---

## Importer

`kind=importer`。声明 `importers[]`（`id` / `label` / `fetchMethod` / 表单字段）。向导调 `plugin_invoke(fetchMethod)`，把候选写入连接。

`fetchMethod` 必须出现在 `methods[]`。返回 `{ targets: ImportCandidate[] }`（至少一条可导入的 SSH / Panel 候选，空数组不算验收）。

```bash
node scripts/create-plugin.mjs my-import importer
```

---

## Addon

`kind=addon`。L1 即可：`launcher` / `overlays[]` / `menus[]` / `ai.tools[]` 至少一项。启动条、菜单不需要 `logic.js`。

Overlay 才要 `overlays[].entry`（HTML）+ 可选 L2。`theme` 禁止 `js: true`；addon 的 JS 只走 overlay / method，不要把主题逻辑塞进来。

```bash
node scripts/create-plugin.mjs my-addon addon
```

---

## 权限

`vault:read` / `connections:write` / `net:connect` / `ssh:exec` / `ui:selection` / `ui:sidebar` / `ai:tools` / `fs:read`。

缺权即失败。`netFetch` 命中 `env_tag=prod` 的主机会弹确认。

`methods[].dangerAction` 与后端 `consume_grant` 对齐：写操作先弹确认，插件不能自签令牌。

---

## 打包与调试

```bash
node scripts/validate-plugin.mjs plugins-custom/my-plugin
# 或：npm run plugin:validate -- plugins-custom/my-plugin
# 扫描样板：npm run plugin:validate -- plugins-samples
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/my-plugin my-plugin.omni-plugin
```

- **第三方包校验**：`node scripts/validate-plugin.mjs <dir>`（清单、kind 合同、入口文件、`logic.js` 可装载）。
- **第一方仓库门禁**：`npm run check:plugin-manifests`（与 Rust / 前端目录双向）。
- 第一方 `logic.js` 是 `include_str!`，改完要 **重编 Tauri**。第三方安装包改完重新 pack 再覆盖安装即可。
- 常见错误：`UnknownMethod`、缺少权限、`fsRead` 越界、`minHostApi` 高于宿主。
- Dev 构建接受未签名/开发签名包；release 拒绝。
