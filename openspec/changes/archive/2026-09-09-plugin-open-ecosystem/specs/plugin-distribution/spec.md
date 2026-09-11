## ADDED Requirements

### Requirement: 包格式与验签

`.omni-plugin`（zip）SHALL 含 `plugin.json` + `assets/*` + 可选 `logic.(js|wasm)` + 可选 `ui/(main.js|index.html)`；签名文件 `signature.ed25519` 对规范字节流验签，多公钥（dev key 保留 + 正式 key 注入）任一通过即放行；release 下未签名 SHALL 拒（`UnsignedRejected`），dev 允许未签名但错签名仍拒。篡改任一字节 SHALL 验签失败。

#### Scenario: 篡改拒绝

- **WHEN** 包内任一字节被改后安装
- **THEN** 安装拒绝并报 `BadSignature`

#### Scenario: 兼容拒绝与冲突保护

- **WHEN** `minHostApi > HOST_API_VERSION` 或 id 与内置插件冲突
- **THEN** 拒绝装载并给出可读原因，不覆盖内置插件

### Requirement: 安装升级卸载与权限确认

系统 SHALL 提供 `plugin_install_from_file/uninstall`（解压到 `app_data/plugins/<id>/`、覆盖即升级、内置拒卸）；设置页安装流程 SHALL 含权限确认 step（展示 `permissions[] + methods[][name/permissions/dangerAction]`，中英 i18n），确认后才执行安装；启用状态沿用 `plugin_settings` 持久化并经 `plugin://changed` 多窗同步。

#### Scenario: 权限确认后安装

- **WHEN** 用户选包后看到 net/vault 等权限并确认
- **THEN** 执行安装并出现“已安装”来源标签，可卸载

#### Scenario: 凭据不落明文

- **WHEN** 插件存取密钥
- **THEN** 经 keyring `plugin:{id}:{key}` 读写，库内无明文（复用现有语义）
