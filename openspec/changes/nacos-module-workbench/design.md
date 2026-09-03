## Context

用户要把 Nacos 做成 **可安装模板**，方便后续 Kafka/Consul 只交包。这推翻前一版「`omnipanel-nacos` crate + 插件内 React UI」：第三方装不了原生库，主 WebView 也不能跑不可信 React。

已有底座：`.omni-plugin` 安装/验签、L2 `logic.js`（Warpgate + `host.netFetch`）、L1 脚手架（仅 engine/theme）、云能力合同（Host 画格子）。缺的是 **module 能力合同** 和 **module 包模板**。

## Goals / Non-Goals

**Goals:**

- Host 只认 `contributes.module.capabilities[]`，不认 Nacos。
- 插件 = 清单 + L2 逻辑包，可 pack / 安装 / 卸载。
- Nacos 是官方狗粮，目录形状与第三方相同。
- `create-plugin.mjs module` 能生成可安装空包。

**Non-Goals:**

- L3 iframe 当主控制台；Nacos 专用 Rust crate；插件 React 进主 chunk；在线商店；3.x 必达。

## Decisions

### 决策 1：可安装 ≠ L3；模板主路径是 L2 + Host 插槽

```
开放梯度（代码怎么跑）     贡献身份（有没有工作台）
L1 声明式                  engine / theme
L2 logic.js / wasm    ←→   module 的业务方法（本模板）
L3 沙箱 iframe             仅 Overlay 怪页面，不是 module 默认
```

Module 主 UI **必须**由 Host 用现有组件画（列表、文本编辑器、表格、Dock）。插件只声明能力、实现 methods。L3 不作为 Nacos/Kafka 模板。

备选：L3 填右侧主区。否决——编辑器/Dock/标签无法复用，下一只模块又写一套 HTML。

### 决策 2：能力合同对齐云，不齐产品名

冻结 id（未声明则无节点）：

| id | Host 插槽 | Nacos |
|----|-----------|--------|
| `namespace` | 顶栏切换 + 可选 CRUD | 命名空间 |
| `config` | 列表 / 编辑器 / 历史 | 配置
| `discovery` | 服务列表 / 实例表 | 命名服务 |
| `cluster` | 概览节点 | 集群节点 |

后续 Consul 可只声明 `namespace`+`config`+`discovery`；Kafka 另增 `topic`（本期 Host 可不实现，声明了给未知能力空态）。列、动作、danger 由清单 `columns` / `actions` 声明，Host 画格子。

```
实例
  ├─ 配置      ← capability config
  ├─ 服务      ← discovery
  └─ 节点      ← cluster
顶栏命名空间   ← namespace
```

备选：每插件登记 React workbench。否决——不可安装、不可当模板。

### 决策 3：业务在 L2 logic.js，出网只走 host.netFetch

包形状（与文档 `packaging-and-install.md` 一致）：

```
omni.module.nacos.omni-plugin
├─ plugin.json          kind=module，entry.logic=logic.js
├─ logic.js             call(method, argsJson)
├─ icon.svg             可选
└─ signature.ed25519
```

```
Module Host
  → plugin_invoke(pluginId, "publishConfig", args)
  → 权限 / methods 白名单 / prod 闸 / audit
  → L2 call() → host.netFetch / host.vaultGet
```

**不**新增 `nacos_*` specta 命令。**不**建 `omnipanel-nacos` crate 作为实现源。第一方内置时嵌入同一份 `logic.js`（对照 `first_party_logic_bytes` + Warpgate）。

1.x/2.x 方言、token 缓存在 **logic.js 内存 + host.state***（或每次 login）；密钥只从 Vault 读。未识别版本拒写。

备选：Rust 客户端。否决——模板装不进第三方包。

### 决策 4：官方 Nacos 可内置，但必须能原样打包

`plugins/module-nacos/` 是唯一事实源。`distribution=bundled` 方便默认用户；同一目录 `pack` 后必须能在无内置的环境当第三方装上（id 冲突时内置优先，样板用 `omni.module.starter` 验收安装）。

卸载：磁盘来源可卸；内置只能禁用。禁用/卸载都撤贡献点，`kind=service` 行保留。

### 决策 5：脚手架是模板交付物

```
node scripts/create-plugin.mjs my-consul module
→ plugins-custom/my-consul/
    plugin.json   moduleKey + connectionForm + capabilities + methods 桩
    logic.js      testConnection / 按已声明能力返回空列表
    README.md     pack / 安装
```

验收：空包安装 → 侧栏出现 → 建连调桩 → 声明了 `config` 就有配置插槽。这是「后面模块怎么接」的说明书。

### 决策 6：工作台仍用宿主组件，插件零 UI 代码

复用：`ModuleWorkspaceLayout`、`VerticalSplitSidebar`、`ModuleSegmentDock`、`FormDialog`、`ScopedSearch`、文本编辑器、`useModuleTagFilter`。tokens.css。

连接 `kind=service`，`config` 含 `pluginId` + 表单字段；密码 `credential_ref`。扫描 `externalSource` 三元组去重。

### 决策 7：扫描 / AI 也挂在包上

`contributes.discovery` + L2 `mapProbe`/`probePorts`（或宿主通用「端口 + 健康 URL」+ 插件 `claims` method）。`launcher.prefix`、`ai.tools` 只读，执行进 L2。写方法不对 AI 开放。

### 前后端边界

| 层 | 职责 |
|----|------|
| `frontend/src/modules/plugin-module` | Host 壳 + 能力插槽，禁止按 nacos 特判 |
| `packages/plugin-sdk` | `contributes.module` Zod |
| `plugins/module-nacos` | 狗粮清单 + logic.js |
| `plugins-samples/module-starter` | 最小可安装模板 |
| `scripts/create-plugin.mjs` | kind=module |
| L2 运行时 / `plugin_invoke` / 安装器 | 已有，不新开 IPC 业务面 |
| `omnipanel-store` | 已有 `ConnectionKind::Service` |

## Risks / Trade-offs

[logic.js 实现完整 OpenAPI 偏重] → 先锁 methods 与 DTO；Nacos 狗粮允许较长 JS，模板桩保持薄。比「每家一个 crate」更可复制。

[QuickJS 性能/超时] → 列表分页；单次默认 10s；大配置编辑在 Host，L2 只传文本。

[能力 id 不够 Kafka 用] → 合同允许未知 id 空态；新插槽另开 Host 迭代，不改旧包。

[内置与安装包 id 冲突] → 安装器已拒；模板用独立 id 验收。

[L2 尚未做完 prod 闸任务 7.3] → 写方法必须复用宿主确认；缺则本变更补齐，不给插件旁路。

## Migration Plan

1. SDK + Host 能力壳 + 声明式建连（Nacos 清单先声明能力，logic 可桩）。
2. 脚手架 + module-starter 安装闭环。
3. Nacos logic.js 探测与配置读写/发布。
4. 服务/节点/扫描/AI。
5. 内置仍默认 closed；pack 路径进 CI。

回滚：禁用 Nacos；卸第三方包；Host 对无能力模块回退空态。

## Open Questions

- 扫描「端口 + 健康 URL」是 Host 通用 probe 还是每包自写 L2（倾向：Host 通用 + 插件声明 ports/path + `claims` method）。
- `host.state*` 是否够用 token 缓存，还是每次请求 login（倾向：state 缓存，过期再登）。
