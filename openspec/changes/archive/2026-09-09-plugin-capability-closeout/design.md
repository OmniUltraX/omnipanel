## Context

市场 / 投稿 / 原子安装 / AI Dock 已落地。本 change 不新开平台，只把上次调研留下的 8 条薄点按批次做完。

约束：commands 只桥接；IPC 走 specta `gen:bindings`；前端模块不互 import；工作台按钮用 `WorkbenchPanelHeader` / `WorkbenchActionButton`；凭据只走 keyring；`env_tag=prod` 不可绕过。

## Goals / Non-Goals

**Goals:**

- 发行版能写插件（用户数据目录工程根）。
- `kind=theme` 启用即换肤（UI 变量 + 终端色板）。
- 第三方 panel / cloud 各有一条可仿的清单 + L2 样板。
- Overlay / prod 闸 / 官方目录策略有可勾验收。
- 沙箱边界冻结；SDK 可 pack；AI 脚手架有审计。

**Non-Goals:**

- 第八种 kind、LSP、Git、iframe 应用框架。
- 重写 1Panel / 宝塔 / 阿里云 / 腾讯云。
- Warpgate WASM、launcher 硬编码尾巴（另账）。

## Decisions

### D1 工程根 = `app_data/plugin-projects/`，开发态并集扫描

```
发行版:  app_data/plugin-projects/<name>/
开发态:  同上 ∪ 仓库 plugins-custom/<name>/   （新建一律写用户目录）
禁锢:    工程名无 .. / 分隔符；读写 jail 在该工程目录
```

- crate / 逻辑：路径解析放 `commands/plugin_studio.rs`（已有 jail）；`repo_root()` 仅作开发态并集，不再当唯一根。
- 新建：`plugin_studio_create` 写 `app_data_dir()/plugin-projects/`。
- `StudioProject` 增 `location: "user" | "repo"`（specta 生成 bindings）。
- 备选（继续只认源码树）否决：发行版永远空。
- 备选（打包整棵 `plugins-custom` 进安装包）否决：体积与可写冲突。

**校验 / 打包不依赖仓库脚本：**

- validate：Rust 清单校验（已有 `omnipanel-plugin` + peek）+ 前端已有校验输出通道。
- pack：命令内调 `omnipanel-plugin-pkg`（已在 app 依赖里），不 `cargo run`。
- Node / wat2wasm 仍只服务 WASM 配方；缺失则该配方置灰（现有环境探测）。

`omni_studio_*` 工具改扫用户目录（开发态并集），描述去掉「仅源码运行」。

### D2 主题：一份 tokens.json，启用即应用，不新 Host

- 清单 `contributes.themes.tokens` 指向相对路径（默认 `tokens.json`），经 `plugin_read_asset` 读取。
- 前端唯一应用点：小 store（或现有 appearance）把 CSS 变量写到 `:root`；`terminalTheme.ts` 改为读该 store，去掉对 `plugins/theme-default/tokens.json` 的静态 import。
- 同时启用多个 theme：取**最近启用**的一个；全部关掉则回落到内置 default 的打包 tokens（作 fallback，不走插件 ID 特判列表）。
- 备选（用户在设置里另选主题配置）本期不做，启用开关即选择。

### D3 面板：未知 tab 走通用壳，第一方旧 tab 不动

- `panelPlugin.ts` 已有 `panelTabs` 读取。已知 tab id（overview/websites/…）仍渲染现有 React 页。
- **未登记 id** → 复用 module 的 `GenericCapabilityPane` 模式（表单 + `plugin_invoke`），按清单 `formFields` / `methods`。
- 样板 `plugins-samples/panel-starter`：一个自定义 tab + echo 方法。Host **禁止**按样板 id 特判。
- 不把 1Panel 全部页签改成清单驱动。

### D4 云：一条 L2 能力样板，crate 不动

- `plugins-samples/cloud-l2-starter`：`kind=cloud`，一条 capability，`logic.js` 返回只读列表。
- 走现有云工作台能力槽（与 Nacos/云 Host 同一套「清单 → 通用壳」）。
- 阿里云 / 腾讯云方法继续原生 crate。

### D5 验收是合同不是新功能

Overlay / `TauriProdConfirmer` / `verify_registry_allow_unsigned` 已有代码。本批次只补：失败可观测（audit / 控制台）、tasks 手测步骤、发现的 bug 修到能勾。

官方源：目录允许未签；`.omni-plugin` release 仍拒未签。

### D6 沙箱冻结，不升 iframe

`pluginRuntimeLoader` 的 `Function` 求值保留。补：非法 `activate` 形状、越权 host 调用、超 512KB 拒绝的 vitest。`docs/plugins/README.md` 加一小节边界。不引入 blob `import()`。

### D7 SDK：CI pack 即本 change 完成线

`packages/plugin-sdk` 已有 `sdk-release.md`。加 CI `npm pack --dry-run`（或仓库已有 job 则对上）。`npm publish` 等账号，不阻塞归档。

### D8 AI 脚手架审计

「按描述生成」已走 Dock + `omni_studio_write_file`。在**用户确认生成意图**时（点按钮，不是每次 tool call）记 `plugin.ai_scaffold`：prompt 的 sha256+len，不落原文。更新 `plugin-ide` 规格叙事：删除 oneshot 主路径（本 change 的 `studio-ai-audit` spec 为准）。

联动：Studio ↔ AI Dock（已有 snapshot）；主题 ↔ 终端色板；面板/云 ↔ `plugin_invoke`；市场安装样板包。

```
发行版用户
  工作台 ──jail──▶ app_data/plugin-projects
  打包 ──pkg crate──▶ .omni-plugin ──原子安装──▶ app_data/plugins
  启用 theme ──read_asset tokens──▶ :root + 终端
  启用 panel/cloud 样板 ──清单槽──▶ 通用壳 + invoke
```

## Risks / Trade-offs

- [Risk] 开发者本机出现两套工程目录 → Mitigation：列表标注 `user`/`repo`；新建只写 user；文案说明。
- [Risk] 发行版无 Node，旧「调 node 脚本」失败 → Mitigation：pack/validate 走 Rust；WASM 配方仍要 wat2wasm。
- [Risk] 多 theme 冲突 → Mitigation：单活策略（最近启用）。
- [Risk] 通用面板壳能力弱 → Mitigation：明确只覆盖声明式表单 + invoke；复杂页仍第一方。
- [Trade-off] 云样板是 echo 不是真厂商 → 这是仿写对象，不是产品云。
- [Trade-off] SDK 未真正 publish 也可归档 → 账号不是代码问题。

## Migration Plan

- 无数据迁移。已有 `plugins-custom` 工程开发态仍能打开。
- 回滚：还原 `repo_root` 唯一路径即回到「仅源码」。
- 主题失败（tokens 非法）→ 忽略该插件并回落 default，不崩 UI。

## Open Questions

- 无。账号未定则 SDK 以 CI pack 为完成；真 publish 不进本 change 阻塞。
