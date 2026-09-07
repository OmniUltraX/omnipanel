## 1. 工程面板 P1（后端 → 前端）

- [x] 1.1 受控脚本桥：`src-tauri/src/commands/plugin_studio.rs`（list/read/write 限 `plugins-custom/` + `dedot` 禁锢；run 仅 validate/pack/scaffold，日志回显，600s 超时）+ `collect_commands!` 双处登记 + bindings 生成。验证：越界读写单测拒绝；`cargo check -p omnipanel-app` 通过
- [x] 1.2 Studio 模块：`frontend/src/modules/studio/`（路由 `/studio`、CodeEditor 复用公共层并补 js/html 高亮、运行日志、环境检测、打包后 peek 权限 inline 确认安装、插件中心入口按钮），无跨模块 store 依赖，文案走 i18n 中英，不跨 module import。验证：`tsc -b` 零 error；手动从零建工程到装上（待你验收）
- [x] 1.3 AI 脚手架：studio 内经 `requestAiCompletionOnce` 按定版模板生成三件套 → 落盘 → 自动校验（围栏解析单测通过；端到端待有模型时验收；audit 落 `plugin.ai_scaffold` 待补）

## 2. 一键投稿 P2

- [ ] 2.1 投稿命令：`plugin_submit_issue`（读工程组装固定模板 → GitHub API 建 issue + `plugin-submission` 标签；token 经 `plugin_secret_*` 通道 `studio:github-token`；24h 限 3 次/工程；audit）。验证：token 不落盘单测；超限单测
- [ ] 2.2 投稿确认框：目标仓库/正文预览/防灌水说明，`WorkbenchPanelHeader/WorkbenchActionButton`，i18n。验证：vitest；手动投稿到测试仓库

## 3. 归档 Action P3

- [ ] 3.1 `.github/workflows/plugin-submissions.yml`（cron+手动：扫标签 issue → 校验片段 → 合 registry v2 → secrets 签名 → 提 PR）+ `docs/plugins/publishing.md` 投稿章节。验证：dry-run 或测试仓库真实跑通一次

## 4. 回归

- [ ] 4.1 全量门禁：`tsc -b` 零 error；相关 cargo/vitest 通过；`check-plugin-manifests` 全绿；插件中心现有流程不回退
