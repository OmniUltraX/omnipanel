# Studio User Projects

## Purpose

Studio SHALL 将用户工程存储在应用数据目录 `plugin-projects/` 下。开发态 MAY 并集扫描仓库 `plugins-custom/`，但新建工程 MUST 写入用户目录。无仓库源码树时工作台 MUST 仍可用。

## Requirements

### Requirement: 发行版工程根

Studio SHALL 将用户工程存储在应用数据目录 `plugin-projects/` 下。开发态 MAY 并集扫描仓库 `plugins-custom/`，但新建工程 MUST 写入用户目录。无仓库源码树时工作台 MUST 仍可用。

#### Scenario: 安装包新建工程

- **WHEN** 发行版（找不到仓库 `plugins/`）用户点击新建
- **THEN** 工程落在 `app_data/plugin-projects/<name>/` 且列表可见

#### Scenario: 开发态旧工程仍在

- **WHEN** 仓库存在 `plugins-custom/foo`
- **THEN** 列表仍显示该工程并标明来源为仓库

### Requirement: 路径禁锢不变

读写、删除、脚本 MUST 仍拒绝 `..`、绝对路径、跨工程访问。

#### Scenario: 越界拒绝

- **WHEN** 请求读取工程目录外的文件
- **THEN** 拒绝且不执行

### Requirement: 无 Node 也能校验打包（非 WASM）

L1 / JS 配方的校验与打包 MUST 经应用内 Rust（清单校验 + `omnipanel-plugin-pkg`），MUST NOT 依赖仓库内 node 脚本或本机 cargo。

#### Scenario: 无 cargo 可打包 JS 插件

- **WHEN** 本机无 cargo、有合法 JS 工程
- **THEN** 打包按钮可用并产出 `.omni-plugin`

#### Scenario: 无 wat2wasm 时 WASM 置灰

- **WHEN** 工程含 `.wat` 且未探测到 wat2wasm
- **THEN** WASM 相关打包置灰并给出引导，其它配方不受影响
