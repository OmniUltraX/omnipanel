## ADDED Requirements

### Requirement: 一键投稿 issues

工程页 SHALL 提供投稿按钮：生成投稿包 → 确认框（目标仓库、正文预览、防灌水说明）→ 经 GitHub API 建 issue（标题 `[plugin-submission] <id> <version>`，正文 registry v2 片段代码块 + 权限清单，标签 `plugin-submission`）；每工程每 24h SHALL 至多 3 次。

#### Scenario: 投稿成功

- **WHEN** 用户确认投稿且未超限
- **THEN** issue 建好并返回链接，audit 可查

#### Scenario: 超限拒绝

- **WHEN** 24h 内第 4 次投稿
- **THEN** 拒绝并提示剩余等待时间，不发请求

### Requirement: 凭据不落明文

GitHub token SHALL 只存 keyring（命名空间 `studio:github-token`），库内只存 credential_ref；API 调用在 Rust 侧组装，token 不经过前端内存。

#### Scenario: token 不落盘

- **WHEN** 保存投稿 token
- **THEN** 磁盘库内无明文，重启后仍可用
