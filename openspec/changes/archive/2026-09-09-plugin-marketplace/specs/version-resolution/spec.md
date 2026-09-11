## ADDED Requirements

### Requirement: semver 比较与更新判定

系统 SHALL 用 semver 解析比较版本号；registry 最新 compatible 版本高于已安装 SHALL 标 `updateAvailable`；`minHostApi` 高于宿主 SHALL 灰显原因而非隐藏。

#### Scenario: 有更新提示

- **WHEN** registry 出现更高 compatible 版本
- **THEN** 市场项标可更新并可查看 changelog

#### Scenario: 不兼容版本灰显

- **WHEN** 最新版 minHostApi 高于宿主
- **THEN** 该版本灰显"需新版宿主"，不提供安装按钮

### Requirement: 装指定版本

系统 SHALL 支持安装 registry 中任一 compatible 历史版本。

#### Scenario: 回退旧版

- **WHEN** 用户选择安装旧版本并确认
- **THEN** 按原子安装流程装上旧版并有 audit
