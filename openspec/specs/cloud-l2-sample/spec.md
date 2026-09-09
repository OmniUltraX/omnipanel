# Cloud L2 Sample

## Purpose

仓库 SHALL 提供 `kind=cloud` 样板：清单声明至少一条 capability，`entry.logic` 为 JS，经 `plugin_invoke` 返回只读数据，云工作台通用槽能展示。MUST NOT 修改阿里云 / 腾讯云 crate 行为。

## Requirements

### Requirement: 一条 L2 云能力样板

仓库 SHALL 提供 `kind=cloud` 样板：清单声明至少一条 capability，`entry.logic` 为 JS，经 `plugin_invoke` 返回只读数据，云工作台通用槽能展示。MUST NOT 修改阿里云 / 腾讯云 crate 行为。

#### Scenario: 安装后可见能力

- **WHEN** 用户安装并启用该样板
- **THEN** 云工作台出现其声明的能力且能拉到 L2 返回的列表（可为 echo）

### Requirement: 无厂商 ID 特判

Host MUST 仅按清单 `capabilities` 登记槽，MUST NOT 硬编码样板 id。

#### Scenario: 禁用消失

- **WHEN** 用户禁用该样板
- **THEN** 对应能力从云工作台消失
