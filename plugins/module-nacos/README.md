# omni-plugin-nacos

OmniPanel 可选插件：`omni.module.nacos`（Nacos 工作台）。

不随 OmniPanel 客户端 bundled，需从插件中心安装并启用后，侧栏才出现 `/module/nacos`。

## 安装

### 插件中心（推荐）

OmniPanel → 设置 / 插件 → 市场 → 搜索 **Nacos** → **获取** → 启用。

官方 catalog 条目：`distribution: download`，制品在宿主仓库
[`plugins-latest`](https://github.com/OmniUltraX/omnipanel/releases/tag/plugins-latest)
（`omni-module-nacos-<version>.omni-plugin`）。

### 本地包

```bash
# 在 OmniPanel monorepo 根目录打包（需 omnipanel-plugin-pkg）
cargo run -p omnipanel-plugin-pkg --bin pack -- \
  plugins/module-nacos \
  omni-module-nacos-0.2.0.omni-plugin
```

设置 → 插件 →「安装本地插件」→ 启用。

## 开发

| 文件 | 说明 |
|------|------|
| `plugin.json` | 清单（合同事实源） |
| `logic.js` | L2 QuickJS 逻辑 |
| `src/index.ts` | SDK 类型入口（宿主 monorepo 校验用） |

宿主仓库以 git submodule 挂载于 `plugins/module-nacos`。
宿主 `scripts/plugin-download-only.mjs` 将该目录标为 download-only（不进 `first_party` / 前端静态清单）。

## 发版约定

1.  bump `plugin.json` 的 `version`
2.  push tag `vX.Y.Z` → CI `pack-release.yml` 产出 `.omni-plugin` 并上传 Release
3.  宿主侧合并 submodule 指针后，触发 `publish-plugin-registry`：pack + 回填 sha256/size 到 `plugins-latest`

制品文件名固定：`omni-module-nacos-<version>.omni-plugin`（与 registry `artifact.url` 一致）。

## License

与 [OmniPanel](https://github.com/OmniUltraX/omnipanel) 相同。
