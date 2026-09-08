# plugin-sdk 发版

`packages/plugin-sdk` 与宿主 `HOST_API_VERSION`（当前 1）对齐：只增字段，不改既有语义。破坏性变更时同时递增两者。

```bash
cd packages/plugin-sdk
npm run build
npm pack --dry-run
# 账号就绪后再：npm publish --access public
```

版本号建议：`HOST_API_VERSION=1` → `1.x.y`。CHANGELOG 写在包内，不另开文档。
