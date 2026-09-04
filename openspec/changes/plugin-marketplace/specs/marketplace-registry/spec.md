## ADDED Requirements

### Requirement: 多源 registry 与 v2 schema

系统 SHALL 支持官方默认源 + 用户自加第三方源；registry 为静态 JSON（`schemaVersion=2`，`versions[]` 含 version/changelog/minHostApi/artifact{url,sha256,size}），顶层签名可验。v1 条目 SHALL 按单 version 兼容读。

#### Scenario: 添加第三方源并浏览

- **WHEN** 用户添加第三方 registry URL 并通过连通性校验
- **THEN** 市场列表合并显示该源插件，标注来源

#### Scenario: v1 条目兼容

- **WHEN** registry 为 v1 格式（无 versions[]）
- **THEN** 按单 version 正常展示安装，不报错

### Requirement: registry 签名与信任轮换

registry 拉取后 SHALL 验签（ed25519，与包签名同 key 体系）；新源首次添加 SHALL TOFU pin key；源换 key SHALL 要求用户确认；token 认证源的 token SHALL 只存 keyring。

#### Scenario: 篡改拒绝

- **WHEN** registry 任一字节被改后拉取
- **THEN** 验签失败并拒绝使用该源数据，保留旧缓存

#### Scenario: 换 key 确认

- **WHEN** 已 pin 源的签名 key 变化
- **THEN** 暂停该源并提示用户确认新 key，确认前沿用旧数据
