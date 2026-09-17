#!/usr/bin/env node
/**
 * 一次性脚手架：为 download-only 云插件写入 pack-release.yml + README。
 * 用法：node scripts/scaffold-cloud-plugin-release.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = path.join(root, "plugins");

const vendors = [
  {
    dir: "cloud-tencent",
    asset: "omni-cloud-tencent",
    title: "Tencent Cloud",
    nameZh: "腾讯云",
    id: "omni.cloud.tencent",
  },
  {
    dir: "cloud-huawei",
    asset: "omni-cloud-huawei",
    title: "Huawei Cloud",
    nameZh: "华为云",
    id: "omni.cloud.huawei",
  },
  {
    dir: "cloud-aws",
    asset: "omni-cloud-aws",
    title: "AWS",
    nameZh: "AWS",
    id: "omni.cloud.aws",
  },
  {
    dir: "cloud-azure",
    asset: "omni-cloud-azure",
    title: "Microsoft Azure",
    nameZh: "Azure",
    id: "omni.cloud.azure",
  },
  {
    dir: "cloud-digitalocean",
    asset: "omni-cloud-digitalocean",
    title: "DigitalOcean",
    nameZh: "DigitalOcean",
    id: "omni.cloud.digitalocean",
  },
  {
    dir: "cloud-gcp",
    asset: "omni-cloud-gcp",
    title: "Google Cloud",
    nameZh: "GCP",
    id: "omni.cloud.gcp",
  },
  {
    dir: "cloud-bandwagon",
    asset: "omni-cloud-bandwagon",
    title: "BandwagonHost",
    nameZh: "搬瓦工",
    id: "omni.cloud.bandwagon",
  },
  {
    dir: "cloud-aliyun",
    asset: "omni-cloud-aliyun",
    title: "Alibaba Cloud",
    nameZh: "阿里云",
    id: "omni.cloud.aliyun",
  },
];

function packReleaseYml(v) {
  return `name: Pack and release

on:
  push:
    tags:
      - "v*"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  pack:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout plugin
        uses: actions/checkout@v4
        with:
          path: plugin

      - name: Checkout OmniPanel (pack toolchain)
        uses: actions/checkout@v4
        with:
          repository: OmniUltraX/omnipanel
          path: omnipanel

      - name: Install Rust
        run: |
          curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
          echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"

      - name: Resolve version
        id: ver
        working-directory: plugin
        run: |
          VERSION=$(node -p "require('./plugin.json').version")
          ASSET="${v.asset}-\${VERSION}.omni-plugin"
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "asset=$ASSET" >> "$GITHUB_OUTPUT"

      - name: Stage plugin into host tree and pack
        run: |
          rm -rf omnipanel/plugins/${v.dir}
          mkdir -p omnipanel/plugins
          cp -a plugin omnipanel/plugins/${v.dir}
          mkdir -p dist
          cd omnipanel
          cargo run -q -p omnipanel-plugin-pkg --bin pack -- \\
            plugins/${v.dir} \\
            "../dist/\${{ steps.ver.outputs.asset }}"
          ls -la "../dist/\${{ steps.ver.outputs.asset }}"
          sha256sum "../dist/\${{ steps.ver.outputs.asset }}"

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: \${{ steps.ver.outputs.asset }}
          path: dist/\${{ steps.ver.outputs.asset }}

      - name: GitHub Release (on tag)
        if: startsWith(github.ref, 'refs/tags/')
        uses: softprops/action-gh-release@v2
        with:
          files: dist/\${{ steps.ver.outputs.asset }}
          body: |
            OmniPanel ${v.title} plugin \`\${{ steps.ver.outputs.version }}\`.

            Install via OmniPanel → Plugins → install local \`.omni-plugin\`,
            or wait for host \`plugins-latest\` catalog to pick up the same asset.
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
}

function readme(v) {
  return `# omni-plugin-${v.dir}

OmniPanel 可选插件：\`${v.id}\`（${v.nameZh}）。

不随 OmniPanel 客户端 bundled，需从插件中心安装并启用后，云工作台才出现该厂商。

## 安装

### 插件中心（推荐）

OmniPanel → 设置 / 插件 → 市场 → 搜索 **${v.nameZh}** → **获取** → 启用。

官方 catalog：\`distribution: download\`，制品在宿主仓库
[plugins-latest](https://github.com/OmniUltraX/omnipanel/releases/tag/plugins-latest)
（\`${v.asset}-<version>.omni-plugin\`）。

### 本地包

\`\`\`bash
cargo run -p omnipanel-plugin-pkg --bin pack -- \\
  plugins/${v.dir} \\
  ${v.asset}-0.1.0.omni-plugin
\`\`\`

## 开发

| 文件 | 说明 |
|------|------|
| \`plugin.json\` | 清单（合同事实源） |
| \`logic.js\` | L2 QuickJS 逻辑 |

宿主仓库以 git submodule 挂载于 \`plugins/${v.dir}\`。
宿主 \`scripts/plugin-download-only.mjs\` 将该目录标为 download-only。

## 发版约定

1. bump \`plugin.json\` 的 \`version\`
2. push tag \`vX.Y.Z\` → CI \`pack-release.yml\` 产出 \`.omni-plugin\` 并上传 Release
3. 宿主侧合并 submodule 指针后，触发 \`publish-plugin-registry\`

制品文件名固定：\`${v.asset}-<version>.omni-plugin\`。

## License

与 [OmniPanel](https://github.com/OmniUltraX/omnipanel) 相同。
`;
}

const only = process.argv.slice(2);
const list = only.length
  ? vendors.filter((v) => only.includes(v.dir))
  : vendors.filter((v) => v.dir !== "cloud-aliyun"); // 默认七家；阿里云阶段 C 再跑

for (const v of list) {
  const dir = path.join(pluginsDir, v.dir);
  if (!fs.existsSync(path.join(dir, "plugin.json"))) {
    console.warn(`[skip] missing ${v.dir}/plugin.json`);
    continue;
  }
  const wf = path.join(dir, ".github", "workflows");
  fs.mkdirSync(wf, { recursive: true });
  fs.writeFileSync(path.join(wf, "pack-release.yml"), packReleaseYml(v));
  fs.writeFileSync(path.join(dir, "README.md"), readme(v));
  console.log(`[ok] ${v.dir}`);
}
