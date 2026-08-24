## ADDED Requirements

### Requirement: 包格式

系统 SHALL 定义 `.omni-plugin` 安装包：zip 容器内含 `plugin.json`（沿用现有清单 schema，可选 `entry.logic` / `entry.ui`）、静态资产目录，以及可选的逻辑/UI 包；包外附带 ed25519 签名文件，签名对象为 zip 内容规范化字节流。

#### Scenario: 篡改检测

- **WHEN** 安装包内任一字节被修改
- **THEN** 签名校验 MUST 失败
- **AND** 系统 MUST 拒绝安装并给出可理解错误

#### Scenario: 清单校验一致

- **WHEN** 包内 `plugin.json` 未通过现有清单 schema 校验
- **THEN** 安装 MUST 失败
- **AND** 错误信息 MUST 指出违规字段

### Requirement: 安装与卸载

系统 SHALL 提供 `plugin_install_from_file` 与 `plugin_uninstall` 命令。安装包解压至用户级插件目录并合并进 Registry；卸载 MUST 仅允许移除磁盘来源插件，编译期内置插件只能禁用。启用状态持久化 MUST 复用现有 `plugin_settings`。

#### Scenario: 本地包安装闭环

- **WHEN** 用户从设置页导入合法签名的 `.omni-plugin`
- **THEN** 插件 MUST 出现在设置列表并标记来源为「已安装」
- **AND** 重启后启用状态与贡献点 MUST 保持

#### Scenario: 内置插件拒绝卸载

- **WHEN** 对编译期内置插件调用卸载
- **THEN** 系统 MUST 返回错误
- **AND** 仅允许禁用

### Requirement: 分级开放

系统 SHALL 以三级梯度开放第三方能力：L1 纯声明式（表单/主题 token/菜单/AI 工具元数据/discovery 声明）无代码即可装载；L2 业务逻辑经 WASM 执行；L3 自定义 UI 经沙箱 iframe 渲染。L1 MUST 最先开放且不依赖 L2/L3 的运行时。

#### Scenario: 无代码包可用

- **WHEN** 安装仅含 `plugin.json` 与静态资产的 L1 包
- **THEN** 其声明的表单、主题、菜单与 AI 工具元数据 MUST 正常生效
- **AND** 系统 MUST NOT 要求其携带逻辑或 UI 入口

### Requirement: 签名策略

发布渠道 SHALL 校验安装包签名公钥链。debug/dev 构建 MAY 加载未签名包用于开发；release 构建 MUST 拒绝未签名包。

#### Scenario: release 拒绝未签名

- **WHEN** release 构建尝试安装无有效签名的包
- **THEN** 安装 MUST 失败并提示签名要求
