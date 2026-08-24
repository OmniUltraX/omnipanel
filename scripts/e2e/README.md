# 插件能力端到端验收

前置：应用以 dev-mcp 构建运行（`cargo run -p omnipanel-app --features dev-mcp`，
前端 Vite 已启动），MCP Bridge 监听 127.0.0.1:9223。

```bash
cargo run -q -p omnipanel-plugin-pkg --bin pack -- plugins-samples/l1-starter %TEMP%\opencode\l1-starter.omni-plugin
cargo run -q -p omnipanel-plugin-pkg --bin pack -- plugins-samples/l3-translator %TEMP%\opencode\l3-translator.omni-plugin
node scripts/e2e/plugin-capabilities.mjs
```

覆盖：安装/落盘/清单通道/网关白名单/沙箱权限闸/开关切换/资产读取/路径越界/卸载清理/内置保护。
