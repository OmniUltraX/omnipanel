# addon-starter — OmniPanel addon 样板

独立 id：`omni.addon.starter`。

L1 启动条前缀 `starter`。需要 Overlay / 菜单时再补 `overlays` / `menus`。

## 打包

```bash
node scripts/validate-plugin.mjs plugins-samples/addon-starter
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-samples/addon-starter addon-starter.omni-plugin
```
