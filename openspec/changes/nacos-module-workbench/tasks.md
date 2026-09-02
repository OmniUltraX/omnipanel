## 1. 能力合同与 SDK

- [x] 1.1 `packages/plugin-sdk` 增补 `contributes.module.capabilities[]`（id、columns、actions）；Rust manifest 同步（`packages/plugin-sdk/`、`crates/omnipanel-plugin/`）。验证：`npm run check:plugin-manifests`；非法 id 或重复失败
- [x] 1.2 Nacos 清单改为完整 module 包合同：`connectionForm`、四种 capability、`methods[]`+dangerAction、`entry.logic`、discovery/launcher/ai.tools（`plugins/module-nacos/plugin.json`）。验证：清单 CI 通过

## 2. Module Host（零产品名）

- [x] 2.1 `PluginModuleHost` 升级为 `ModuleWorkspaceLayout` + `kind=service` 树（按 pluginId 过滤）+ 标签（`frontend/src/modules/plugin-module/`）。验证：vitest 过滤；无 `moduleKey==="nacos"` 渲染分支
- [x] 2.2 按 `contributes.module.capabilities` 画树节点与 Dock；未知能力空态（`frontend/src/modules/plugin-module/`）。验证：只声明 config 时无服务节点；`tsc -b`
- [x] 2.3 声明式 service 连接对话框 + Vault；测试连接走 `plugin_invoke("testConnection")`（`frontend/src/modules/plugin-module/`）。验证：config 无密码；i18n

## 3. 模板与安装闭环

- [x] 3.1 `scripts/create-plugin.mjs` 支持 `module`：生成清单 + `logic.js` 桩 + README 到 `plugins-custom/`。验证：生成物 pack 成功
- [x] 3.2 增加 `plugins-samples/module-starter`（独立 id，非 `omni.module.nacos`）（`plugins-samples/module-starter/`）。验证：安装启用后侧栏出现；卸载后入口消失、连接仍在
- [x] 3.3 CI 或文档步骤：`pack plugins/module-nacos` 与 starter 均能产出合法包（`omnipanel-plugin-pkg`）。验证：验签通过；与内置同 id 安装被拒

## 4. Nacos L2 狗粮

- [x] 4.1 `plugins/module-nacos/logic.js`：探测、login/token、`testConnection`/`getServerInfo`；1.x 无认证与 2.x 账密；未知版本拒写（`plugins/module-nacos/`）。验证：夹具或 vitest/node 单测；无密钥入返回
- [x] 4.2 实现 namespace + config 列表/读写/发布/历史/回滚/删除（`plugins/module-nacos/logic.js`）。验证：对照夹具；日志无全文
- [x] 4.3 实现 `listServices`/`listInstances`/`updateInstance`/`listNodes`（`plugins/module-nacos/logic.js`）。验证：节点失败返回空不抛
- [x] 4.4 内置嵌入同一份 `logic.js`（`first_party_logic_bytes` 或现有 L2 装载路径）（`crates/omnipanel-plugin/`）。验证：不装磁盘包时启用内置仍能 invoke；`cargo test` 相关通过
- [x] 4.5 Host `config`/`namespace` 插槽接上编辑器与 prod/step-up（`frontend/src/modules/plugin-module/`，复用文本编辑器）。验证：手动发布；prod 取消不发网
- [x] 4.6 Host `discovery`/`cluster` 插槽 + 无认证 prod 警告（`frontend/src/modules/plugin-module/`）。验证：改权重确认；节点挂掉仍能开配置

## 5. 扫描与 AI

- [x] 5.1 Nacos 扫描：声明 ports/健康 path + claims；接入 `discoveryBus`/`ImportPreview`（`plugins/module-nacos/`、Host 发现入口）。验证：8848 可导入；再扫去重；prod 主机不偷偷探
- [x] 5.2 `nacos` 启动器 + 四只只读 AI 工具走 L2；无写工具（`plugins/module-nacos/plugin.json`）。验证：禁用后前缀与工具消失

## 6. 门禁

- [x] 6.1 i18n 中英（壳、表单、能力名、错误）（`frontend/src/i18n/zh-CN.ts`、`en-US.ts`）。验证：无硬编码用户串
- [x] 6.2 `cd frontend && npx tsc -b`；相关 vitest；清单 CI；grep 无 `omnipanel-nacos` crate、无 Host 内 nacos 工作台特判
- [ ] 6.3 手动：starter 安装卸；内置 Nacos 1.x/2.x 发布回滚；pack 狗粮包；禁用后数据仍在
