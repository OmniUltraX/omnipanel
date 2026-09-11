# Rubick Source

## Purpose

市场多源新增 `rubick` 第三方源：以 npm 开放协议发现 Rubick 系插件（npm 包形态），curated registry 文件收录精选，搜索框按需 live 补齐；合并视图标注来源；制品取包必验 integrity/sha256。

## ADDED Requirements

### Requirement: rubick 源拉取与合并展示

系统 SHALL 支持 `rubick` 源：curated registry 文件解析（schema v2 复用）+ npm search live 补齐；合并视图中该源插件 SHALL 标注第三方来源。

#### Scenario: 浏览 rubick 源插件

- **WHEN** 用户打开市场并筛选来源为 rubick
- **THEN** 列表展示该源插件（名称/描述/版本/作者/npm 包名）并带第三方 badge

#### Scenario: 源不可用时保留旧缓存

- **WHEN** npm 或 curated 文件拉取失败
- **THEN** 沿用旧缓存并提示源错误，不清空市场

### Requirement: npm 制品完整性校验

系统 SHALL 在下载 tarball 后验 integrity（有则验 npm `dist.integrity` sha512，无则验 registry `sha256`）；失败 SHALL 拒绝安装并报错。

#### Scenario: 篡改 tarball 拒绝

- **WHEN** 下载字节与 integrity/sha256 不符
- **THEN** 拒绝并提示校验失败，不解压不安装

#### Scenario: 审计记录

- **WHEN** 外部源取包成功或失败
- **THEN** 写审计（action=`plugin.external.fetch`，仅记包名@版本与摘要，不落 token）
