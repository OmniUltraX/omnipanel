# panel-starter — OmniPanel panel 样板

独立 id：`omni.panel.starter`（不是 1Panel / 宝塔）。

启用后出现在「添加面板」，点名全部宿主槽。测连必须带 Host 注入的 `apiKey`。列表 / 创建走 `host.netFetch`（地址为 http(s) 时）或 `host.stateGet/Set` fixture，空数组不算验收。

Host 给的是固定壳（列表、通用表单、监控卡片），不是 1Panel / 宝塔后台的像素级克隆。子窗、SFTP、厂商专用弹窗要 overlays 或进第一方进程内 driver。

## 打包

```bash
node scripts/validate-plugin.mjs plugins-samples/panel-starter
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-samples/panel-starter panel-starter.omni-plugin
```

设置 → 插件 → 安装本地包。
