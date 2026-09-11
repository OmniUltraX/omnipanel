## ADDED Requirements

### Requirement: staging 与 swap 原子安装

安装 SHALL 解压到 staging → 验签/解析 → 预检 → rename swap（旧版移 last-good）；任一步失败 SHALL 恢复 last-good 并记 `plugin.rollback` audit；成功后清理 staging。

#### Scenario: 更新失败回滚

- **WHEN** 新版包验签通过但启用预检失败
- **THEN** 自动恢复上一版可用，UI 提示回滚且 audit 可查

#### Scenario: 崩溃残留自愈

- **WHEN** 启动时发现 staging 残留
- **THEN** 清理残留，不影响已安装版本
