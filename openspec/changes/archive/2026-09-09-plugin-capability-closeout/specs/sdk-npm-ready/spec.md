## ADDED Requirements

### Requirement: SDK 可构建可打包

`@omnipanel/plugin-sdk` SHALL 能 `npm run build` 且 `npm pack --dry-run` 在 CI 通过。版本号 MUST 与宿主 `HOST_API_VERSION` 按 `docs/plugins/sdk-release.md` 对齐记录。

#### Scenario: CI pack

- **WHEN** CI 运行 SDK pack dry-run
- **THEN** 成功产出包清单且无构建错误

### Requirement: publish 不阻塞本 change

真实 `npm publish` SHALL 仅在账号就绪时执行；账号缺失 MUST NOT 视为本能力失败。

#### Scenario: 无账号仍可归档

- **WHEN** 没有 npm 发布账号
- **THEN** 以文档 + CI pack 为完成线
