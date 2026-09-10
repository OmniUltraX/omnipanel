# External Compat

## Purpose

外部（Rubick/uTools 系）插件安装前静态判定与转换：analyzer 给出 `runnable | external-only` verdict（含原因），runnable 的 converter 打成标准 `.omni-plugin` 走现有管线；不新增 kind，不执行外部代码。

## ADDED Requirements

### Requirement: compat analyzer 静态判定

系统 SHALL 对候选包做纯静态判定：形状校验（`package.json` 需 `pluginName`+`features`，或 `plugin.json` 同源文法）→ preload 扫描（Node 内建/`electron`/`child_process` 黑名单任一命中即 external-only；未知 `utools.*` 即 external-only）→ verdict 含 reasons；同一版本 verdict SHALL 缓存。

#### Scenario: pure-web 插件判 runnable

- **WHEN** 包仅含 features 关键字与静态 HTML、无 preload Node 依赖
- **THEN** verdict=runnable，reasons 为空

#### Scenario: Node 强依赖判 external-only

- **WHEN** preload 含 `require('electron')` 或 Node 内建模块
- **THEN** verdict=external-only，reasons 列出命中项，并给外跳指引

#### Scenario: 未知 utools API 保守拒绝

- **WHEN** preload 调用的 `utools.*` 不在白名单
- **THEN** verdict=external-only（默认拒绝），reasons 列出未知 API

### Requirement: converter 输出标准包

converter SHALL 将 runnable 包转为标准 `.omni-plugin`：字符串 cmds → addon launcher/menus（L1），`overlays[].entry` → 主 HTML（L3 既有管线），preload 丢弃，按需生成最小 `ui/main.js`；包 SHALL 带 dev 签名与第三方未审核标记；转出包的启用/禁用/升级/审计 SHALL 与普通包一致。

#### Scenario: 转换安装闭环

- **WHEN** 用户对 runnable 包确认转换安装
- **THEN** 包出现在对应入口，启用/禁用跟随生命周期，审计记 `plugin.external.convert`

#### Scenario: 不留特殊路径

- **WHEN** 转出包已安装
- **THEN** 其一切行为与手写第三方包一致，无特殊分支
