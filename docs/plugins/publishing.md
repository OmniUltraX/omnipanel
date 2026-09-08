# 托管插件源

官方目录是一份签名过的静态 `plugin-registry.json`。任何人都可以按同样协议托管第三方源。

## 打出 registry 片段

```bash
node scripts/validate-plugin.mjs plugins-custom/my-plugin
cargo run -p omnipanel-plugin-pkg --bin publish -- plugins-custom/my-plugin \
  https://example.com/releases/my-plugin-1.0.0.omni-plugin \
  "fix overlay crash"
```

把打印出的 JSON 对象放进 `plugins` 数组。`schemaVersion` 必须是 `2`。

## GitHub Releases 模板

1. 建 `plugin-registry.json`（可把多条 publish 片段合在一起）。
2. 用官方或自有 ed25519 私钥签名（`canonical_registry_bytes` 不含 `signature` / `publisher_key`）。
3. 上传 `plugin-registry.json` 与各 `.omni-plugin` 到同一 Release。
4. 客户端「插件源」里填写该 JSON 的 HTTPS URL；可选 Bearer token（只进钥匙串）。

官方默认源：

`https://github.com/OmniUltraX/omnipanel/releases/download/plugins-latest/plugin-registry.json`

## 客户端加源

插件中心 → 插件源 → 填源 ID、URL、公钥 hex（可留空走 TOFU）。官方源不可删，可禁用。

内置 bundled 插件不会从网上覆盖。

## Studio 一键投稿

1. 插件工作台打包，把 `.omni-plugin` 传到可 HTTPS 下载的地址（GitHub Release 即可）。
2. 点「投稿」：填制品 URL、可选 changelog / 目标仓库（默认 `OmniUltraX/omnipanel`）。
3. 首次把 GitHub token（需要 `repo` 权限建 issue）存进本机钥匙串，确认框里预览正文后再发。
4. 每工程每 24 小时最多 3 次。标题为 `[plugin-submission] <id> <version>`，标签 `plugin-submission`。
5. 维护者把 issue 标为 **completed** 后，`.github/workflows/plugin-submissions.yml` 会校验片段、合进 `plugins/registry.json` 并提 PR。含 `ssh:exec` 的投稿会跳过自动归档。
6. 若仓库配置了 `PLUGIN_REGISTRY_SIGNING_KEY`（32 字节 hex 种子），Action 会再跑 `sign-registry`；否则合入前本地签：

```bash
PLUGIN_REGISTRY_SIGNING_KEY=<hex> cargo run -p omnipanel-plugin-pkg --bin sign-registry -- plugins/registry.json
```

