## ADDED Requirements

### Requirement: 一键发布 CLI 与静态托管

`publish` CLI SHALL 一条命令完成 pack → 签名 → 输出可合并 registry 片段（含 sha256/size/changelog）；`generate-plugin-registry.mjs` SHALL 生成 v2 registry 并可选签名；文档 SHALL 给出 GitHub releases 静态托管模板与自定义源接入步骤。

#### Scenario: 从源码到可安装源

- **WHEN** 发布者跑 publish 并把片段合并托管后
- **THEN** 客户端添加该源即可浏览安装，无需传文件

### Requirement: 源认证与 key 轮换位

registry 源 SHALL 支持 bearer token（token 存 keyring）；官方 key 轮换 SHALL 走多 key 并集 + 文档流程，不硬编码单 key。

#### Scenario: 私有源安装

- **WHEN** 用户为私有源配置 token
- **THEN** 拉取与下载携带认证，token 不落明文

#### Scenario: 凭据不落明文

- **WHEN** 保存源配置
- **THEN** 库内仅存 credential_ref，明文只在 keyring
