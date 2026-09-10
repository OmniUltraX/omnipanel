## 1. 后端 crate（registry + analyzer）

- [x] 1.1 `RegistryArtifact` 增补可选 `integrity`（`crates/omnipanel-plugin-pkg/src/registry.rs`），校验优先级 integrity > sha256。验证：`cargo test -p omnipanel-plugin-pkg` 新增用例通过
- [x] 1.2 analyzer 新模块（`crates/omnipanel-plugin-pkg/src/external.rs`）：形状校验 + preload 黑白名单扫描 + verdict（含缓存）。验证：fixtures（pure-web/Node 强依赖/未知 API 三包）单测通过
- [x] 1.3 converter：features/cmds → 清单映射 + 最小 `ui/main.js` 模板 + 标准包打包（`crates/omnipanel-plugin-pkg`）。验证：fixtures 转出包可过 `validate-plugin`

## 2. Tauri commands 桥接

- [x] 2.1 新增 `plugin_external_analyze` / `plugin_external_convert`（`src-tauri/src/commands/marketplace.rs` 或新文件），双清单注册 + `gen:bindings`。验证：`npx tsc -b` 通过，bindings 含新命令
- [x] 2.2 `rubick` 源适配：curated 种子文件 + 合并视图来源标记 + 取包审计（`src-tauri/src/commands/marketplace.rs`）。验证：`cargo test -p omnipanel-app marketplace` 通过

## 3. 前端市场 UI

- [x] 3.1 来源筛选 + 第三方 badge（`frontend/src/modules/plugins/`，复用 chip/row 样式与 `originMetaLabel`）。验证：vitest 新增用例；文案走 i18n 中英同次
- [x] 3.2 分级安装按钮 + compat 报告 inline（runnable 一键转换安装 / external-only 外跳）。验证：vitest + 手动走查；IPC 只走 `commands.*`

## 4. 文档与门禁

- [x] 4.1 新增 `docs/plugins/rubick-source.md`（源协议、verdict 规则、白名单清单）。验证：与实现一致
- [x] 4.2 全量门禁：`tsc -b` / `cargo test -p omnipanel-plugin -p omnipanel-plugin-pkg` / 相关 vitest / `check:plugin-manifests` 全绿
  - 注：`check:ipc-registry` 在干净树即失败（generate_handler 多 61 个预存命令），非本变更引入；本变更 3 个新命令双清单一致。真机端到端（real npm analyze/convert）待 dev 重启后经 dev-mcp 桥验证。
