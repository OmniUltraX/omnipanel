# Marketplace Registry（delta）

## ADDED Requirements

### Requirement: artifact 支持 npm integrity

`RegistryArtifact` SHALL 新增可选 `integrity` 字段（npm `dist.integrity` sha512-base64 原样透传）；校验优先级 SHALL 为 integrity（有）> sha256（回退）。

#### Scenario: integrity 优先校验

- **WHEN** artifact 同时含 integrity 与 sha256 且 integrity 不符
- **THEN** 拒绝下载，不回退 sha256

#### Scenario: 旧文件兼容

- **WHEN** artifact 无 integrity 字段
- **THEN** 按既有 sha256 路径校验，行为不变
