# cloud-l2-starter — 云厂商 L2 样板

独立 id：`example.cloud.starter`（不要和第一方 `omni.cloud.*` 撞号）。一条 `compute` 能力，`logic.js` 返回只读 fixture 列表，**不打真实云 API**。

真实厂商请看 `plugins/cloud-tencent`、`plugins/cloud-huawei`（第一方 L2，走 `host.hmac` / `host.netFetch`）。

启用后出现在「添加云账户」。Host 只按清单 `capabilities` 登记槽，禁用后能力从工作台消失。把本包 id 改成另一个反向域名再装，行为应相同。

## 打包

```bash
node scripts/validate-plugin.mjs plugins-samples/cloud-l2-starter
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-samples/cloud-l2-starter cloud-l2-starter.omni-plugin
```

设置 → 插件 → 安装本地包 → 启用 → 云工作台添加账户。
