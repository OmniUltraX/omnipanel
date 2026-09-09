## ADDED Requirements

### Requirement: 启用即应用 tokens

已启用的 `kind=theme` 插件 SHALL 经 `contributes.themes.tokens` 指向的 JSON 资源应用：CSS 变量（UI）与终端色板。Host MUST NOT 按插件 ID 写死色板（内置 default 仅作解析失败时的 fallback 资源）。

#### Scenario: 换肤可见

- **WHEN** 用户启用一个声明了不同强调色的 theme 插件
- **THEN** UI 或终端色板发生可见变化

#### Scenario: 关掉回落

- **WHEN** 用户禁用全部 theme 插件（或仅剩非法 tokens）
- **THEN** 界面回落到内置 default tokens，应用不崩溃

### Requirement: 单活主题

同时启用多个 theme 时，系统 SHALL 只应用最近一次启用的那一个。

#### Scenario: 后启覆盖

- **WHEN** 已启用 A，再启用 B
- **THEN** 生效的是 B 的 tokens
