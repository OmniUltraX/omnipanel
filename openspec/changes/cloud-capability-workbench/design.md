## Context

`/module/cloud` 已独立，第一方清单 `omni.cloud.aliyun` 声明了 5 个 `panelTabs`，但 Host 仍按阿里云封闭集合工作：

- 树：账户 → 地域；产品在右侧内 Tab（`ecs|swas|oss|domains|certs`）。
- IPC：`cloud_list_ecs` 等产品命令；`aliyun.rs` 在 `crates/omnipanel-server` 与 `src-tauri/commands/cloud` 各一份。
- `CloudProvider = "aliyun"`；禁用插件不卸能力；无概览/详情/开停机。

数据库 Host 已是「连接 → 库 → 表」+ 概览/列表/详情 + 单击预览双击常驻。云应对齐同一工作台，厂商只填能力合同。

约束：Tauri 不能热加载 Rust crate；主 `collect_commands!` 不对第三方开放；凭据只走 Vault；`env_tag=prod` 写操作必须确认。第一方云插件 **编译进包**，经 `InvokeGateway` 登记。

## Goals / Non-Goals

**Goals:**

- 能力合同 + `CloudProviderDriver`；Host 只认能力 id，不认 ECS/CVM。
- 三层树（账户 → 能力 → 实例）+ 三级 Dock；地域为筛选。
- 阿里云迁入独立 crate，泛化 specta 命令分发。
- 动作分档：宿主跨模块 / 插件 API / 外链；prod 闸 + audit。

**Non-Goals:**

- 第二家厂商实现、完整账单/IAM/VPC、L3 详情、DNS 记录上树、对象浏览器替代 Files。

## Decisions

### 决策 1：树是账户 → 能力 → 实例，不是厂商 → 能力

厂商是账户上的 `pluginId`（图标/Driver），与数据库「引擎不是树根」相同。多个阿里云账户各自为根。

实例懒加载：展开能力节点才 `listResources`。地域筛选同时过滤树子节点与列表。全局能力（`domains` / `certs` / `dns`）无地域筛选。DNS 的树实例是托管区，解析记录只在详情嵌套列表。

备选：实例不上树。否决——已与产品确认要对齐表节点。

### 决策 2：能力 id 冻结，compute 与 compute.lite 分开

| id | scope | 阿里云 |
|----|--------|--------|
| `compute` | region | ECS |
| `compute.lite` | region | SWAS |
| `objectStorage` | region | OSS |
| `domains` | global | 域名注册（≠ DNS） |
| `dns` | global | 本期阿里云可不声明 |
| `certs` | global | 证书 |
| `cdn` | global | 预留，未声明则无节点 |

`CloudRegion.capabilities: string[]` 替代 `hasEcs` / `hasSwas`。

### 决策 3：Driver 在 crate，Host 用 5 条泛化 IPC

```
前端 modules/cloud
  → commands.cloudTest / cloudListRegions / cloudListResources
     / cloudGetResource / cloudInvokeAction
  → src-tauri/commands/cloud（薄桥：解连接、Vault、prod 闸、audit）
  → InvokeGateway (omni.cloud.aliyun, method)
  → crates/omnipanel-cloud-aliyun（签名、映射）
```

specta 类型：`CloudResourceRow`、`CloudResourceFilter`、`CloudResourceDetail`（按 capability 的 tagged union 或 `kind` + JSON 文档）、`CloudAction`。`npm run gen:bindings`。

删除主路径 `cloud_list_ecs|swas|oss|domains|certs`。桌面与 server 共用同一 Driver，禁止再复制 `aliyun.rs`。

备选：前端直调 `plugin_invoke`。否决——凭据与 prod 闸必须停在 commands 层。

### 决策 4：清单声明列/动作/表单，Host 画格子

`contributes.ui.connectionForm` 对齐引擎芯片。`contributes.cloud.capabilities[]` 含 `columns`、`actions`、`scope`。未激活插件不出现在对话框与树。

动作分档：

- Host：`addSsh`、`addToFiles`（现有 `externalSource`，逻辑留在云模块内写 connectionStore；不跨 module 引用面板 UI）。
- Plugin：`start` / `stop` / `reboot` / 以及清单声明的其它 `invokeAction`。
- 外链：`openConsole`（插件详情给 URL，Host `open`）。

详情：Host 按能力提供插槽（ComputeDetail / BucketDetail / DomainDetail / CertDetail / DnsZoneDetail）。插件 `getResource` 填规范化字段 + `extra`。单击列表行可出 inspector；双击开详情 Tab。

UI 复用：`ModuleWorkspaceLayout`、`VerticalSplitSidebar`、`SidebarTree*`、`ModuleSegmentDock`、`DbTablesPanelGrid`、`FormDialog`、`Button`、`ScopedSearch`、标签筛选（模块标签已有，地域用芯片/MultiSelect）。tokens.css，不新开视觉体系。

### 决策 5：连接 config 打开 provider

`config.pluginId`（或 `provider` 开放字符串）标识 Driver。读时：`aliyun` → `omni.cloud.aliyun`。Secret 仍 `cloud-secret-{id}` Vault。

### 决策 6：代码放哪

| 层 | 位置 |
|----|------|
| 工作台壳、树、Dock、筛选、详情壳 | `frontend/src/modules/cloud/` |
| 加入 SSH/文件 | `modules/cloud/` 内链接助手，经 `connectionStore`；禁止再从 cloud 深引用 server 面板页 |
| 现 `modules/server/cloud` | 迁入 `modules/cloud` 后删除或仅留 re-export 过渡 |
| 泛化命令 | `src-tauri/src/commands/cloud/` 薄桥；业务在 crate |
| Driver | `crates/omnipanel-cloud-aliyun/` |
| 清单 | `plugins/cloud-aliyun/plugin.json` |
| 方法白名单 | 清单 `methods[]` + `InvokeGateway::register` |

跨模块：云 → SSH / 文件 只通过保存连接；文件模块 S3（aws/tencent）仍是 Files 后端，不是 cloud 插件。

## Risks / Trade-offs

- [实例过多拖垮树] → 懒加载 + 与列表共享筛选；后续可加「仅运行中」而不改层级。
- [详情 schema 过厚] → 能力级固定字段 + `extra`；监控曲线可第二期，第一期至少静态字段 + 动作。
- [开停机误操作] → prod 确认 + audit；非 prod 仍 toast/按钮二次确认（与危险命令同级，具体跟现有 `appConfirm`）。
- [双份 aliyun 迁移漏] → 单测 + 删除旧模块编译失败即暴露。
- [server crate 与桌面命令分叉] → Driver 只放 cloud-aliyun crate，两边只调 trait。

## Migration Plan

1. 落地合同类型与 Driver trait（阿里云 adapter 仍调现有 list 函数）。
2. 泛化 IPC 与前端列表改走 capability（Tab 文案改能力 id）。
3. 换树与 Dock（可与 2 同迭代）。
4. 把 HMAC 客户端搬进 `omnipanel-cloud-aliyun`，删产品 IPC。
5. 详情 + invokeAction + 启用门控。
6. 旧地域树/内 Tab 代码删除。

回滚：连接 config 别名仍可读；一个版本内可保留已弃用命令转发到 `listResources`，下一版删除。

## Open Questions

- 监控时序图是否纳入第一期详情：默认 **不做图表**，详情以字段 + 动作为主；需要时再加 `getMetrics` method。
- 账户概览「配额」：阿里云未声明则不出子 Tab（与提案一致）。
