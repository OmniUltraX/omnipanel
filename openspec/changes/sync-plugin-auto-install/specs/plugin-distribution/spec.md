## MODIFIED Requirements

### Requirement: 安装升级卸载与权限确认

系统 SHALL 提供 `plugin_install_from_file/uninstall`（解压到 `app_data/plugins/<id>/`、覆盖即升级、内置拒卸）；设置页与本地选包安装流程 SHALL 含权限确认 step（展示 `permissions[] + methods[][name/permissions/dangerAction]`，中英 i18n），确认后才执行安装。由模块快照缺件触发的官方第一方 `download` 包与资源用到的 DBX 引擎允许跳过该确认 step，直接安装；非官方市场源仍 MUST 经用户确认。启用状态沿用 `plugin_settings` 持久化并经 `plugin://changed` 多窗同步。

#### Scenario: 权限确认后安装

- **WHEN** 用户选包后看到 net/vault 等权限并确认
- **THEN** 执行安装并出现“已安装”来源标签，可卸载

#### Scenario: 凭据不落明文

- **WHEN** 插件存取密钥
- **THEN** 经 keyring `plugin:{id}:{key}` 读写，库内无明文（复用现有语义）

#### Scenario: 同步缺件的官方包可静默安装

- **WHEN** 模块快照落地后 ensure 识别到未安装的官方 download 插件
- **THEN** 不打开设置页权限确认即可安装，随后 `plugin://changed` 通知前端
