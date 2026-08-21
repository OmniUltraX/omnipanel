## ADDED Requirements

### Requirement: 模块壳

系统 SHALL 为 `kind: module` 提供标准模块壳：连接列表（`kind=service`）、标签过滤、发现/扫描入口、左树右主区布局。插件 MUST 只填充业务主区与 probe，MUST NOT 自建第二套标签存储。

#### Scenario: 扫描结果进入列表

- **WHEN** 用户在模块壳中触发已登记的 SSH 发现 probe 并确认预览
- **THEN** 新建实例 MUST 以 `kind=service` + 该插件 `pluginId` 写入 connections
- **AND** 模块壳列表 MUST 立即可见这些实例

### Requirement: Addon 命令菜单与 Overlay

系统 SHALL 允许 `kind: addon`（及其他 kind）贡献 commands、menus（含 `when` 条件）与 overlays。全局 `ContextMenu` MUST 从贡献表合并项。内核「分享」MUST 改为经该总线注入，MUST NOT 作为唯一硬编码全局项长期存在。

#### Scenario: 有选区才出现翻译项

- **GIVEN** 翻译 addon 已启用且声明 `when: selection.hasText`
- **WHEN** 用户在无可选文本的空白区域打开全局右键菜单
- **THEN** 菜单 MUST NOT 显示翻译命令

#### Scenario: 有选区时打开 Overlay

- **WHEN** 用户选中文本并执行翻译 addon 的命令
- **THEN** 系统 MUST 将当前选区快照交给插件（`ui:selection`）
- **AND** MUST 在 Overlay 中展示结果
- **AND** 若未授予 `net:connect` MUST 在请求网络翻译时失败

### Requirement: 选区总线

系统 SHALL 提供统一选区 API，聚合终端、编辑器与 DOM 选区。`ui:selection` MUST 只提供一次性快照，MUST NOT 授权持续键盘或剪贴板监听。

#### Scenario: 终端选区可被 addon 读取

- **WHEN** 终端内存在 xterm 选区且用户触发依赖选区的 addon 命令
- **THEN** `host.selection.get()` MUST 返回该选区文本
- **AND** 插件 MUST NOT 获得对终端会话的任意读取权

### Requirement: 启动器 Provider

系统 SHALL 将快捷启动匹配源注册为 provider（前缀与可选 plain 匹配）。内核 MUST 登记 `ssh` 与 `db` provider。系统 MUST NOT 以源码闭集 `["ssh","db"]` 作为扩展唯一方式。

#### Scenario: 输入 ssh 前缀

- **WHEN** 用户在快捷启动中输入 `ssh` 或 `ssh+filter`
- **THEN** 结果 MUST 由 ssh provider 提供
- **AND** 行为与现有 SSH 连接匹配语义一致

#### Scenario: addon 登记计算器前缀

- **WHEN** 已启用 addon 声明 `launcher.prefix = "calc"`
- **THEN** 输入 `calc 1+1` MUST 由该 provider 返回结果行
- **AND** MUST NOT 新开独立 WebView 窗口

#### Scenario: Everything 启动器前缀

- **WHEN** Everything addon 已在 Windows 上启用并声明 `launcher.prefix = "es"`
- **THEN** 输入 `es docker-compose` MUST 调用与 `omni_everything_search` 相同的查询实现
- **AND** 结果行 MUST 展示路径且 MUST NOT 新开 WebView 窗口

### Requirement: 主题包与 token 合同

系统 SHALL 以公开 CSS token 合同应用 `kind: theme` 插件。主题包 v1 MUST NOT 执行 JavaScript。应用主题 MUST 同时更新 UI token 与终端色板（包内 `terminal` 或显式回退到默认暗/亮终端主题）。子窗口 MUST 经 `appearanceSync` 同步 `themePackId`。

#### Scenario: 切换主题包装终端

- **WHEN** 用户选择已安装的暗色主题包
- **THEN** 文档根节点 MUST 应用合同内的 `--bg`/`--fg`/`--accent` 等公开 token
- **AND** 终端 MUST 使用该包提供的或回退的 xterm 主题
- **AND** 已打开的模块子窗 MUST 同步同一 `themePackId`

#### Scenario: 密度不属于主题

- **WHEN** 用户更改 UI 密度或缩放
- **THEN** 该设置 MUST 独立于主题包持久化
- **AND** 切换主题包 MUST NOT 重置密度
