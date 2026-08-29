## ADDED Requirements

### Requirement: 三层资源树

`/module/cloud` 侧栏树 SHALL 为三层：云账户（`kind=cloud` 连接）→ 该账户已激活插件声明的能力 → 该能力下的实例。树根 MUST 是账户而非厂商。实例节点 MUST 在展开对应能力后懒加载。地域 MUST NOT 作为树的中间层。

#### Scenario: 同一厂商两个账户

- **WHEN** 用户保存了两个 `pluginId=omni.cloud.aliyun` 的云账户
- **THEN** 树 MUST 出现两个账户根节点
- **AND** 各自能力与实例 MUST 互不混挂

#### Scenario: 展开能力才拉实例

- **WHEN** 用户展开某账户下的 `compute` 节点
- **THEN** Host MUST 此时请求 `listResources`
- **AND** 未展开时 MUST NOT 为该能力预拉全量实例

#### Scenario: 空能力仍可见

- **WHEN** 插件声明了某能力但当前筛选下实例数为 0
- **THEN** 该能力节点 MUST 仍显示
- **AND** 打开列表页 MUST 为空态而非隐藏节点

### Requirement: 地域作为筛选

系统 SHALL 提供地域多选筛选（可「全部地域」），并 MUST 同时作用于能力子树与资源列表。全局能力（scope=global）MUST 隐藏地域筛选。实例节点可展示地域标签，MUST NOT 再按地域分组嵌套。

#### Scenario: 筛选同步树与列表

- **WHEN** 用户将地域筛选设为仅 `cn-hangzhou`
- **THEN** `compute` 子树与 ECS 列表 MUST 只含该地域实例
- **AND** 树结构 MUST 仍为账户 → 能力 → 实例

### Requirement: 三级 Dock 工作台

右侧工作区 SHALL 使用与数据库一致的 Dock：点账户打开 **厂商概览**；点能力打开 **资源列表**；点实例打开 **资源详情**。单击 MUST 打开或替换预览 Tab；双击 MUST 打开常驻 Tab。不同能力的列表 Tab MUST 可同时存在。

#### Scenario: 同时打开两类列表

- **WHEN** 用户常驻打开某账户的 `compute` 列表后再打开 `objectStorage` 列表
- **THEN** Dock MUST 同时保留两个列表 Tab
- **AND** MUST NOT 用同一面板内的产品 Tab 互相覆盖

#### Scenario: 双击实例进详情

- **WHEN** 用户双击树中或列表中的计算实例
- **THEN** 系统 MUST 打开该实例的常驻详情 Tab
- **AND** 详情数据 MUST 来自 `getResource`

### Requirement: 概览与列表交互

账户概览 SHALL 至少包含连通性/测连、能力数量或入口、关联的 SSH/文件连接。资源列表 SHALL 复用高密度表格（如 `DbTablesPanelGrid`），工具条含搜索、刷新、以及能力声明的筛选。单击行可展示 inspector；双击打开详情。文案 MUST 走 i18n。

#### Scenario: 点账户进概览

- **WHEN** 用户单击树中账户节点
- **THEN** Host MUST 打开或激活该账户的概览 Tab（预览模式）
- **AND** MUST NOT 再打开「某地域 × 内嵌五产品 Tab」的旧面板作为主路径

### Requirement: 插件启用门控

Cloud Host MUST 仅展示 `kind=cloud` 且当前已激活的插件。加账户对话框 MUST 按激活插件渲染厂商芯片与 `connectionForm`。禁用插件后其芯片与能力子树 MUST 消失；该插件写入的云账户连接 MUST 保留。

#### Scenario: 禁用阿里云插件

- **WHEN** 用户禁用 `omni.cloud.aliyun`
- **THEN** 加账户对话框 MUST 不再显示阿里云芯片
- **AND** 已有阿里云账户 MUST 不展开能力与实例（或显示插件未启用说明）
- **AND** 连接记录 MUST 仍可在连接存储中找到

#### Scenario: 无云插件时

- **WHEN** 没有任何已激活的 cloud 插件
- **THEN** 云模块空态 MUST 提示安装或启用云厂商插件
- **AND** MUST NOT 写死唯一阿里云芯片

### Requirement: DNS 实例边界

若插件声明 `dns`，树实例 SHALL 为托管区。解析记录 MUST 在详情嵌套列表中展示，MUST NOT 作为树的第四层。

#### Scenario: 解析记录不上树

- **WHEN** 用户展开 `dns` 能力节点
- **THEN** 子节点 MUST 为托管区
- **AND** MUST NOT 为每条 A/CNAME 记录创建树节点
