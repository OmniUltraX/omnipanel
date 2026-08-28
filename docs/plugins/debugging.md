# 调试指南

## Dev 快速通道

1. **未签名/开发签名包**：dev 构建（`cargo run` / `npm run tauri:dev`）接受
   `pack` CLI 产出的 dev 签名或完全未签名包；release 构建严格拒绝。
2. **本地目录迭代**：改 `plugins-custom/<name>/plugin.json` 后重新 pack，
   在设置页覆盖安装即可（同 id 覆盖升级，无需卸载重装）。

## 日志

| 来源 | 位置 |
|---|---|
| L2 实例化失败 | 主进程 stderr：`[plugin-logic] 实例化失败 <id>: …` |
| 逻辑包读取失败 | `[plugin-logic] 读取逻辑包失败 …` |
| 安装包清单非法跳过 | `[plugin-installed] 跳过非法包 …` |

## 常见错误与排查

### `UnknownMethod`
L2 调用的 method 未出现在清单 `methods[]`，或插件处于未激活状态。
→ 检查白名单声明；确认设置页该插件为启用且已激活。

### 「逻辑包未实例化」/「插件逻辑执行器未启用」
默认构建已开启 `plugin-js`。示例导入器（`importer-warpgate`）的 `logic.js` 嵌入二进制，启动时 `sync_plugin_logic` 装载，不必先安装到 `app_data/plugins/`。
→ 确认 `src-tauri` 的 default feature 含 `plugin-js`；看主进程 `[plugin-logic]` 日志。

### `缺少权限 <perm>`
能力调用超出 `permissions` 声明。
→ 补声明后重新打包安装（权限收紧方向无需用户确认，放宽需重装）。

### 「已拦截对生产环境目标的访问」
URL 主机命中某条 `env_tag=prod` 连接。弹窗 60s 未响应按拒绝处理。
→ 需要放行时在确认框点「本次放行」；审计可在 audit_log 表复查。

### 「fsRead 仅允许访问插件自身目录」
路径越界。fs 根 = `app_data/plugins/<plugin_id>/`。

### QuickJS「执行超时（10000ms 中断）」
单次 call 超 10s。拆分任务或在宿主侧分批调用；
中断阈值当前为构建期常量，不可运行时配置（防绕过）。

## 测试工具链

- 引擎级样例：`crates/omnipanel-plugin-wasm/tests/abi.rs`（wat 客体）、
  `crates/omnipanel-plugin-js/tests/behavior.rs`；
- L1 安装链路端到端：`crates/omnipanel-plugin-pkg/tests/l1_install_chain.rs`；
- 清单校验：`npm run check:plugin-manifests`（CI 同款）。

## AI 工具调试

启用插件后，模型工具清单应包含其 `ai.tools`；禁用即消失。
native 工具执行统一经 `(plugin_id, tool.name)` 网关——
未登记 handler 或无实例时返回 `UnknownMethod`，不会挂起会话。
