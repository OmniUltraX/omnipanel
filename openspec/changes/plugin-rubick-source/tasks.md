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

## 5. 市场反馈迭代（用户验收反馈）

- [x] 5.1 analyzer 放宽：无 features 但有主入口可转 overlay-only（`crates/omnipanel-plugin-pkg/src/external.rs`）。验证：新增单测通过
- [x] 5.2 第三方过滤按来源直列（`MarketFilter` 开放来源 id，chips 由 `sourceFilters` 驱动）。验证：vitest + `tsc -b`
- [x] 5.3 市场 npm 搜索全量展示（`pluginExternalSearchNpm` 接入市场列表，id 与后端 sanitize 对齐）。验证：vitest（`sanitizeExternalId` 同构用例）+ `tsc -b`
- [x] 5.4 external-only 对话框可操作（复制包名按钮）。验证：`tsc -b`

## 6. 全量与分类（第二轮反馈）

- [x] 6.1 市场打开自动拉全量（默认 `rubick` 查询 50 条静默合并，手动搜索保留）。验证：`tsc -b`
- [x] 6.2 Rubick 分类行（启发式 5 类 + 其他，种子与 npm 结果统一打标，来源筛选内生效）。验证：vitest 分类表用例 + `tsc -b`
- [x] 6.3 gitcode 索引通道下线（文件 API 需鉴权、raw 为 SPA 壳，实测不可达；删命令保 npm+种子双通道）。验证：`cargo check` 无残留引用
- [x] 6.4 `ExternalSearchItem.keywords` 透传（分类用）。验证：`tsc -b`

## 7. 转换可用性（ip-config 反馈：误判 runnable 装后 0.0.0.0）

- [x] 7.1 analyzer 收紧：任意非相对 `require(` 即需 Node；`rubick.*` 显式拒绝并点名。验证：`cargo test -p omnipanel-plugin-pkg external`（含 ip-config 形状回归）
- [x] 7.2 页内 fetch 不判死：`needs_network` → converter 自动声明 `net:connect`。验证：同上单测
- [x] 7.3 prelude fetch 透明代理到受闸桥（成功只给文本兼容壳，非 2xx 走 reject）。验证：`PluginSandboxFrame.test.ts` + `tsc -b`

## 8. 适配安装（“为什么不该装”反馈：需求可映射，不应判死）

- [x] 8.1 桥：`plugin_sandbox_local_ips`（UDP 技巧本地判定，仅要求插件已注册）+ `clipboard.write`（主窗剪贴板，只写+审计）。验证：`cargo check`，真机经桥验证待 dev 重启
- [x] 8.2 prelude 暴露 `clipboardWrite` / `networkGetLocalIps`（白名单免权限，读剪贴永不开放）。验证：`PluginSandboxFrame.test.ts` + `tsc -b`
- [x] 8.3 compat 垫片机制：`entry.compat`（SDK/Rust/CI 三端校验）+ overlay 紧随 prelude 注入 + ip-tools-v1 参考垫片。验证：单测 + `tsc -b`
- [x] 8.4 analyzer 垫片识别 + converter 合成（含 preload 丢弃、net 权限、清单校验）。验证：`cargo test -p omnipanel-plugin-pkg`（ip-config 可转+垫片+权限）

## 9. 转换插件联网与内部地址防护（ip-config 真机报错）

- [x] 9.1 垫片 provider 链修正（forge 404 下线，主用 ip-api 明文 + 中文地址，ip.sb/ipinfo 回退；locationInfo 加回退）。验证：节点直测三端点 200
- [x] 9.2 fetch 代理拒绝宿主内部地址（ipc/tauri/asset.localhost）与非 http(s)，防 Tauri 自身传输被转发。验证：PluginSandboxFrame.test.ts + 	sc -b
