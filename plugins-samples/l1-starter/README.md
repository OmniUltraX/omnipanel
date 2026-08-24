# l1-starter — 第三方 L1 声明式样板插件

纯声明式（零代码）的 `.omni-plugin` 样板，用于验证 L1 开放链路：

- `kind: engine`：连接对话框按 `connectionForm.fields` 渲染未知引擎；
  未携带逻辑包时 workbench 显示「不可用」（宿主降级路径）。
- `ai.tools`：工具元数据进 OmniMCP 模型清单；未带 `logic.wasm` 时
  调用经网关返回 `UnknownMethod`（干净失败，不挂死）。

## 打包与安装

```bash
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-samples/l1-starter l1-starter.omni-plugin
```

然后在 设置 → 插件 → 「安装本地插件」选择生成的 `l1-starter.omni-plugin`。
release 构建仅接受官方签名；dev 构建接受本 CLI 的开发签名/未签名包。
