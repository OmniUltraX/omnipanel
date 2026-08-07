## ADDED Requirements

### Requirement: 本地与 SSH 大文件日志查看

对超过预览整载阈值（或大小未知）的 text/json 类文件，系统 MUST 使用大日志表面进行流式/窗口化查看，且 MUST 同时支持本地文件与 SSH 远端文件。

#### Scenario: SSH 大日志打开

- **WHEN** 用户打开远端 >10MB 的 `.log`/文本且具备有效 SSH 资源
- **THEN** 系统 MUST 打开放大日志查看器（非整文件载入 JS 字符串）

#### Scenario: 本地大日志打开

- **WHEN** 用户打开本地 >10MB 的文本/日志文件
- **THEN** 系统 MUST 同样打开放大日志查看器，MUST NOT 仅因非 SSH 而拒绝预览

#### Scenario: 搜索

- **WHEN** 用户在大日志查看器中搜索关键词
- **THEN** 系统 MUST 返回可跳转的匹配行（可分页/限流），不得要求前端持有全文

#### Scenario: 跟踪

- **WHEN** 用户开启跟踪（follow）且文件持续追加
- **THEN** 系统 MUST 展示新增行；用户停止跟踪后 MUST 停止追加消费

### Requirement: 大日志模式只读

大日志表面 MUST 为只读；MUST NOT 提供对整文件的就地替换写入。

#### Scenario: 无替换

- **WHEN** 用户处于大日志模式
- **THEN** 界面 MUST NOT 提供生效的「替换文件内容」操作

### Requirement: 运行时日志可迁入同一表面（预留）

系统 SHOULD 允许 Docker 容器日志、站点面板日志等运行时流在后续迭代接入与大日志一致的搜索/跟踪交互语言；本变更 MUST 不阻塞文件大日志 local+ssh 交付。

#### Scenario: 文件大日志不依赖运行时迁入

- **WHEN** 仅完成文件 local+ssh 大日志
- **THEN** 成功标准中的本地/远端大文件查看与搜索 MUST 已可用，即使 Docker/站点仍使用旧 LogViewer
