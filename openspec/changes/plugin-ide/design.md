## Context

现状：脚本层已齐（`create-plugin/validate-plugin/pack` + 10 samples），Monaco 编辑器在数据库模块已封装，`requestAiCompletionOnce` 可做 AI 生成，`plugin_install_from_file` + 权限确认框可做一键安装。缺：串起来的壳、本机工具链调用通道、投稿与归档。约束：commands 薄桥接、模块不互 import、specta 生成 bindings、token 只存 keyring。

## Goals / Non-Goals

**Goals:**

- `/studio` 工程面板：不出工作台完成创建→编辑→校验→打包→安装。
- AI 脚手架：描述→骨架三件套→自动校验。
- 一键投稿 + Action 归档，supply 闭环。

**Non-Goals:**

- 通用 IDE 能力（调试器/LSP/git）；只服务插件工程。
- 中央开发者后台；审核在 issues 公开做。

## Decisions

### D1 新模块 `modules/studio`，路由 `/studio`，Monaco 复用不自建

- frontend 边界：`modules/studio/`（工程列表/编辑器/运行日志/环境页）+ 独立 store；编辑器复用数据库模块的 Monaco 封装（经公共 `components/ui` 导出，若无则先抽一层——不直接 import database 模块）。
- 工程目录约定 `plugins-custom/`（已有 gitignore + 脚手架目标一致）。
- 备选（VS Code 式全功能编辑器）否决：scope 炸，插件工程文件少（3-5 个），单文件编辑 + 目录列表够用。

```
StudioPanel
 ├─ 工程列表 ← plugin_studio_list_projects (扫 plugins-custom/)
 ├─ Monaco 编辑 ← plugin_studio_{read,write}_file (禁 .. 路径禁锢)
 ├─ 运行按钮 → plugin_studio_run_{validate,pack} (本机子进程，日志流回显)
 ├─ 安装按钮 → pluginInstallFromFile 复用（含权限确认框）
 └─ 环境页 ← plugin_studio_env_check (cargo/node/wat2wasm --version)
```

### D2 本机脚本调用走受控子进程白名单，不开放任意 shell

- commands 边界：`plugin_studio.rs` 只允许跑三条固定命令（`node validate-plugin.mjs <dir>`、`cargo pack ...`、版本探测），参数做路径禁锢（`plugins-custom/` 内 + `dedot`），stdout/stderr 流式回事件，前端展示运行日志。
- 备选（开放终端执行任意命令）否决：等同给插件开 shell，安全模型崩。
- 联动：终端模块的 portable-pty 不复用（要的是 captive 跑脚本，不是交互 shell）。

### D3 AI 脚手架用现有 oneshot 补全，模板 prompt 定版

- frontend 边界：studio 内调用 `requestAiCompletionOnce`，system prompt 定版（含三件套格式约束 + 允许的 kind/权限白名单），返回解析为三文件写入工程目录，写完自动跑校验，失败把错误贴回日志。
- 生成物归属用户编辑，AI 只做初稿；audit 记 `plugin.ai_scaffold`（提示词摘要，不落原文）。

### D4 投稿走 GitHub API，token 进 keyring，issue 格式机读

- commands 边界：`plugin_submit_issue`（读工程 → 服务端组装标题/正文 → reqwest POST）；token 经 `plugin_secret_*` 通道（命名空间 `studio:github-token`），库内只存 credential_ref。
- issue 模板固定：标题 `[plugin-submission] <id> <version>`，正文含 registry v2 片段代码块 + 权限清单 + 标签 `plugin-submission`；前端确认框展示目标仓库与正文预览。
- 限流：每工程每 24h 最多 3 次（store 记时间戳），超限可读错误。
- 备选（OAuth App）否决：PAT 够用，OAuth 是重型流程，远期再说。

### D5 Action 归档只认约定格式，签名在 Action secrets 里做

- 仓库自动化：`.github/workflows/plugin-submissions.yml`（cron + 手动触发）：扫 `plugin-submission` 标签且 closed-as-completed 的 issue → 解析正文 registry 片段 → 校验（schema + 允许 kind/权限黑名单如 `ssh:exec` 需人工复核标记）→ 合进 registry v2 → 官方 key 签名（secrets）→ 提 PR（不直接 push，留人工合并键）。
- 与 marketplace 衔接点：registry v2 片段格式（publish-flow spec），Action 只做"搬运+签名"，版本解决/依赖由客户端做。

## Risks / Trade-offs

- [Risk] 本机无 cargo/node → 打包按钮全灭 → Mitigation：环境页先行检测，缺失给安装引导链接，按钮置灰并说明原因，不静默失败。
- [Risk] AI 生成恶意/越权清单（如要 `ssh:exec`）→ Mitigation：生成后强制跑校验 + 权限清单高亮展示由用户确认；投稿前二次确认。
- [Risk] 投稿灌水 → Mitigation：限流 + 确认框 + issue 模板固定；仓库侧可关 Action。
- [Risk] PAT 泄露 → Mitigation：只存 keyring；API 调用在 Rust 侧组装，token 不经过前端内存。
- [Trade-off] P1 不做断点调试：定位问题靠校验错误 + 安装后 `[plugin-runtime]` 日志 + audit，够样板级开发。

## Migration Plan

1. P1 先行：studio 模块 + 三条脚本桥 + 环境页，不碰投稿。
2. P2 投稿：secret 通道 + submit 命令 + 确认框 + 限流。
3. P3 Action：workflow + publishing 文档投稿章节；registry 侧无缝接入（v2 片段已定）。
4. 回滚：studio 是独立路由/模块，整体 revert 不影响插件中心；Action 可随时禁用。

## Open Questions

- 投稿目标仓库默认是官方仓库还是可配？（倾向可配，默认官方，待定）
- PAT 权限最小集（public_repo 读写 issue 即可，文档写死）。
- AI 脚手架 prompt 模板放前端常量还是随 SDK 发版？（倾向前端常量先行）
