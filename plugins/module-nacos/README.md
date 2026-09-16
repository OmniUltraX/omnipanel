# omni-plugin-nacos

OmniPanel 可选插件：`omni.module.nacos`（Nacos 工作台）。

不随 OmniPanel 客户端 bundled，需安装启用后侧栏才出现 `/module/nacos`。

## 安装

```bash
# 打包（需 OmniPanel 仓库里的 omnipanel-plugin-pkg）
cargo run -p omnipanel-plugin-pkg --bin pack -- . nacos.omni-plugin
```

设置 → 插件 →「安装本地插件」→ 启用。

或从 OmniPanel 插件中心下载（registry `distribution: download`）。

## 开发

| 文件 | 说明 |
|------|------|
| `plugin.json` | 清单（合同事实源） |
| `logic.js` | L2 QuickJS 逻辑 |
| `src/index.ts` | SDK 类型入口（宿主 monorepo 校验用） |

宿主仓库以 git submodule 挂载于 `plugins/module-nacos`。

## License

与 [OmniPanel](https://github.com/OmniUltraX/omnipanel) 相同。
