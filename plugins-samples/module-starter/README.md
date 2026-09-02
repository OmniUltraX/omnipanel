# module-starter — OmniPanel module 样板

独立 id：`omni.module.starter`（不是 `omni.module.nacos`）。

用来验证「可安装 module 模板」：清单 + L2 `logic.js` + Host 能力插槽。只声明 `config` 时，工作台不会出现服务发现节点。

## 打包

```bash
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-samples/module-starter module-starter.omni-plugin
```

设置 → 插件 → 安装本地包。启用后侧栏出现 Starter；卸载后入口消失，已保存的 service 连接仍在。
