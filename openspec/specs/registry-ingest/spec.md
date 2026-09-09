# Registry Ingest

## Purpose

`.github/workflows/plugin-submissions.yml` SHALL 定时扫描 `plugin-submission` 标签且 closed-as-completed 的 issue，按正文 registry 片段校验（schema + 危险权限如 `ssh:exec` 标记人工复核）→ 合进 registry v2 → 官方 key 签名（Action secrets）→ 提 PR（不直接 push）。

## Requirements

### Requirement: Action 审核归档

`.github/workflows/plugin-submissions.yml` SHALL 定时扫描 `plugin-submission` 标签且 closed-as-completed 的 issue，按正文 registry 片段校验（schema + 危险权限如 `ssh:exec` 标记人工复核）→ 合进 registry v2 → 官方 key 签名（Action secrets）→ 提 PR（不直接 push）。

#### Scenario: 审核通过进 registry

- **WHEN** 维护者 close 一个合格投稿 issue
- **THEN** 下次 Action 运行产出含该插件的 registry PR，合入后客户端可安装
