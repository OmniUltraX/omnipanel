## Why

市场解决了"插件摆在哪"，但没解决"谁来写"：第三方开发今天仍要切出去用外部编辑器 + 命令行跑脚本 + 手传文件投稿，链路断成三截。OmniPanel 里 Monaco、终端、AI、打包校验脚本全是现成的，把"写插件"收进工作台，供给侧才转得起来。

## 目标

- P1 插件工程面板：创建（模板）→ 编辑（Monaco）→ 校验/打包/本地安装一条龙 + 本机工具链检测引导。
- P2 一键投稿：打包件 + 清单自动填 issue 模板发到指定仓库（`plugin-submission` 标签），限流 + 确认框。
- P3 审核进 registry：GitHub Action 定时归档通过审核的 issue 为 registry v2 片段，与静态市场衔接。
- AI 脚手架：prompt 生成 manifest + main.js + overlay 页，降低门槛。

影响 Phase：插件平台（新增 `/plugins-studio` 或挂 `/settings` 下？定为独立路由 `/studio`，见设计）；PRD 工程驾驶舱定位。不碰执行器/L2/L3。

## 非目标（Non-goals）

- 不做通用 IDE（不断点调试器、不做多语言 LSP、不做 git 集成，编辑器只服务插件工程）。
- 不做中央开发者后台/审核队列 UI（审核就在 GitHub issues 里公开做）。
- 不绕过签名与权限确认：投稿包照样验签，发布 token 走 keyring + 确认框。
- 生产环境数据修改仍走 `env_tag=prod` 二次确认 + audit（本 change 不涉及生产数据）。

## 背景与动机

- 脚本层已齐：`create-plugin/validate-plugin/pack` 三件套 + 10 个 samples；缺的只是一个"壳"把它们串成不出工作台的闭环。
- `plugin-marketplace` 的 publish-flow  spec 只定义到"registry 片段"，投稿/审核的人味部分正好由本 change 补上，两者衔接点是 registry v2 片段格式。

## What Changes

- **P1 工程面板**：新模块 `modules/studio`（路由 `/studio`）：工程列表（`plugins-custom/` 扫描）→ Monaco 编辑（复用数据库模块的编辑器封装）→ 一键校验（调 `validate-plugin.mjs`）→ 一键打包（调 cargo pack，经 Tauri shell，需本机工具链）→ 一键本地安装（复用 `plugin_install_from_file` + 权限确认框）；环境检测页（cargo/node/wat2wasm 版本与缺失引导）。
- **AI 脚手架**："描述需求→生成骨架"按钮，经 `requestAiCompletionOnce`（纯文本补全）按模板 prompt 生成 `plugin.json/ui/main.js/ui/index.html` 三件套，写入工程目录，生成后自动跑校验。
- **P2 一键投稿**：工程页"投稿"按钮 → 生成投稿包（`.omni-plugin` + 清单摘要）→ 确认框（含目标仓库、标签、防灌水说明）→ 经 GitHub API 建 issue（token 存 keyring，只存 credential_ref）；限流（每工程每天 3 次）+ audit。
- **P3 Action 归档**：`.github/workflows/plugin-submissions.yml` 定时扫 `plugin-submission` 标签的 closed-as-completed issue，按约定格式（issue 正文 registry 片段代码块）合进 registry v2，签名由官方 key 在 Action secrets 里完成。
- **BREAKING**：无。全加法。

## Capabilities

### New Capabilities

- `plugin-workbench`: 工程面板（创建/编辑/校验/打包/安装/环境检测）。
- `plugin-ai-scaffold`: AI 生成插件骨架。
- `plugin-submit`: 一键投稿 GitHub issues。
- `registry-ingest`: Action 审核归档进 registry。

### Modified Capabilities

- 无（`openspec/specs/` 为空）。

## Impact

- 前端：新 `modules/studio`（路由 `/studio`、Monaco 复用、store/事件与其它模块解耦）、i18n 中英、IPC 新增（shell 执行脚本、投稿、keyring token 存取走现有 secrets 通道）。
- 后端：`commands/plugin_studio.rs`（跑脚本/环境检测/投稿 API 调用，薄桥接）+ `collect_commands!` 登记；密钥走 keyring。
- 仓库自动化：`.github/workflows/plugin-submissions.yml` + `docs/plugins/publishing.md` 投稿章节。
- 依赖：复用本机 cargo/node（不打包进应用）；GitHub API 经现有 `plugin_http`（reqwest）复用。

## 成功标准

- 从零点"新建"到本地装上可用的翻译级插件，全程不出 OmniPanel。
- 无 cargo/node 的机器打开面板时看到缺失引导而非报错。
- 投稿 issue 格式固定可机读；Action 能把一个审核通过的 issue 变成 registry 可安装条目。
- 投稿需二次确认 + audit；token 不落明文；`tsc -b` 零 error。
