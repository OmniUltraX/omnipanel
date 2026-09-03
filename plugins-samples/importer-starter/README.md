# importer-starter — OmniPanel importer 样板

独立 id：`omni.importer.starter`。

L2 `fetchTargets` 根据填写的地址产出一条可导入的 SSH 候选。向导走完后连接出现在列表。

## 打包

```bash
node scripts/validate-plugin.mjs plugins-samples/importer-starter
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-samples/importer-starter importer-starter.omni-plugin
```
