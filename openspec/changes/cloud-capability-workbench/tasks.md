## 1. 合同与 Driver crate

- [x] 1.1 新增 `crates/omnipanel-cloud-aliyun`（或先在 `omnipanel-plugin` 旁加 `cloud_driver` 模块）定义 `CloudProviderDriver`、`CloudResourceRow`、`CloudResourceFilter`、`CloudRegion`（`capabilities: Vec<String>`）、`CloudAction`（`crates/`、`Cargo.toml` workspace）。验证：`cargo test` 空实现/映射单测编译通过
- [x] 1.2 实现 `pluginId` → Driver 注册表；未知 id 返回明确 `OmniError`（同 crate 或 `omnipanel-server`）。验证：单测「无 Driver 失败、不回落阿里云」
- [x] 1.3 将现有 ECS/SWAS/OSS/域名/证书/地域列表函数适配为 `listResources` / `listRegions` 映射（可暂留原文件，由 adapter 调用）（`crates/omnipanel-server/src/cloud/`）。验证：映射单测覆盖 compute ↔ ECS、compute.lite ↔ SWAS

## 2. 阿里云插件边界

- [x] 2.1 把 HMAC 客户端从 `src-tauri/src/commands/cloud/aliyun.rs` 与 server 副本收拢到 `omnipanel-cloud-aliyun`，桌面与 server 只依赖该 crate（`src-tauri/`、`crates/omnipanel-server/`）。验证：`cargo check -p omnipanel-app`；工程内无第二份完整签名实现
- [x] 2.2 `InvokeGateway` 编译期登记 `omni.cloud.aliyun` 的 `testAccount` / `listRegions` / `listResources` / `getResource` / `invokeAction`（`src-tauri/src/commands/plugin.rs`）。验证：未声明 method 仍失败
- [x] 2.3 实现计算类 `start`/`stop`/`reboot` 与 `getResource` 最小详情字段（规格、IP、镜像/套餐）（`omnipanel-cloud-aliyun`）。验证：单元测试用夹具 JSON 映射；无密钥入日志
- [x] 2.4 更新 `plugins/cloud-aliyun/plugin.json`：`connectionForm`、`contributes.cloud.capabilities[]`、`methods[]`；删除作为 Host 类型的 `ecs` Tab 合同（`plugins/cloud-aliyun/`）。验证：`check-plugin-manifests` / CI 清单校验通过

## 3. Tauri 泛化命令

- [x] 3.1 新增 specta 命令 `cloud_list_resources` / `cloud_get_resource` / `cloud_invoke_action`（保留或改写 `cloud_test`、`cloud_list_regions`）；commands 层解 Vault、查 pluginId、prod 闸后再 invoke（`src-tauri/src/commands/cloud/`）。验证：`npm run gen:bindings`；bindings 含新命令且 `Result<_, OmniError>`
- [x] 3.2 `cloud_invoke_action`：`env_tag=prod` 写操作必须确认失败则不打 API；audit 记 pluginId+action（`src-tauri/`、既有 audit）。验证：单测或注释+手动清单；密钥不入 audit
- [x] 3.3 产品级 `cloud_list_ecs` 等改为内部转发 `listResources` 或标记删除；本迭代结束前从前端主路径移除（`src-tauri/src/lib.rs`）。验证：grep 前端无 `cloudListEcs` 业务调用

## 4. 前端合同与门控

- [x] 4.1 `packages/plugin-sdk` + `pluginManifests` 解析 cloud capabilities / connectionForm；`resolveLegacyPluginId("aliyun")` 保留（`packages/plugin-sdk/`、`frontend/src/lib/pluginManifests.ts`）。验证：vitest 清单解析
- [x] 4.2 `cloudCapabilities.ts` 按激活插件 + 清单生成能力列表；禁用则空（`frontend/src/modules/cloud/`）。验证：vitest 模拟未激活
- [x] 4.3 打开 `CloudProvider` 为 string；`connectionToCloudAccount` 读 pluginId（`frontend/src/modules/cloud/` 迁入的 form 模块）。验证：`cd frontend && npx tsc -b`；文案 i18n

## 5. 工作台树与筛选

- [x] 5.1 侧栏改为账户 → 能力 → 实例；能力展开懒加载 `cloudListResources`；节点展示地域标签（`frontend/src/modules/cloud/`）。验证：手动：两账户分根；未展开不打全量列表
- [x] 5.2 地域多选筛选同时过滤树与列表；global 能力隐藏地域条；状态筛选可选（`frontend/src/modules/cloud/`）。验证：只选杭州时树与列表一致；证书无地域条
- [x] 5.3 DNS：若未声明则无节点；声明时实例为托管区（阿里云本期可不声明）（`frontend/src/modules/cloud/`）。验证：树无解析记录层

## 6. Dock：概览 / 列表 / 详情

- [x] 6.1 Dock Tab 模型：`account` | `resources` | `resource`；单击预览、双击常驻；对齐数据库交互（`frontend/src/modules/cloud/`，复用 ModuleSegmentDock）。验证：可同时开 compute 与 objectStorage 两个列表 Tab
- [x] 6.2 账户概览：测连、能力入口/数量、关联 SSH/文件（`frontend/src/modules/cloud/`）。验证：点账户不再进入旧「地域×五 Tab」主路径；i18n
- [x] 6.3 资源列表：`DbTablesPanelGrid` + 清单列；单击 inspector、双击详情（`frontend/src/modules/cloud/`）。验证：ECS/OSS 列来自能力声明而非 `switch(ecs)`
- [x] 6.4 计算/OSS/域名/证书详情壳 + `cloudGetResource`；控制台外链（`frontend/src/modules/cloud/`）。验证：双击实例打开详情；无图表也可验收字段与动作

## 7. 动作与跨模块

- [x] 7.1 `addSsh` / `addToFiles` 迁到 `modules/cloud`，`remoteKind` 用能力 id；兼容读旧 `ecs`/`swas`/`oss` 血缘（`frontend/src/modules/cloud/`）。验证：二次加入不重复；不从 cloud 深引 server 面板页
- [x] 7.2 列表/详情开停重启按钮走 `cloudInvokeAction`；未声明不渲染；prod 走 `appConfirm`（`frontend/src/modules/cloud/`）。验证：手动非 prod 停机；prod 取消不发请求
- [x] 7.3 加账户对话框：激活 cloud 插件芯片网格 + connectionForm；无插件空态（`frontend/src/modules/cloud/`）。验证：禁用阿里云后芯片消失；i18n；不跨 module import

## 8. 清理与门禁

- [x] 8.1 删除或掏空 `frontend/src/modules/server/cloud` 旧树/内 Tab；`CloudPanel` 只留新工作台（`frontend/src/modules/cloud/`、`server/cloud/`）。验证：`tsc -b`；grep 无 `CLOUD_RESOURCE_TABS` 主路径
- [x] 8.2 vitest：能力解析、地域筛选、血缘别名、树 key（`frontend/src/modules/cloud/*.test.ts`）。验证：vitest 相关文件通过
- [ ] 8.3 手动验收：旧阿里云账户仍能列出；加入 SSH/文件；禁用插件门控；prod 停机确认。验证：按 spec 场景勾选
