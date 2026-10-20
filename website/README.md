# OmniPanel 官网

基于 Vite 的静态营销站点，可部署到 GitHub Pages。

## 本地开发

```bash
cd website
npm install
npm run dev
```

浏览器访问 `http://localhost:5173/omnipanel/`（开发模式同样使用 `/omnipanel/` 作为 base 路径）。

## 构建

```bash
npm run build
npm run preview
```

产物输出到 `website/dist/`。

## 部署到 GitHub Pages

1. 在仓库 **Settings → Pages** 中，Source 选择 **GitHub Actions**
2. 推送 `website/` 目录变更到 `master` 分支，或手动运行 **Deploy Website** workflow
3. 站点地址：`https://omnipanel.cn/`（`website/public/CNAME`，构建 base 为 `/`）

### 自定义域名

`website/public/CNAME` 内容为 `omnipanel.cn`。GitHub Actions 部署以产物里的这个文件为准，Pages 设置里手填的域名会被下一次部署覆盖。流水线已把 `GITHUB_PAGES_BASE` 设为 `/`。

### 修改 base 路径

默认 base 为 `/omnipanel/`（与 GitHub 项目页一致）。本地或 CI 可通过环境变量覆盖：

```bash
GITHUB_PAGES_BASE=/ npm run build   # 根路径部署
```

## 下载与联系

- 下载区块：`#download`（OSS `latest.json` / `versions.json`，构建时镜像到 `public/releases/`）
- 联系区块：`#contact`（企业邮箱 + 微信公众号二维码）
- 首次引导历史索引：`node scripts/bootstrap-oss-versions.mjs --out ./versions.json`

## 目录结构

```
website/
├── index.html          # 单页官网
├── src/
│   ├── main.ts         # 入口
│   ├── download.ts     # 下载区块
│   ├── releases.ts     # OSS 清单解析
│   ├── site.ts         # 公共导航 / 主题 / i18n
│   └── styles/main.css # 样式
├── public/
│   ├── .nojekyll
│   ├── logo/
│   └── examples/
└── vite.config.ts
```
