# dbx-oracle — DBX sidecar 引擎样板

第三方数据库插件最小可跑通路径（对齐 [dbx](https://github.com/t8y2/dbx) 的 stdin/stdout JSON-RPC agent）：

- `runtime: sidecar` + `entry.driver: bin/agent.mjs`
- 安装后连接对话框出现 Oracle 芯片；测连走 mock agent（表 EMP/DEPT）
- 真实 DBX 包把 `entry.driver` 换成 `bin/agent.jar`（宿主会按 `java -jar` 拉起）

## 打包与安装

```bash
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-samples/dbx-oracle dbx-oracle.omni-plugin
```

设置 → 插件 → 「安装本地插件」选择生成的 `dbx-oracle.omni-plugin`。
开发构建接受本 CLI 的开发签名；然后打开数据库连接对话框选 Oracle。
