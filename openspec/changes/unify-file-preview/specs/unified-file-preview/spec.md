## ADDED Requirements

### Requirement: 统一预览壳默认展示文件树

系统 MUST 在所有通过统一预览壳打开的文件预览中展示左侧文件树；树的初始上下文 MUST 为当前预览文件所在目录（parent path）。

#### Scenario: 文件管理打开预览带树

- **WHEN** 用户在文件管理中打开可预览文件
- **THEN** 预览子窗显示左侧文件树，且树聚焦/根上下文为该文件所在目录

#### Scenario: SFTP 与终端入口一致

- **WHEN** 用户分别从 SFTP 面板与终端链接打开同一远端文件
- **THEN** 两侧预览壳均显示文件树，且选择同目录其他文件可切换预览（未保存时 MUST 确认）

#### Scenario: 折叠与宽度

- **WHEN** 用户折叠文件树或调整树宽度后再次打开预览
- **THEN** 系统 MUST 恢复其折叠或宽度偏好（会话或设置级持久化）

### Requirement: 标准 Preview IO 工厂

系统 MUST 通过标准会话描述构建 `FilePreviewIO`，使 local / file_manager / sftp 入口共享同一套读写、媒体流与压缩包列目录能力（在后端能力可用时），避免入口各自拼装导致能力缺失。

#### Scenario: SFTP 压缩包列目录

- **WHEN** 用户在 SFTP 预览中打开远端 zip/tar 等支持的压缩包，且远端工具可用
- **THEN** 系统 MUST 列出压缩包条目，而不要求整包下载到本地

#### Scenario: 终端与 SFTP 媒体流一致

- **WHEN** 用户在终端或 SFTP 打开远端音视频/图片且资源 id 有效
- **THEN** 系统 MUST 使用边下边播/探测接口预览，不得因入口不同而整文件载入失败

### Requirement: 预览能力矩阵一致

对同一会话类型与文件 kind，系统 MUST 提供一致的保存、下载（远端适用）、文本模式切换与大文件分流行为。

#### Scenario: 远端文本可保存

- **WHEN** 用户在统一预览壳中编辑小于大文件阈值的远端文本且有写权限
- **THEN** 系统 MUST 允许保存；保存成功后 dirty 状态清除

#### Scenario: 不支持类型

- **WHEN** 用户打开判定为 unsupported 的文件
- **THEN** 系统 MUST 显示不支持预览说明，并在有下载能力时提供下载路径提示
