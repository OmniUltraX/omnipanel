# plugin-sdk 发版

`packages/plugin-sdk` 与宿主 `HOST_API_VERSION`（当前 1）对齐：只增字段，不改既有语义。破坏性变更时同时递增两者。

```bash
cd packages/plugin-sdk
npm run build
npm pack --dry-run
# 账号就绪后再：npm publish --access public
```

包版本当前为 `0.1.x`（未正式 npm publish）。对外发布时与 `HOST_API_VERSION=1` 对齐为 `1.x.y`。破坏性变更时同时递增宿主常量与包大版本。CHANGELOG 写在包内，不另开文档。

## CI 发布

`.github/workflows/publish-plugin-sdk.yml`：

- push tag `plugin-sdk-v*` → build + `npm pack --dry-run` + publish（有 `NPM_TOKEN` 时）；
- 手动 `workflow_dispatch`（`publish=true`）同样路径；
- 未配置 `NPM_TOKEN` 时只做 build + pack 校验并告警退出，不失败——账号待定期间 CI 保持绿灯。
