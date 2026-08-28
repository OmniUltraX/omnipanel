# OmniPanel 插件开发指南

OmniPanel 通过 **Host + 七种插件身份** 的体系向第三方开放扩展能力。
本目录是面向插件开发者的完整参考。

| 文档 | 内容 |
|---|---|
| [manifest-reference.md](./manifest-reference.md) | 清单字段逐项参考（七种 kind / contributes / permissions / entry / methods / minHostApi） |
| [permissions-and-levels.md](./permissions-and-levels.md) | 权限模型与三级开放梯度（L1 声明式 / L2 WASM·JS 逻辑 / L3 沙箱 UI） |
| [packaging-and-install.md](./packaging-and-install.md) | 打包、签名、安装、卸载与版本升级 |
| [debugging.md](./debugging.md) | 调试指南：dev 未签名加载、日志、常见错误码 |

## 快速开始

```bash
# 1. 生成 L1 模板（engine 或 theme）
node scripts/create-plugin.mjs my-first-engine engine

# 2. 打包（dev 签名）
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/my-first-engine my-first-engine.omni-plugin

# 3. 安装：设置 → 插件 → 「安装本地插件」选择 .omni-plugin 文件
```

## 能力速览

- **L1（零代码）**：数据库引擎连接表单、workbench 插槽、主题 token、菜单项、AI 工具元数据、Overlay 面板声明 —— 写一个 `plugin.json` 即可上架。
- **L2（逻辑包）**：`entry.logic = "logic.wasm" | "logic.js"`，实现全局 `call(method, argsJson)`；
  通过宿主注入的 `host.*`（netFetch / fsRead / connectionUpsert / invoke / vault* / state*）访问受权限闸保护的能力。
  L2 JS（QuickJS）是宿主硬依赖，不靠 Cargo default（Tauri CLI 会 `--no-default-features`）。`plugin-wasm` 仍按需 `--features`。示例导入器（`importer-warpgate`）的 `logic.js` 嵌入二进制，启动时装载；宿主不按插件 ID 特判。
- **L3（沙箱 UI）**：`contributes.overlays[].entry` 指向 HTML 页面，
  运行于不透明 origin 的 iframe（CSP 默认拒外联），经 postMessage 白名单桥访问选区与受限网络。

## 安全模型一句话

一切 IO 过宿主闸：清单 `permissions` 缺权即拒、生产环境目标强制弹窗确认、全部动作进审计日志。
