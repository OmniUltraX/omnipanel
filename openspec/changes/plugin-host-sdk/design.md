## Context

OmniPanel 已是模块化产品，但扩展是封闭集合：`ConnectionKind`、`db_type` 联合类型、`serviceType: "bt"|"1panel"`、`CloudProvider = "aliyun"`、快捷启动前缀 `ssh|db`、侧栏 `navPaths`。同时存在可升格的准插件：`DbDriver` / `DockerAdapter`、`AppModule` 开关、OmniMCP、工作区组件注册表、Navicat 预览、SSH 扫面板/Docker、`cloudSource` 血缘。

Tauri 不能运行时加载 Rust crate。不可信 JS 与主 WebView 同进程等于把 Vault/SSH 交给插件。因此本期第一方插件 **编译进包、API 先真**，加载器可后续换成 WASM/sidecar 而不改清单合同。

## Goals / Non-Goals

**Goals:**

- 一个 Runtime、七种 kind、若干 Host（工作台 + 总线），贡献点公共、身份不独占插槽。
- 第一方插件与宿主同一 SDK；官方样板进 `plugins/` 与 CI。
- 连接、标签、环境、Vault、任务中心、prod 确认仍由宿主强制。
- 云独立侧栏；发现/导入/血缘闭环可复用于 Warpgate 与 Nacos 扫描。

**Non-Goals:**

- 第三方商店、代码签名审核、动态加载原生动态库。
- 插件自建 `WebviewWindow`。
- 本期做完 Nacos 产品、翻译产品、CDN 全控制台。
- 把 Terminal / SSH / Vault / specta 主命令表插件化。

## Decisions

### 决策 1：Host 是插座板，kind 是身份证

**Host** = 内核里稳定的工作台或总线（UI 壳 + 权限闸 + API）。**kind** = 插件主业。一个插件可向多台 Host 登记。

```
                         Plugin Runtime
                    清单 / 权限 / activate
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   领域工作台 Host           连接台                 横切总线 Host
   Database / Panel          Vault                 菜单·命令·选区·Overlay
   Cloud / Module Shell      tags                  Quick Launcher
   Files / Protocol          externalSource        发现（SSH/Docker/面板）
   Importer 预览壳                                 Theme / OmniMCP / 工作区
```

**不新增 Host 的判断：** 没有整块日常界面、且不会有多个插件共用同一插槽 → 不是 Host（翻译不是 Host，快捷启动才是）。

备选：把一切叫 Extension，不分 Host。否决——工作台壳（SQL 网格 vs 云 Region Tab）差异太大，混成一个 API 会变成 hook 大海。

### 决策 2：七种 kind 锁死，不再随功能加第八种

| kind | 主业 | 默认侧栏 | 官方样板 |
|------|------|----------|----------|
| `engine` | 数据引擎 | 无（进 Database） | `db-qdrant`（迁入） |
| `panel` | 机器面板协议 | 无（进 Server） | `panel-1panel` |
| `importer` | 外部清单→连接 | 无 | `importer-warpgate` |
| `cloud` | 云厂商账户+产品 | 云模块内 | `cloud-aliyun` |
| `module` | 自带控制台 | 有，默认 `closed` | 后期 Nacos；本期只留壳 |
| `theme` | token + 终端色板 | 无 | `theme-default`（现暗/亮） |
| `addon` | 命令/菜单/浮层/启动器源/本机工具 | 无 | `addon-everything`；分享菜单迁入；翻译后期 |

新需求先问落在哪条 **贡献点**，而不是新 kind。Kafka/Consul/Harbor → `module`；计算器/翻译 → `addon`；Nord 皮肤 → `theme`。

备选：只有 `connector | app` 两种。否决——主题禁止 JS、addon 无连接、cloud 有 Region 模型，挤在一起权限模型会错。

### 决策 3：分层贡献，声明式优先

```
L1 清单 + JSON Schema + capabilities     多数 engine / theme
L2 UI 插槽（宿主组件）                    panel Tab、导入向导、Redis 树
L3 完整模块壳                             module；Warpgate 用不到 L3
```

主题 v1 **禁止 JS**，只交 JSON token。Addon 允许在 Overlay 内用 `plugin-ui`。

### 决策 4：连接模型打开，血缘统一

- 粗粒度 `ConnectionKind` 保留：`ssh | database | docker | panel | cloud | protocol | file`，**新增** `service`（module 实例）。
- `database` 的引擎、`panel` 的厂商、`cloud` 的厂商改为 **开放字符串**（插件 id / engine key），配置仍在 `config` JSON。
- `SshConfigJson.cloudSource` 升级为通用：

```ts
externalSource: {
  pluginId: string;
  accountId?: string;
  remoteId: string;
  remoteKind: string;
}
```

导入、云「加入终端」、SSH 扫 Nacos，一律按 `(pluginId, accountId, remoteId)` 去重再同步。标签继续 `TaggableKind::Connection`。

备选：每种插件一个新 `ConnectionKind`。否决——enum 再次封闭。

### 决策 5：第一方编译进包，API 按可卸载设计

```
packages/plugin-sdk          Host API 类型、清单 schema
packages/plugin-ui           Button/Dialog/Tree/DataGrid/ImportPreview/…
plugins/db-*                 第一方引擎
plugins/panel-1panel|bt
plugins/cloud-aliyun
plugins/importer-warpgate
plugins/theme-default
plugins/addon-everything     Windows Everything IPC（Native MCP + 启动器 es）
crates/omnipanel-plugin      清单校验、权限、注册表（Rust）
crates/omnipanel-everything  Everything 查询（cfg(windows) IPC；非 Windows stub）
```

静态装载：构建期把第一方插件链进前端 chunk 与 Rust registry。清单与 `activate(ctx)` 合同稳定后，加载器可换成磁盘包/WASM。

Tauri 主 `collect_commands!` **不**对第三方开放。插件后端走 Host 已暴露的命令，或第一方 crate 在编译期登记到 **插件命令网关**（`plugin_invoke(plugin_id, method, json)`），避免每插件改 specta 清单。

### 决策 6：权限由宿主强制

声明式权限：`vault:read`（仅自己创建的 ref）、`connections:write`、`net:connect`、`ssh:exec`、`ui:selection`、`ui:sidebar`、`ai:tools`、`fs:read`。缺权 API 失败。`ssh:exec` 用于发现扫描，须可按主机确认；`env_tag=prod` 仍走 ExecutionEngine / 二次确认。Audit 记 `pluginId`。

主题包 `permissions: []`。Everything addon 默认不声明 `net:connect` / `vault:read`；工具只返回路径元数据。翻译类 addon 必须 `ui:selection` + `net:connect`，只给当前选区快照，禁止键盘钩子。

清单可含 `platforms: ["windows"]`：当前 OS 不匹配则 **不 activate**，`plugin_list` 仍可见但标记 `unsupported`。

### 决策 7：快捷启动与 Overlay 是总线，不是插件

快捷启动 **窗口**（无边框 WebView、热键、排序、最近项）是内核 Host。`QUICK_LAUNCH_COMMAND_PREFIXES` 改为 provider 注册表；内核登记 `ssh`/`db`。插件贡献 `contributes.launcher`。

轻量窗策略：全局轻量窗仅此一扇；插件 UI 用 Overlay 或启动器结果行。禁止插件 `WebviewWindowBuilder`。

菜单：所有 `ContextMenu` 经贡献表合并；`withGlobalShareMenuItem` 改为内核 addon。`when` 支持 `selection.hasText`、`resource.kind`。

选区总线：`host.selection.get()` 聚合终端 / 编辑器 / DOM 选区。

### 决策 8：AI 工具只进 OmniMCP，插件可登记 Native 执行器

插件 `contributes.ai.tools` 并入现有 OmniMCP / builtin 开关与模块过滤，不另起协议。Skill 仍是知识插件，不是代码插件。

今日 `BUILTIN_TOOL_SPECS` 是静态数组，插件无法登记新工具。Runtime MUST 允许第一方插件在 activate 时把 `ToolSpec`（name / description / input_schema / exec_kind / module_key / cross_module / plugin_id）并入 `ToolRegistry`。`exec_kind=Native` 按 `plugin_id` 分发到插件查询函数（Everything 等），禁止每加一个工具就改 `ai_chat.rs` match。禁用插件后工具 MUST 从模型清单消失。插件工具 `external_exposed` 默认 false。

### 决策 9：前后端边界

| 层 | 职责 |
|----|------|
| `crates/omnipanel-plugin` | Manifest、权限、Registry、Candidate 模型 |
| `omnipanel-store` | AppModule 动态补种、ConnectionKind::Service、externalSource 列或 JSON 约定 |
| `omnipanel-db` / docker / cloud | 引擎/面板/云厂商 **注册表** 替代巨型 match |
| `omnipanel-everything` | Everything 命名管道 / WM_COPYDATA；不链 Everything64.dll |
| `src-tauri/commands` | 薄桥：`plugin_list` / `plugin_set_enabled` / `plugin_invoke` / 发现任务 |
| `frontend` 宿主 | Sidebar 注册表、各 Host 壳、菜单/启动器/主题 apply、`appearanceSync` 含 `themePackId` |
| `plugins/*` | 业务：表单字段、probe、映射、厂商 OpenAPI |
| `packages/plugin-ui` | 再导出 `components/ui` 稳定面，插件禁止 import `frontend/src/modules/*` |

新增 IPC（specta → `bindings.ts`，禁止手写 invoke 字符串）：

- `plugin_list` / `plugin_set_enabled`
- `plugin_invoke(pluginId, method, args)`（第一方网关）
- `discovery_run(probeId, scope)`（后台任务，进度进任务中心）
- `import_preview_upsert`（或复用 conn_save + 前端预览壳）

UI 复用：`Button`、`TextInput`、`Dialog`、`ContextMenu`、`ModuleWorkspaceLayout`、`DbTablesPanelGrid`、Navicat 预览对话框升格为 `ImportPreview`。主题 token 继续 `tokens.css`；公开合同与别名分层。

### 决策 10：云独立侧栏与产品矩阵

路由 `/module/cloud`（`MODULE_PATHS.cloud`）。Server 只留面板。Cloud Host：账户树 → Region → Tab。厂商插件映射：

`compute` / `compute.lite` / `objectStorage` / `dns` / `cdn` / `certs`

阿里云一个插件覆盖 ECS/SWAS/OSS/域名/证书，CDN 作为该插件的 product contribution，不拆 `aliyun-cdn` 包。OSS 同时贡献 Files 后端（已有「加入文件」）。

### 决策 11：Everything 作为 addon 官方样板

Everything 已在本机建索引；OmniPanel 只做 IPC 查询。分类：`kind: addon`，不占侧栏。

```
用户 / 模型
    → omni_everything_search { query, max_results }
    → ToolRegistry Native（plugin_id=omni.addon.everything）
    → 管道 \\.\PIPE\Everything IPC（失败再试 (1.5a)）
    → 否则 WM_COPYDATA 1.4
    → [{ path, size, mtime, is_folder }]
    → 模型再调 files 工具读内容（既有确认）
```

约束：

- 必须已运行 Everything；不自动拉起。
- 不 `LoadLibrary` 官方 SDK DLL 作为主路径。
- 只返回路径元数据，默认不读文件内容。
- `max_results` 封顶（建议 200）；`module_key` 跨模块（与 `omni_web_search` 类似），终端 Agent 也能搜。
- 非 Windows：不 activate；工具不出现。
- 可选 `contributes.launcher.prefix = "es"`，与 AI 共用同一查询函数。

这是 addon 狗粮（对照 Qdrant=engine、Warpgate=importer、阿里云=cloud），用来卡住「插件 Native 工具」这条 API。

### 核心闭环（必须通）

**A. 启用插件**

```
install(编译进包) → repair_app_modules / plugin_list
  → 用户 open（module 默认 closed）
  → activate → 登记贡献点 → 侧栏/Tab/菜单/启动器出现
  → closed/disable → deactivate → 贡献点卸除，连接数据保留
```

**B. 引擎查询**

```
engine 登记 key → 连接对话框按 form.fields 渲染
  → conn_save + vault → Database 树按 capabilities 切预览
  → omni_database_* 按模块过滤
```

**C. 发现 / 导入**

```
probe(ssh|docker|http) → Candidate[]
  → ImportPreview（可导入/重复/不支持）
  → upsert + externalSource + vault
  → 再同步按三元组匹配
```

Warpgate：连接 **指向堡垒入口**（`user:target@warpgate`），禁止写成内网 IP。

**D. 云加入终端**

```
ECS 行 → 加入 SSH → kind=ssh + externalSource
  → 标签/环境沿用账户或用户改
  → 反查「已加入」
```

**E. Addon 翻译（插槽，产品后期）**

```
选区总线 → 菜单 when=selection.hasText
  → Overlay 翻译面板 → net:connect
```

**F. 主题**

```
选包 → 校验公开 token → 写 CSS 变量 + xterm ITheme
  → data-theme 仍管 light/dark color-scheme
  → data-theme-pack / appearanceSync.themePackId
```

**G. Everything 本机搜索**

```
插件 enabled 且 platforms 含当前 OS
  → 登记 omni_everything_search + 启动器 es
  → Native IPC 查询
  → 未运行则 OmniError（i18n）
  → disable → 工具与 es 前缀消失
```

### 与现有模块联动

- SSH → Docker 扫描、SSH → 面板探测：改为发现总线的内核 probe，面板/module 插件追加 probe。
- Database → AI：引擎 MCP 工具仍走 OmniMCP；Everything 为跨模块 Native 工具，不替代 files 读取。
- 云 ECS → 终端：已有 `addCloudInstanceToSsh`，改为 `externalSource`。
- 工作区小部件：继续 `registerWorkspaceComponent`，纳入贡献点 `workspace.widgets`。
- 任务中心：发现/导入/云长操作用现有后台任务，不新建任务系统。

## Risks / Trade-offs

[第一方仍编译进包，看起来不像插件] → 以清单+activate 为合同，CI 用 Warpgate/Qdrant/阿里云/Everything 四个样板卡 API；加载器后换。

[侧栏被 module 塞满] → 插件模块默认 `closed`；同控制台不拆多图标。

[开放引擎字符串导致 UI 分支爆炸] → capabilities 驱动树/预览；未知引擎走声明式表单+通用网格。

[plugin_invoke 成为万能 IPC] → 方法名白名单按插件清单 `methods[]`；参数 JSON schema 校验；禁止转发到任意 Tauri 命令。

[选区/翻译泄漏密钥] → `ui:selection` 一次性快照；默认不出网；文案提示。

[主题不改终端] → 主题包必填或显式回退 `terminal.json`；编辑器/网格读 CSS 变量。

[包体] → mysql/pg/sqlite/redis + 两面板 + 阿里云 + 默认主题进默认包；Warpgate / Everything 可默认关闭仍进仓库（Everything crate 非 Windows 为空实现，几乎不增包体）。

[Everything 把全盘文件名喂给模型] → 条数封顶；外露默认关；不读内容；audit 记 query 摘要。

## Migration Plan

1. Runtime + 注册表空转：现有模块/引擎 **登记**，行为不变。
2. Sidebar / AppModule 改读注册表；增加 `cloud` key；Server 去掉云树（数据 `kind=cloud` 不变）。
3. `db_type` 联合类型放宽；Qdrant 迁 `plugins/db-qdrant`。
4. `serviceType` 别名保留；1Panel/BT 迁 panel 插件。
5. `cloudSource` 读写兼容新旧字段，双写一个版本后只读 `externalSource`。
6. 快捷启动前缀注册表；分享改菜单总线。
7. 暗/亮登记为 `theme-default`。
8. Warpgate 样板走导入闭环（可先 mock API 再接真实 token）。
9. Everything addon：Native 工具登记 + Windows IPC；非 Windows 跳过 activate。

回滚：登记表可开关回退硬编码路径（feature flag `plugin_registry`），直到侧栏/云拆分稳定。

## Open Questions

- Warpgate 默认安装包启用还是默认 closed（倾向 closed，仓库仍包含）。
- `plugin_invoke` 是否仅 Rust 第一方，前端插件只调 typed Host API（倾向：前端只走 Host API，invoke 给 Rust 侧厂商 SDK）。
- Everything 默认 enabled 还是 closed（倾向 Windows 上 enabled、工具外露默认关）。
