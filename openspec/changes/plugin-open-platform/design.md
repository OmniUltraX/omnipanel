## Context

`plugin-host-sdk`（已实施）建立了：Rust `PluginRegistry` + 清单 Zod/Rust 双端 schema、`plugin_settings` 持久化、`plugin://changed` 事件、七种 kind、8 项权限枚举、CI 清单校验。但审计结论（见 proposal.md 表格）是「声明式骨架真、插件代码无、消费靠特判」。本变更不推翻既有合同——清单字段、kind、权限枚举全部沿用——只补齐「泛化消费」与「可装载/可执行」两层。

关键约束：

- Tauri 主 WebView 与插件不可信 JS 同进程 = 泄漏 Vault/SSH（design 红线），因此第三方逻辑不能直接进主 chunk。
- 第一方仍编译进包（阶段 A 不改变这一点），阶段 B 的磁盘包先服务 L1 声明式，L2/L3 分期。
- `plugin_settings` 表已有 enabled 持久化，第三方安装复用。

## Goals / Non-Goals

**Goals:**

- 阶段 A：单源注册表；贡献点全泛化；activate 合同真实化；权限下沉后端 + audit。
- 阶段 B：`.omni-plugin` 包格式与签名；安装/卸载；L1 开放可用；L2 WASM 与 L3 沙箱 UI 的合同与样板。

**Non-Goals:**

- 在线市场、自动更新、遥测。
- 原生动态库加载；主命令表开放。
- 本期完成 L3 完整组件体系（只打通 iframe 桥 + 一个样板）。

## 决策 1：PluginCatalog 单源，前端不再 import 插件源码

现状：前端 5 处手写 `import xxxManifest from "../../../../plugins/*/src/index"`。改为：

```
plugin_list() -> Vec<PluginListItem>            // 保持不变（设置页轻量列表）
plugin_manifests() -> Vec<PluginManifestDto>    // 新增：id/kind/enabled/activated + manifest 全文
```

- 后端 `first_party_manifests()` 是唯一事实源（已是）。
- 前端新增 `frontend/src/lib/pluginCatalog.ts`：缓存 manifests + 订阅 `plugin://changed` 重拉；提供按 kind 过滤的查询函数。
- 删除 `engineRegistry.ts` / `pluginModuleRegistry.ts` / `panelTabSlots.ts` / `cloudCapabilities.ts` 中对 `plugins/*` 的直接 import。
- `ALIYUN_CLOUD_TABS` 等与 manifest 重复的常量删除，云 Tab 从 manifest `panelTabs` 读取。

备选：前端构建期用 vite 插件聚合 manifests。否决——运行时单源才能让第三方包走同一通道。

> **实施修订（2026-08-21）**：第一方清单在编译期内置的前提下，「运行时 IPC 单源」会引入启动竞态（hydration 前 Catalog 为空 vs 现行为 pre-hydration 全可见），故调整为混合形态：
> - **构建期**：`frontend/src/lib/pluginManifests.ts` 直接 import 各 `plugins/*/plugin.json` 作为前端唯一事实源（集中一处、CI 双向校验目录一致性、防手写数组回流）。legacy 别名映射集中在该文件 `LEGACY_PLUGIN_ALIASES`。
> - **运行期逻辑登记**：新增 `frontend/src/lib/pluginRuntimeLoader.ts` 作为宿主唯一合法插件逻辑桥接点（面板探测 mapper、导入器贡献经注册表登记；幂等，由 `initPluginRuntimeStore` 触发）。
> - **`plugin_manifests` IPC 推迟到阶段 B**：与磁盘包安装（任务 5.x）一并落地，届时 Catalog 合并「内置 + 已安装」两来源，第三方走同一通道的初衷不变。
> - CI（`check-plugin-manifests.mjs`）：前端目录完整性双向校验 + 宿主禁直接 import 插件源码（白名单仅上述两个桥接文件）。

## 决策 2：activate(ctx) 是插件侧导出函数，Runtime 统一调用

```ts
// packages/plugin-sdk
export type PluginActivateContext = { host: PluginHost; manifest: PluginManifest };
export type PluginModule = { activate: (ctx: PluginActivateContext) => void | Promise<void>; deactivate?: () => void };

export function definePlugin(module: PluginModule): PluginModule;
```

- 第一方：每个 `plugins/*/src/index.ts` 导出 `definePlugin(...)`；`frontend/src/lib/pluginRuntimeLoader.ts` 用静态 import map（`Record<pluginId, PluginModule>`）在 activated 时调用。静态打包是过渡形态，加载器接口即未来第三方入口。
- 迁移顺序：先把 Everything 的 es provider 注册、菜单 share addon 登记挪进各自 activate；再逐步把引擎表单校验等纯数据贡献保留在 manifest（不需要 activate 的就不写 activate）。
- deactivate 必须逆序卸载本次登记的一切（launcher/menu/tool/overlay）；`plugin://changed` 触发 loader 重跑差量。

## 决策 3：AI Native 工具泛化分发

现状 `sync_native_plugin_tools()` 只写 Everything。改为：

- 遍历 activated manifests 的 `contributes.ai.tools`；
- `exec_kind=native` 的 executor 统一为「转发 InvokeGateway `(plugin_id, tool.name)`」；工具实现注册进 Rust 侧 `InvokeGateway::register`（第一方在编译期，第三方经 WASM host function）；
- `commands/plugin.rs` 删除 `PLUGIN_ID_ADDON_EVERYTHING` 字面量分支；
- 权限：登记时要求清单含 `ai:tools`；native 执行前网关再验一次。

## 决策 4：权限下沉后端强制 + audit

- `plugin_invoke(plugin_id, method, args)`：先查清单 `methods[]` 白名单（manifest 增补可选字段），再查 method 所需权限注解，失败返回稳定错误码 `plugin.permission.denied`；
- Host API 的后端动作（connections.upsert 已有闸；overlay/selection 属前端总线，保留前端闸但记录 audit）；
- audit：新增 `plugin_audit` 表（ts, plugin_id, action, method, args_digest, result）；写入点为 invoke 网关与 require_permission 失败路径；args 只存摘要（query 前 64 字符类），不落密钥。

## 决策 5：包格式 `.omni-plugin` 三层结构

```
my-plugin.omni-plugin (zip)
├─ plugin.json          # 与现有 schema 相同 + 可选 "entry": { "logic": "logic.wasm", "ui": "ui/index.html" }
├─ assets/              # 图标等静态资源
├─ logic.wasm           # 可选，L2
└─ ui/                  # 可选，L3 沙箱页面（禁止网络默认策略）
signature.ed25519       # 对 zip 内容排序后的规范字节流签名
```

- 安装目录：`app_data/plugins/<plugin_id>/`；`plugin_list` 合并「编译期 first_party + 磁盘安装」两个来源；
- 卸载仅允许删磁盘来源；first_party 不可卸载只能禁用；
- 版本升级 = 覆盖安装，签名必须验证通过；签名公钥内置（首发只有官方 key，社区审核流程后续另立）。

## 决策 6：三级执行梯度

| 级 | 内容 | 执行环境 | 开放时点 |
|----|------|----------|----------|
| L1 | 表单/主题 token/菜单项/AI 工具元数据/discovery probe 声明 | 无代码，宿主解释执行 | **本期即可对第三方开放** |
| L2 | 业务逻辑（探测、映射、API 调用） | wasmtime 实例，host functions = `host.invoke/connection.upsert/net.fetch/fs.read`(按权限) ，缺权 trap | 本期打通样板 |
| L3 | 自定义 UI | 沙箱 iframe（独立 origin，CSP 默认拒外联）+ postMessage 桥（消息白名单=Host API 子集） | 本期打通桥 + 样板 |

- L2 host function 命名空间与 `PluginHost` TS 接口一一对应，保证「同一 SDK 合同」；
- L3 桥消息带 pluginId 与 nonce，宿主侧逐条过权限闸；
- prod 环境（env_tag=prod）：L2 net/ssh host functions 一律要求二次确认回调（复用 ExecutionEngine 策略），不可配置绕过。

## 决策 7：SDK 交付物

- `@omnipanel/plugin-sdk` / `@omnipanel/plugin-ui` 发 npm（版本随主版本号，manifest schema 带 `minHostApi` 字段做兼容检查）；
- `create-omnipanel-plugin` 脚手架：生成 L1 模板（表单+主题）与 L2 模板（Rust→wasm-build）；
- 文档：清单参考、权限模型、生命周期、调试指南（dev 模式下可从任意目录加载未签名包，仅 dev）。

## 核心闭环（必须通）

A. 单源：改某插件 manifest 的 panelTabs → 前端无需改码，Tab 随之变化。
B. activate：禁用 Everything → 其 activate 登记的 es provider/AI 工具消失 → 启用恢复（全程无 ID 特判）。
C. 安装：本地双击导入 .omni-plugin → 校验签名 → 设置页出现 → 启用 → L1 贡献生效 → 重启保持。
D. 越权：L2 包调 `net.fetch` 未声明 `net:connect` → trap + audit 记录 + 设置页显示拒绝原因。

## Risks / Trade-offs

[plugin_manifests 全量下发前端] → manifest 为公开声明数据，无敏感内容；体积可控（10 个 <10KB）。
[静态 import map 仍是编译期] → 加载器接口稳定，阶段 B 换磁盘/WASM 装载不动合同；诚实标注过渡态。
[wasmtime 引入体积] → 仅在存在 L2 包或 feature flag 下懒加载；官方构建可裁剪。
[audit 表膨胀] → 只记摘要 + 按天滚动清理。
[签名单 key] → 首发仅官方签名可装（dev 例外），多 key/社区审核后续提案。

## Migration Plan

1. `plugin_manifests` IPC + 前端 Catalog，替换五处手写 import（行为不变，纯重构）。
2. launcher/menus/importers/discovery/cloud tabs 泛化读取。
3. definePlugin + Runtime Loader；迁移 Everything、share addon 进 activate。
4. AI 工具泛化 + invoke 白名单/权限/audit。
5. 包格式 + 签名 + install/uninstall（dev 未签名开关）。
6. L1 第三方验收；wasmtime host functions + L2 样板；iframe 桥 + L3 样板。
7. SDK 发 npm + 脚手架 + 文档。

回滚：步骤 1–4 均为内部等价重构，feature flag `plugin_registry_v2` 可切回；步骤 5 起新能力独立命令，不影响存量。

## Open Questions

- L3 沙箱 iframe 的 origin 方案（独立 scheme vs data: vs 本地 http）待定，影响 Cookie/storage 隔离强度。
- `methods[]` 白名单放 manifest 顶层还是 per-tool 注解（倾向 per-method 注解，schema 向后兼容）。
- 主题包是否允许 CSS（当前仅 JSON token）——倾向 v1 维持 JSON-only。
