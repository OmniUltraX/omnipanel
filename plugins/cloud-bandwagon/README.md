# omni-plugin-cloud-bandwagon

OmniPanel 可选插件：`omni.cloud.bandwagon`（搬瓦工）。

不随 OmniPanel 客户端 bundled，需从插件中心安装并启用后，云工作台才出现该厂商。

## 安装

### 插件中心（推荐）

OmniPanel → 设置 / 插件 → 市场 → 搜索 **搬瓦工** → **获取** → 启用。

官方 catalog：`distribution: download`，制品在宿主仓库
[plugins-latest](https://github.com/OmniUltraX/omnipanel/releases/tag/plugins-latest)
（`omni-cloud-bandwagon-<version>.omni-plugin`）。

### 本地包

```bash
cargo run -p omnipanel-plugin-pkg --bin pack -- \
  plugins/cloud-bandwagon \
  omni-cloud-bandwagon-0.1.0.omni-plugin
```

## 开发

| 文件 | 说明 |
|------|------|
| `plugin.json` | 清单（合同事实源） |
| `logic.js` | L2 QuickJS 逻辑 |

宿主仓库以 git submodule 挂载于 `plugins/cloud-bandwagon`。
宿主 `scripts/plugin-download-only.mjs` 将该目录标为 download-only。

## 发版约定

1. bump `plugin.json` 的 `version`
2. push tag `vX.Y.Z` → CI `pack-release.yml` 产出 `.omni-plugin` 并上传 Release
3. 宿主侧合并 submodule 指针后，触发 `publish-plugin-registry`

制品文件名固定：`omni-cloud-bandwagon-<version>.omni-plugin`。

## License

与 [OmniPanel](https://github.com/OmniUltraX/omnipanel) 相同。
