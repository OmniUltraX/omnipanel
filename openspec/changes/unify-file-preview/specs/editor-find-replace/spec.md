## ADDED Requirements

### Requirement: 编辑器查找与替换

系统 MUST 为 CodeMirror 系编辑表面（含文件预览中的代码/源码模式、通用 CodeEditor、SqlEditor）提供查找与替换能力。

#### Scenario: 打开查找

- **WHEN** 编辑器拥有焦点且用户触发查找快捷键（Ctrl/Cmd+F 或产品定义的 search 快捷键）
- **THEN** 系统 MUST 打开查找 UI，并允许输入查询词与跳转到下一匹配

#### Scenario: 替换

- **WHEN** 编辑器可编辑且用户在查找 UI 中执行替换或全部替换
- **THEN** 文档内容 MUST 更新，且 MUST 标记为 dirty（若该表面支持保存）

#### Scenario: 只读表面

- **WHEN** 编辑器为只读
- **THEN** 系统 MUST 仍允许查找与跳转，MUST NOT 提供生效的替换，或替换操作 MUST 被禁用

### Requirement: 编辑器焦点优先于 ScopedSearch

当焦点位于 CodeMirror 编辑器内时，查找快捷键 MUST 交给编辑器 Find，MUST NOT 激活侧栏/列表 ScopedSearch。

#### Scenario: SQL 编辑器内查找

- **WHEN** 用户焦点在 SqlEditor 内并按下查找快捷键
- **THEN** 打开的是编辑器查找 UI，而不是 Schema/侧栏 ScopedSearch

#### Scenario: 侧栏仍可用 ScopedSearch

- **WHEN** 焦点在 Schema 树或其它 ScopedSearch 宿主内（非 CM 编辑器）并按下查找快捷键
- **THEN** 系统 MUST 仍激活该宿主的 ScopedSearch
