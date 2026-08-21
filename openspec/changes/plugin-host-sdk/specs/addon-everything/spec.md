## ADDED Requirements

### Requirement: Everything 为 addon 而非新 kind

系统 SHALL 将本机 Everything 搜索实现为 `kind: addon` 的第一方插件（id 建议 `omni.addon.everything`）。系统 MUST NOT 为此新增侧栏模块或第 8 种插件 kind。

#### Scenario: 无侧栏入口

- **WHEN** Everything 插件已启用
- **THEN** 主侧栏 MUST NOT 因此增加独立「Everything」图标
- **AND** 用户 MUST 能在设置的插件列表中启用或禁用它

### Requirement: Native 搜索工具

系统 SHALL 提供工具 `omni_everything_search`，由 Everything 插件在激活时登记，`exec_kind` MUST 为 Native。参数 MUST 含 `query`，可选 `max_results`（MUST 有上限，建议不超过 200）。返回 MUST 为路径元数据（路径、是否目录、可选大小与修改时间），MUST NOT 默认读取文件内容。该工具 MUST 对跨模块 Agent 可用（与 `omni_web_search` 同类）。`external_exposed` MUST 默认为 false。

#### Scenario: 模型调用搜索

- **WHEN** Everything 已在本机运行且插件已启用，模型调用 `omni_everything_search` 且 query 为合法 Everything 语法
- **THEN** 系统 MUST 经 IPC 返回不超过上限的结果列表
- **AND** 每条结果 MUST 含完整路径

#### Scenario: Everything 未运行

- **WHEN** Windows 上插件已启用但 Everything 进程/IPC 不可用
- **THEN** 工具 MUST 失败
- **AND** 错误信息 MUST 可理解（走 i18n），提示用户先启动 Everything
- **AND** 系统 MUST NOT 自动拉起 Everything

### Requirement: IPC 主路径不含官方 DLL

系统 SHALL 使用 Everything 命名管道（含 1.5a 实例名回退）或 WM_COPYDATA 与本机 Everything 通信。主路径 MUST NOT `LoadLibrary` Everything 官方 SDK DLL。非 Windows 构建 MUST 提供空实现且不激活该插件。

#### Scenario: 1.5 管道优先

- **WHEN** `\\.\PIPE\Everything IPC` 可连接
- **THEN** 查询 MUST 走该管道
- **AND** MUST NOT 因此加载 Everything64.dll

### Requirement: 凭据与审计

系统 SHALL 不把 Everything 查询凭据写入 Vault（本机 IPC 无账号密码）。审计若记录该工具调用，MUST 包含 pluginId 与 query 摘要，MUST NOT 把完整结果列表明文写入常规日志。

#### Scenario: 不写 Vault

- **WHEN** 用户仅使用 Everything 搜索工具
- **THEN** 系统 MUST NOT 为此创建 Vault 条目
